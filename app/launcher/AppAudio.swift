import Cocoa
import CoreAudio
import AVFoundation

struct AudioApp: Codable, Equatable {
    let id: String
    let name: String
}
struct AudioProcess: Equatable {
    let object: AudioObjectID
    let pid: pid_t
    let bundle: String
    let name: String
    let running: Bool
    let excluded: Bool
    var eligible: Bool { !excluded && !bundle.isEmpty && !excludedAudioBundle(bundle) }
}
struct AudioAppOwner {
    let app: AudioApp
    let excluded: Bool
}
private func excludedAudioBundle(_ bundle: String) -> Bool {
    bundle.hasPrefix("io.github.zihao-qi.hearalong") || bundle.hasPrefix("local.meeting-research-assistant")
}

/** Keep the HAL object/pid, but attribute shared XPC helpers to their responsible app. Never undo an exclusion. */
func attributeAudioProcess(_ process: AudioProcess, responsibleApp: AudioAppOwner?) -> AudioProcess {
    guard let owner = responsibleApp, !owner.app.id.isEmpty else { return process }
    return AudioProcess(object: process.object, pid: process.pid, bundle: owner.app.id, name: owner.app.name, running: process.running,
                        excluded: process.excluded || excludedAudioBundle(process.bundle) || owner.excluded || excludedAudioBundle(owner.app.id))
}
/** The same selection is used by Start, process-change monitoring and the no-tap regression checks. */
func audioProcesses(for app: AudioApp, in processes: [AudioProcess]) -> [AudioProcess] {
    processes.filter { $0.eligible && $0.bundle == app.id }
}

// libSystem SPI, not a public SDK API. Responsibility follows XPC clients, unlike parent pid (usually launchd).
// Resolve optionally so an OS without the SPI retains the bundle/path fallback rather than failing to launch.
private let responsibleAudioPID: (@convention(c) (pid_t) -> pid_t)? = {
    guard let library = dlopen("/usr/lib/libSystem.B.dylib", RTLD_LAZY) else { return nil }
    defer { dlclose(library) }
    guard let symbol = dlsym(library, "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(symbol, to: (@convention(c) (pid_t) -> pid_t).self)
}()

/** HAL discovery is separate from grouping so the same rules are exercised without touching Core Audio. */
func groupAudioApps(_ processes: [AudioProcess]) -> [AudioApp] {
    var names: [String: String] = [:]
    for p in processes where p.running && p.eligible {
        names[p.bundle] = p.name
    }
    return names.map { AudioApp(id: $0.key, name: String($0.value.prefix(120))) }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}

/** Recording X-Start-Ms only: one placement, then compact sample count. Capture wall headers
 * come from TimedMonoFramer, never from this clock, and can re-anchor after sleep/pauses.
 */
struct AppTimeline {
    let clockStart: Double
    let firstWallMs: Double
    func startMs(samples: Int) -> Double { max(0, firstWallMs - clockStart) + Double(samples) * 1000 / 16000 }
}

protocol AppAudioInput: AnyObject {
    var available: Bool { get }
    func apps() throws -> [AudioApp]
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws
    func stop()
}

func halAddress(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func halCheck(_ status: OSStatus) throws {
    if status != noErr { throw ProbeError.message("Core Audio could not capture the call (\(status)).") }
}
func halScalar<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, initial: T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> T {
    var address = halAddress(selector, scope: scope), size = UInt32(MemoryLayout<T>.size)
    var value = initial
    try withUnsafeMutableBytes(of: &value) { try halCheck(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!)) }
    return value
}
func halString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = halAddress(selector), size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var value: Unmanaged<CFString>?
    try halCheck(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value))
    return value?.takeRetainedValue() as String? ?? ""
}

/** Framing-thread epoch history, never mutated in IO. A delayed pre-sleep input uses
 * its capture epoch, not the sleep/UTC offset at delivery. Recalibration follows UTC changes.
 */
