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
    bundle.hasPrefix("com.google.Chrome") || bundle.hasPrefix("local.meeting-research-assistant")
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

/** One wall-clock placement; thereafter sample count, independent of polling and upload latency. */
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

/** Calibrated on the main thread once per capture; callback delay never becomes audio placement. */
struct TapHostClock {
    let hostTime: UInt64
    let wallMs: Double
    private let msPerTick: Double
    init(hostTime: UInt64 = mach_absolute_time(), wallMs: Double = Date().timeIntervalSince1970 * 1000) {
        var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
        self.hostTime = hostTime; self.wallMs = wallMs
        msPerTick = Double(info.numer) / Double(info.denom) / 1_000_000
    }
    func wall(at host: UInt64) -> Double {
        let delta = host >= hostTime ? Double(host - hostTime) : -Double(hostTime - host)
        return wallMs + delta * msPerTick
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
    init(capacity: Int, channels: Int) {
        self.capacity = capacity; self.channels = channels
        data = .allocate(capacity: capacity * channels); data.initialize(repeating: 0, count: capacity * channels)
        widths = .allocate(capacity: channels); widths.initialize(repeating: 0, count: channels)
    }
    deinit { data.deallocate(); widths.deallocate() }
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
    private var firstHostTime: UInt64?
    init(rate: Double, channels: Int) {
        writing = TapBank(capacity: Int(rate * 2), channels: channels)
        spare = TapBank(capacity: Int(rate * 2), channels: channels)
    }
    func take() -> (bank: TapBank, host: UInt64?, failed: Bool) {
        swap(&writing, &spare); writing.count = 0; writing.buffers = 0
        return (spare, firstHostTime, failed)
    }
    func receive(_ input: UnsafePointer<AudioBufferList>, timestamp: AudioTimeStamp) {
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
        firstHostTime = firstHostTime ?? timestamp.mHostTime
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
            self.storage = storage; converter = try TapConverter(rate: rate); hostClock = TapHostClock()
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
        let samples = batch.bank.interleaved(), first = hostClock.wall(at: batch.host ?? hostClock.hostTime)
        do {
            try converter.convert(samples, channels: batch.bank.channels, final: final) { self.receive?($0, first) }
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
        stop(); self.rate = rate; storage = TapStorage(rate: rate, channels: channels); converter = try TapConverter(rate: rate); hostClock = TapHostClock()
        self.receive = receive; failed = ended
    }
    func injectForTest(_ samples: [Float], hostTime: UInt64, channels: Int = 1) {
        samples.withUnsafeBytes { bytes in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(bytes.count), mData: UnsafeMutableRawPointer(mutating: bytes.baseAddress)))
            var timestamp = AudioTimeStamp(); timestamp.mHostTime = hostTime; timestamp.mFlags = .hostTimeValid
            withUnsafePointer(to: &list) { pointer in queue.sync { storage?.receive(pointer, timestamp: timestamp) } }
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
            self.samples += signal.count; receive(signal, first)
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