struct TapHostClock {
    private struct Epoch { let host: UInt64; let continuous: UInt64; let wall: Double }
    private var epochs: [Epoch]
    private var calibrated: UInt64
    private let msPerTick: Double
    init(hostTime: UInt64 = mach_absolute_time(), wallMs: Double = Date().timeIntervalSince1970 * 1000, continuousTime: UInt64 = mach_continuous_time()) {
        var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
        msPerTick = Double(info.numer) / Double(info.denom) / 1_000_000
        epochs = [Epoch(host: hostTime, continuous: continuousTime, wall: wallMs)]; calibrated = continuousTime
    }
    private func difference(_ a: UInt64, _ b: UInt64) -> Double { a >= b ? Double(a - b) : -Double(b - a) }
    private func epoch(at host: UInt64) -> Epoch { epochs.last(where: { $0.host <= host }) ?? epochs[0] }
    private mutating func remember(_ epoch: Epoch) {
        epochs.removeAll { $0.host == epoch.host }; epochs.append(epoch); epochs.sort { $0.host < $1.host }
        if epochs.count > 128 { epochs.removeFirst(epochs.count - 128) }
    }
    mutating func recalibrate(host: UInt64 = mach_absolute_time(), continuous: UInt64 = mach_continuous_time(), wallMs: Double = Date().timeIntervalSince1970 * 1000) {
        guard difference(continuous, calibrated) * msPerTick >= 1000 else { return }
        remember(Epoch(host: host, continuous: continuous, wall: wallMs)); calibrated = continuous
    }
    mutating func wall(at host: UInt64, observedHost: UInt64, continuous: UInt64) -> Double {
        let observed = epoch(at: observedHost)
        let sleep = (difference(continuous, observed.continuous) - difference(observedHost, observed.host)) * msPerTick
        if abs(sleep) > 2 {
            remember(Epoch(host: observedHost, continuous: continuous, wall: observed.wall + difference(continuous, observed.continuous) * msPerTick))
        }
        let capture = epoch(at: host)
        return capture.wall + difference(host, capture.host) * msPerTick
    }
}

/** Converter priming delays delivery, not the source sample's timestamp. Retain per-callback
 * placements until their corresponding resampled output is delivered, splitting across gaps.
 */
final class TapSampleTimeline {
    private var inputFrames = 0
    private var outputSamples = 0
    private var placements: [(sample: Int, wallMs: Double)] = []
    func note(frames: Int, rate: Double, wallMs: Double) {
        placements.append((Int((Double(inputFrames) * 16000 / rate).rounded()), wallMs)); inputFrames += frames
    }
    func deliver(_ samples: [Float], receive: ([Float], Double) -> Void) {
        var offset = 0
        while offset < samples.count {
            while placements.count > 1 && placements[1].sample <= outputSamples { placements.removeFirst() }
            guard let first = placements.first else { return }
            let next = placements.count > 1 ? placements[1].sample : Int.max
            let count = min(samples.count - offset, next - outputSamples)
            receive(Array(samples[offset..<offset + count]), first.wallMs + Double(outputSamples - first.sample) / 16)
            offset += count; outputSamples += count
        }
    }
}

/** Two preallocated banks: IO memcpy only; main takes ownership with a constant-time swap. */
private final class TapBank {
    let data: UnsafeMutablePointer<Float>
    let widths: UnsafeMutablePointer<Int>
    let capacity: Int
    let channels: Int
    var count = 0
    var buffers = 0
    let stampCapacity = 8192
    let offsets: UnsafeMutablePointer<Int>
    let hosts: UnsafeMutablePointer<UInt64>
    let observedHosts: UnsafeMutablePointer<UInt64>
    let continuousTimes: UnsafeMutablePointer<UInt64>
    var stampCount = 0
    init(capacity: Int, channels: Int) {
        self.capacity = capacity; self.channels = channels
        data = .allocate(capacity: capacity * channels); data.initialize(repeating: 0, count: capacity * channels)
        widths = .allocate(capacity: channels); widths.initialize(repeating: 0, count: channels)
        offsets = .allocate(capacity: stampCapacity); hosts = .allocate(capacity: stampCapacity)
        observedHosts = .allocate(capacity: stampCapacity); continuousTimes = .allocate(capacity: stampCapacity)
    }
    deinit { data.deallocate(); widths.deallocate(); offsets.deallocate(); hosts.deallocate(); observedHosts.deallocate(); continuousTimes.deallocate() }
    // Called only after the bank is detached from IO, never under queue.sync.
    func interleaved() -> [Float] {
        var samples = [Float](repeating: 0, count: count * channels), offset = 0
        for buffer in 0..<buffers {
            let width = widths[buffer]
            for frame in 0..<count { for channel in 0..<width { samples[frame * channels + offset + channel] = data[offset * capacity + frame * width + channel] } }
            offset += width
        }
        return samples
    }
}
private final class TapStorage {
    private var writing: TapBank
    private var spare: TapBank
    private var failed = false
    init(rate: Double, channels: Int) {
        writing = TapBank(capacity: Int(rate * 2), channels: channels)
        spare = TapBank(capacity: Int(rate * 2), channels: channels)
    }
    func take() -> (bank: TapBank, failed: Bool) {
        swap(&writing, &spare); writing.count = 0; writing.buffers = 0; writing.stampCount = 0
        return (spare, failed)
    }
    func receive(_ input: UnsafePointer<AudioBufferList>, timestamp: AudioTimeStamp, observedHost: UInt64 = mach_absolute_time(), continuous: UInt64 = mach_continuous_time()) {
        guard !failed else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input)), bank = writing
        var width = 0, frames: Int?
        guard timestamp.mFlags.contains(.hostTimeValid), timestamp.mHostTime > 0, buffers.count <= bank.channels else { failed = true; return }
        for (index, buffer) in buffers.enumerated() {
            let n = Int(buffer.mNumberChannels)
            guard n > 0, buffer.mData != nil, Int(buffer.mDataByteSize) % (4 * n) == 0 else { failed = true; return }
            let f = Int(buffer.mDataByteSize) / (4 * n)
            if let old = frames, old != f { failed = true; return }
            if bank.count > 0 && (bank.buffers != buffers.count || bank.widths[index] != n) { failed = true; return }
            frames = f; width += n
        }
        guard width == bank.channels, let frames, frames <= bank.capacity - bank.count else { failed = true; return }
        guard frames > 0 else { return }
        guard bank.stampCount < bank.stampCapacity else { failed = true; return }
        let stamp = bank.stampCount
        bank.offsets[stamp] = bank.count; bank.hosts[stamp] = timestamp.mHostTime
        bank.observedHosts[stamp] = observedHost; bank.continuousTimes[stamp] = continuous; bank.stampCount += 1
        var offset = 0
        for (index, buffer) in buffers.enumerated() {
            let n = Int(buffer.mNumberChannels)
            memcpy(bank.data + offset * bank.capacity + bank.count * n, buffer.mData!, Int(buffer.mDataByteSize))
            bank.widths[index] = n; offset += n
        }
        bank.buffers = buffers.count; bank.count += frames
    }
}

/** Stop owns teardown, but only after the converter's current stack has completely unwound. */
final class TapDrainGate {
    private var active = false
    private var again: (() -> Void)?
    private var stopping: (() -> Void)?
    private var tearingDown = false
    private func finish(_ work: () -> Void) { tearingDown = true; work(); tearingDown = false }
    func drain(_ work: @escaping () -> Void) {
        if active { again = work; return }
        active = true; work(); active = false
        if let stop = stopping { stopping = nil; again = nil; finish(stop) }
        else if let next = again { again = nil; drain(next) }
    }
    func stop(_ work: @escaping () -> Void) {
        guard !tearingDown else { return }
        if active { if stopping == nil { stopping = work } }
        else { finish(work) }
    }
}

/** A continuous converter: no per-second reset/priming, and no dropped fractional sample at frame boundaries. */
final class TapConverter {
    let converter: AVAudioConverter
    let input: AVAudioPCMBuffer
    let output: AVAudioPCMBuffer
    init(rate: Double) throws {
        let from = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let to = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        guard let c = AVAudioConverter(from: from, to: to), let i = AVAudioPCMBuffer(pcmFormat: from, frameCapacity: 4096), let o = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: 4096) else { throw ProbeError.message("Could not convert call audio.") }
        converter = c; input = i; output = o
        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        converter.primeMethod = .normal
    }
    func convert(_ samples: [Float], channels: Int, final: Bool, receive: ([Float]) -> Void) throws {
        var position = 0
        while true {
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { requested, state in
                guard position < samples.count / channels else { state.pointee = final ? .endOfStream : .noDataNow; return nil }
                let count = min(Int(requested), 4096, samples.count / channels - position)
                self.input.frameLength = AVAudioFrameCount(count)
                for frame in 0..<count {
                    var sum: Float = 0
                    for channel in 0..<channels { sum += samples[(position + frame) * channels + channel] }
                    self.input.floatChannelData![0][frame] = sum / Float(channels)
                }
                position += count; state.pointee = .haveData; return self.input
            }
            if status == .error { throw error ?? ProbeError.message("Call audio conversion failed.") }
            if output.frameLength > 0 { receive(Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))) }
            if status == .inputRanDry || status == .endOfStream { break }
        }
    }
}

@available(macOS 14.4, *)
final class CoreAudioInput: AppAudioInput {
    var available: Bool { true }
    private let serverGroup: pid_t
    private let queue = DispatchQueue(label: "local.hearalong.app-audio.io", qos: .userInitiated)
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var storage: TapStorage?
    private var converter: TapConverter?
    private var timer: Timer?
    private var receive: (([Float], Double) -> Void)?
    private var target: AudioApp?
    private var failed: ((String) -> Void)?
    private var drainError: String?
    private var rate = 16000.0
    private var hostClock = TapHostClock()
    private var sampleTimeline = TapSampleTimeline()
    private let drainGate = TapDrainGate()
    private var lastProcessCheck = Date.distantPast
    private var processSet = Set<AudioObjectID>()
    private let log: (String) -> Void
    init(serverGroup: pid_t, log: @escaping (String) -> Void) { self.serverGroup = serverGroup; self.log = log }
    private func excludedPID(_ pid: pid_t) -> Bool {
        pid == getpid() || (serverGroup > 0 && getpgid(pid) == serverGroup)
    }
    /** Only a real outer .app is an owner; an XPC service's own bundle is not its client app. */
    private func appOwner(_ pid: pid_t) -> AudioAppOwner? {
        let app = NSRunningApplication(processIdentifier: pid)
        var executablePath = [CChar](repeating: 0, count: 4096)
        let pathSize = proc_pidpath(pid, &executablePath, UInt32(executablePath.count))
        let executable = pathSize > 0 ? URL(fileURLWithPath: String(cString: executablePath)) : nil
        guard let url = app?.bundleURL ?? app?.executableURL ?? executable else { return nil }
        var path = URL(fileURLWithPath: "/"), outer: URL?
        for component in url.pathComponents.dropFirst() {
            path.appendPathComponent(component)
            if component.hasSuffix(".app") { outer = path; break }
        }
        guard let outer, let bundle = Bundle(url: outer), let id = bundle.bundleIdentifier, !id.isEmpty else { return nil }
        let main = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == id }
        let name = main?.localizedName ?? (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? app?.localizedName ?? id
        return AudioAppOwner(app: AudioApp(id: id, name: name), excluded: excludedPID(pid) || excludedAudioBundle(id))
    }
    private func processes() throws -> [AudioProcess] {
        var address = halAddress(kAudioHardwarePropertyProcessObjectList), size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        try halCheck(AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size))
        guard size > 0 else { return [] }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        try objects.withUnsafeMutableBytes { try halCheck(AudioObjectGetPropertyData(system, &address, 0, nil, &size, $0.baseAddress!)) }
        return objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size).compactMap { object in
            guard let pid = try? halScalar(object, kAudioProcessPropertyPID, initial: pid_t(0)), pid > 0 else { return nil }
            let app = NSRunningApplication(processIdentifier: pid)
            let bundle = (try? halString(object, kAudioProcessPropertyBundleID)) ?? app?.bundleIdentifier ?? ""
            // Preserve the original outer-app/path fallback when responsibility is unavailable or has no app.
            let fallback = appOwner(pid)
            let running = ((try? halScalar(object, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0))) ?? 0) != 0
            let process = AudioProcess(object: object, pid: pid, bundle: bundle.isEmpty ? "" : fallback?.app.id ?? bundle,
                                       name: fallback?.app.name ?? app?.localizedName ?? bundle, running: running,
                                       excluded: excludedPID(pid) || excludedAudioBundle(bundle) || (fallback?.excluded ?? false))
            let responsible = responsibleAudioPID?(pid) ?? 0
            let owner = responsible > 0 && responsible != pid ? appOwner(responsible) : nil
            return attributeAudioProcess(process, responsibleApp: owner)
        }
    }
    func apps() throws -> [AudioApp] { groupAudioApps(try processes()) }
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws {
        stop()
        let all = try processes()
        guard groupAudioApps(all).contains(where: { $0.id == app.id }) else { throw ProbeError.message("\(app.name) is no longer playing sound.") }
        let objects = audioProcesses(for: app, in: all).map(\.object)
        processSet = Set(objects); lastProcessCheck = Date()
        do {
            let description = CATapDescription(stereoMixdownOfProcesses: objects)
            description.name = "HearAlong chosen call"; description.uuid = UUID(); description.isPrivate = true; description.muteBehavior = .unmuted
            try halCheck(AudioHardwareCreateProcessTap(description, &tap))
            let uid = try halString(tap, kAudioTapPropertyUID)
            let composition: [String: Any] = [kAudioAggregateDeviceNameKey: "HearAlong private call", kAudioAggregateDeviceUIDKey: "local.hearalong.call.\(UUID().uuidString)", kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceTapAutoStartKey: false, kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: uid, kAudioSubTapDriftCompensationKey: true]]]
            try halCheck(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate))
            let format = try halScalar(aggregate, kAudioDevicePropertyStreamFormat, initial: AudioStreamBasicDescription(), scope: kAudioObjectPropertyScopeInput)
            let channels = Int(format.mChannelsPerFrame)
            let tapFormat = try halScalar(tap, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
            let nonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
            guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0, format.mBitsPerChannel == 32, (1...8).contains(channels), (8000...192000).contains(format.mSampleRate), format.mBytesPerFrame == UInt32(4 * (nonInterleaved ? 1 : channels)), format.mSampleRate == tapFormat.mSampleRate, format.mChannelsPerFrame == tapFormat.mChannelsPerFrame else { throw ProbeError.message("Unsupported call audio format.") }
            rate = format.mSampleRate
            let storage = TapStorage(rate: rate, channels: channels), rate = rate
            self.storage = storage; converter = try TapConverter(rate: rate); hostClock = TapHostClock(); sampleTimeline = TapSampleTimeline()
            self.receive = receive; failed = ended; target = app
            try halCheck(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { _, input, timestamp, _, _ in storage.receive(input, timestamp: timestamp.pointee) })
            guard let ioProc else { throw ProbeError.message("Could not start call audio.") }
            try halCheck(AudioDeviceStart(aggregate, ioProc))
            let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.drain() }
            RunLoop.main.add(timer, forMode: .common); self.timer = timer
        } catch { stop(); throw error }
    }
    private func drain(final: Bool = false) { drainGate.drain { self.drainNow(final: final) } }
    private func drainNow(final: Bool) {
        guard let storage, let converter else { return }
        let batch = queue.sync { storage.take() }
        hostClock.recalibrate() // Date/UTC reads and epoch bookkeeping stay outside the IO callback.
        let bank = batch.bank, samples = bank.interleaved()
        do {
            for stamp in 0..<bank.stampCount {
                let first = bank.offsets[stamp], end = stamp + 1 < bank.stampCount ? bank.offsets[stamp + 1] : bank.count
                let wall = hostClock.wall(at: bank.hosts[stamp], observedHost: bank.observedHosts[stamp], continuous: bank.continuousTimes[stamp])
                sampleTimeline.note(frames: end - first, rate: rate, wallMs: wall)
                let part = Array(samples[first * bank.channels..<end * bank.channels])
                try converter.convert(part, channels: bank.channels, final: false) { self.sampleTimeline.deliver($0) { self.receive?($0, $1) } }
            }
            if final { try converter.convert([], channels: bank.channels, final: true) { self.sampleTimeline.deliver($0) { self.receive?($0, $1) } } }
            if batch.failed { throw ProbeError.message("Call audio processing fell behind; this source stopped.") }
            if !final, let target, Date().timeIntervalSince(lastProcessCheck) >= 2 {
                lastProcessCheck = Date()
                let current = audioProcesses(for: target, in: try processes())
                if !current.contains(where: { $0.running }) { throw ProbeError.message("\(target.name) closed; the microphone keeps recording.") }
                let objects = Set(current.map(\.object))
                if objects != processSet {
                    log("\(target.name): audio process set changed (\(processSet.count) → \(objects.count)); capture keeps its original processes until the next Start.")
                    processSet = objects
                }
            }
        } catch {
            drainError = drainError ?? String(describing: error)
            if !final { stop() }
        }
    }
    func stop() { drainGate.stop { self.stopNow() } }
    private func stopNow() {
        timer?.invalidate(); timer = nil
        if let ioProc {
            AudioDeviceStop(aggregate, ioProc)
            AudioDeviceDestroyIOProcID(aggregate, ioProc)
            self.ioProc = nil
        }
        queue.sync {}
        drain(final: true)
        let callback = failed, message = drainError
        receive = nil; failed = nil; drainError = nil; converter = nil; storage = nil; target = nil
        if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate); aggregate = AudioObjectID(kAudioObjectUnknown) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = AudioObjectID(kAudioObjectUnknown) }
        if let message { callback?(message) }
    }
#if APP_AUDIO_TESTING
    // Exercise the production drain/converter without discovering devices or creating any HAL object.
    func prepareForTest(rate: Double = 16000, channels: Int = 1, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws {
        stop(); self.rate = rate; storage = TapStorage(rate: rate, channels: channels); converter = try TapConverter(rate: rate); hostClock = TapHostClock(); sampleTimeline = TapSampleTimeline()
        self.receive = receive; failed = ended
    }
    func injectForTest(_ samples: [Float], hostTime: UInt64, channels: Int = 1, observedHost: UInt64? = nil, continuous: UInt64? = nil) {
        samples.withUnsafeBytes { bytes in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(bytes.count), mData: UnsafeMutableRawPointer(mutating: bytes.baseAddress)))
            var timestamp = AudioTimeStamp(); timestamp.mHostTime = hostTime; timestamp.mFlags = .hostTimeValid
            withUnsafePointer(to: &list) { pointer in queue.sync { storage?.receive(pointer, timestamp: timestamp, observedHost: observedHost ?? mach_absolute_time(), continuous: continuous ?? mach_continuous_time()) } }
        }
    }
    func drainForTest() { drain() }
#endif
    deinit { stop() }
}

final class UnavailableAudioInput: AppAudioInput {
    var available: Bool { false }
    func apps() throws -> [AudioApp] { [] }
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws { throw ProbeError.message("App audio needs macOS 14.4 or later.") }
    func stop() {}
}

#if APP_AUDIO_TESTING
/** Not compiled into production helpers. The environment switch alone can never turn on fake audio there. */
final class FakeAudioInput: AppAudioInput {
    var available: Bool { true }
    private var timer: Timer?
    private var samples = 0
    func apps() throws -> [AudioApp] {
        if mode() == "empty" { return [] }
        return [AudioApp(id: "test.fictional.meet", name: "Fictional Meet"), AudioApp(id: "test.fictional.call", name: "Fictional Call")]
    }
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws {
        stop(); samples = 0
        if mode() == "start-error" { throw ProbeError.message("Fictional tap creation failed.") }
        let first = Date().timeIntervalSince1970 * 1000
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            let quit = ProcessInfo.processInfo.environment["HEARALONG_FAKE_QUIT_FILE"]
            if (quit.map { FileManager.default.fileExists(atPath: $0) } ?? false) || self.mode() == "quit" { self.stop(); ended("Fictional Meet closed; the microphone keeps recording."); return }
            let silent = self.mode() == "silent"
            let signal = (0..<1600).map { silent ? Float(0) : Float(sin(Double(self.samples + $0) * 2 * .pi * 440 / 16000) * 0.1) }
            let wall = first + Double(self.samples) / 16
            self.samples += signal.count; receive(signal, wall)
        }
        RunLoop.main.add(timer, forMode: .common); self.timer = timer
    }
    private func mode() -> String {
        guard let path = ProcessInfo.processInfo.environment["HEARALONG_FAKE_APP_CONTROL"] else { return "" }
        return (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    }
    func stop() { timer?.invalidate(); timer = nil }
}
#endif

func makeAppAudioInput(serverGroup: pid_t, log: @escaping (String) -> Void = { _ in }) -> AppAudioInput {
#if APP_AUDIO_TESTING
    if ProcessInfo.processInfo.environment["HEARALONG_FAKE_APP_AUDIO"] == "1" { return FakeAudioInput() }
#endif
    if #available(macOS 14.4, *) { return CoreAudioInput(serverGroup: serverGroup, log: log) }
    return UnavailableAudioInput()
}
