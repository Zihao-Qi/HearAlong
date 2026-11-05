import Cocoa
import AVFoundation

private final class StuckUpload: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {} // Keep the first upload outstanding while synthetic samples fill the queue.
    override func stopLoading() {}
}
private final class ConvertingInput: AppAudioInput {
    let converter = try! TapConverter(rate: 16000)
    var available: Bool { true }
    var receive: (([Float], Double) -> Void)?
    var converting = false
    var reentered = false
    var stopped = false
    func apps() throws -> [AudioApp] { [] }
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws { self.receive = receive }
    func feed() throws {
        converting = true
        defer { converting = false }
        try converter.convert([Float](repeating: 0.1, count: 33 * 16000), channels: 1, final: false) { self.receive?($0, 1_800_000_000_000) }
    }
    func stop() {
        stopped = true
        if converting { reentered = true; return } // Detect the old nested call without deliberately crashing AVAudioConverter.
        try! converter.convert([], channels: 1, final: true) { self.receive?($0, 1_800_000_000_000) }
    }
}
private final class ClockUpload: URLProtocol {
    static let lock = NSLock()
    static var saved: [[String: String]] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url!.path.hasSuffix("/pcm") {
            let keys = ["X-Capture-Wall-Ms", "X-Capture-Discontinuities", "X-Start-Ms", "X-Sequence"]
            let headers = Dictionary(uniqueKeysWithValues: keys.map { ($0, request.value(forHTTPHeaderField: $0) ?? "") })
            Self.lock.lock(); Self.saved.append(headers); Self.lock.unlock()
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func frames() -> [[String: String]] { lock.lock(); defer { lock.unlock() }; return saved }
}
private final class TimedTestInput: AppAudioInput {
    var available: Bool { true }
    var receive: (([Float], Double) -> Void)?
    func apps() throws -> [AudioApp] { [] }
    func start(app: AudioApp, receive: @escaping ([Float], Double) -> Void, ended: @escaping (String) -> Void) throws { self.receive = receive }
    func stop() {}
}

@main struct TapRegressionTests {
    static func require(_ value: @autoclosure () -> Bool, _ text: String) throws { if !value() { throw ProbeError.message(text) } }
    static func main() {
        do { try run() } catch { print("FAIL \(error)"); exit(1) }
    }
    static func run() throws {
        let which = CommandLine.arguments[1]
        if which == "client-clock" {
            let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ClockUpload.self]
            let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
            let input = TimedTestInput()
            let client = AppCaptureClient(base: URL(string: "http://127.0.0.1:1")!, origin: "http://127.0.0.1:1", input: input, session: session)
            client.poll(["appCapture": ["app": ["id": "test.fictional", "name": "Fictional Call"], "meetingId": UUID().uuidString, "recordingId": UUID().uuidString, "source": "app:\(UUID().uuidString)", "pageId": "page", "clockStart": 98000.0, "stopping": false]])
            input.receive?([Float](repeating: 0.1, count: 8000), 100000)
            input.receive?([Float](repeating: 0.2, count: 8000), 110500) // 10 s sleep inside a frame.
            input.receive?([Float](repeating: 0.3, count: 16000), 111000)
            var stopped = false; client.stop(completion: { stopped = true })
            let deadline = Date().addingTimeInterval(3)
            while !stopped && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
            let frames = ClockUpload.frames()
            try require(stopped && frames.count == 2, "fake-only client must drain both frames and Stop")
            try require(Double(frames[0]["X-Capture-Wall-Ms"]!) == 100000 && Double(frames[1]["X-Capture-Wall-Ms"]!) == 111000, "capture wall must re-anchor after sleep, not firstWall + counted samples")
            try require(Double(frames[0]["X-Start-Ms"]!) == 2000 && Double(frames[1]["X-Start-Ms"]!) == 3000, "recording sample clock remains compact and unchanged")
            let gaps = try JSONSerialization.jsonObject(with: Data(frames[0]["X-Capture-Discontinuities"]!.utf8)) as! [[String: Any]]
            try require(gaps.count == 1 && gaps[0]["offsetSamples"] as? Int == 8000 && gaps[0]["fromWallMs"] as? Double == 100500 && gaps[0]["toWallMs"] as? Double == 110500, "long in-frame gaps must be sent at the original sample offset")
            print("PASS native upload clock: real span wall times, in-frame discontinuity, unchanged Start/sequence, fake URLSession only")
        } else if which == "sleep-clock" {
            var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
            let second = UInt64(1_000_000_000.0 * Double(info.denom) / Double(info.numer))
            var clock = TapHostClock(hostTime: second * 100, wallMs: 100000, continuousTime: second * 200)
            let pre = clock.wall(at: second * 100 + second / 2, observedHost: second * 100 + second * 510 / 1000, continuous: second * 200 + second * 510 / 1000)
            let wake = clock.wall(at: second * 100 + second * 520 / 1000, observedHost: second * 100 + second * 530 / 1000, continuous: second * 210 + second * 530 / 1000)
            let next = clock.wall(at: second * 100 + second * 530 / 1000, observedHost: second * 100 + second * 540 / 1000, continuous: second * 210 + second * 540 / 1000)
            let queued = clock.wall(at: second * 100 + second / 2, observedHost: second * 100 + second * 550 / 1000, continuous: second * 210 + second * 550 / 1000)
            try require(abs(pre - 100500) < 0.001 && abs(queued - pre) < 0.001, "known pre-sleep input delivered after wake still uses its capture epoch")
            try require(abs(wake - 110520) < 0.001 && abs(next - 110530) < 0.001, "FIRST post-wake input precedes callback observation by 10 ms; sleep must not be misplaced onto second buffer")
            clock.recalibrate(host: second * 104, continuous: second * 214, wallMs: 144000)
            let stepped = clock.wall(at: second * 104, observedHost: second * 104, continuous: second * 214)
            try require(abs(stepped - 144000) < 0.001, "periodic framing-thread recalibration follows a +30 s UTC step")
            let old = clock.wall(at: second * 100 + second / 2, observedHost: second * 104, continuous: second * 214)
            try require(abs(old - 100500) < 0.001, "old capture remains on old epoch even after UTC recalibration")
            print("PASS native epoch clock: queued pre-sleep sample unshifted; post-wake sleep and +30 s UTC adjustment mapped independently")
        } else if which == "short-pauses" {
            for pause in [150.0, 2000, 3000, 5000, 10000, -30000] {
                var frames: [TimedMonoFrame] = []; let framer = TimedMonoFramer { frames.append($0) }
                framer.append([Float](repeating: 0.1, count: 3200), wallMs: 100000)
                framer.append([Float](repeating: 0.2, count: 12800), wallMs: 100200 + pause)
                framer.append([Float](repeating: 0.3, count: 16000), wallMs: 101000 + pause + 2500)
                try require(frames.count == 2 && frames[0].discontinuities.count == 1, "all in-frame steps over slew bound need metadata")
                let cut = frames[0].discontinuities[0]
                try require(cut.offsetSamples == 3200 && cut.fromWallMs == 100200 && cut.toWallMs == 100200 + pause, "short/signed pause retains exact sample-offset wall placement")
                try require(frames[1].wallMs == 103500 + pause, "next frame placement reflects both short pauses without a false 5500 ms hole")
            }
            var frames: [TimedMonoFrame] = []; let framer = TimedMonoFramer { frames.append($0) }
            framer.append([Float](repeating: 0.1, count: 4000), wallMs: 100000)
            framer.append([Float](repeating: 0.2, count: 4000), wallMs: 102250)
            framer.append([Float](repeating: 0.3, count: 8000), wallMs: 112500)
            try require(frames[0].discontinuities.map(\.toWallMs) == [102250, 112500], "2 s pause before 10 s sleep records both cuts, not a span 2000 ms early")
            print("PASS native short/signed steps: 150 ms..5 s metadata, exact 112500 post-sleep anchor, no PCM padding")
        } else if which == "utc-clock" {
            var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
            let second = UInt64(1_000_000_000.0 * Double(info.denom) / Double(info.numer))
            var clock = TapHostClock(hostTime: second * 100, wallMs: 100000, continuousTime: second * 200)
            var frames: [TimedMonoFrame] = []; let framer = TimedMonoFramer { frames.append($0) }
            framer.append([Float](repeating: 0.1, count: 8000), wallMs: clock.wall(at: second * 100 + second / 2, observedHost: second * 100 + second / 2, continuous: second * 200 + second / 2))
            clock.recalibrate(host: second * 101, continuous: second * 201, wallMs: 131000)
            framer.append([Float](repeating: 0.2, count: 8000), wallMs: clock.wall(at: second * 101, observedHost: second * 101, continuous: second * 201))
            try require(frames.count == 1 && frames[0].discontinuities.count == 1, "wall-clock adjustment inside a frame is explicit")
            try require(frames[0].discontinuities[0].fromWallMs == 101000 && frames[0].discontinuities[0].toWallMs == 131000, "+30 s UTC step creates exact metadata, not a permanently offset call")
            for n in 2...200 {
                clock.recalibrate(host: second * UInt64(100 + n), continuous: second * UInt64(200 + n), wallMs: 130000 + Double(n) * 1000)
                let placed = clock.wall(at: second * UInt64(100 + n), observedHost: second * UInt64(100 + n), continuous: second * UInt64(200 + n))
                try require(abs(placed - (130000 + Double(n) * 1000)) < 0.001, "bounded epoch history tracks current wall for long capture")
            }
            print("PASS periodic native UTC recalibration: +30 s mid-frame discontinuity, bounded history stays current")
        } else if which == "backlog" {
            let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StuckUpload.self]
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            let input = ConvertingInput()
            let client = AppCaptureClient(base: URL(string: "http://127.0.0.1:1")!, origin: "http://127.0.0.1:1", input: input, session: session)
            client.poll(["appCapture": ["app": ["id": "test.fictional", "name": "Fictional Meet"], "meetingId": UUID().uuidString, "recordingId": UUID().uuidString, "source": "app:\(UUID().uuidString)", "pageId": "page", "clockStart": 1_800_000_000_000.0, "stopping": false]])
            try input.feed()
            try require(!input.reentered, "backlog Stop must not run on the converter receive stack")
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            try require(input.stopped, "backlog must schedule Stop on the next main turn")
            print("PASS stuck upload + real converter: Stop deferred until conversion returns")
        } else if which == "gate" {
            let gate = TapDrainGate()
            var events: [String] = []
            gate.drain {
                events.append("convert")
                gate.stop { events.append("stop"); gate.stop { events.append("duplicate stop") } }
                gate.drain { events.append("duplicate drain") }
                events.append("returned")
            }
            try require(events == ["convert", "returned", "stop"], "drain gate defers teardown and coalesces nested stop/drain")
            print("PASS production drain gate: teardown after conversion, no recursive final drain")
        } else if #available(macOS 14.4, *) {
            let input = CoreAudioInput(serverGroup: 0, log: { _ in })
            if which == "callback-gaps" {
                var frames: [TimedMonoFrame] = []
                let framer = TimedMonoFramer { frames.append($0) }
                try input.prepareForTest(receive: { samples, wall in framer.append(samples, wallMs: wall) }, ended: { _ in })
                var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
                let second = UInt64(1_000_000_000.0 * Double(info.denom) / Double(info.numer))
                let host = mach_absolute_time(), continuous = mach_continuous_time()
                input.injectForTest([Float](repeating: 0.1, count: 4000), hostTime: host, observedHost: host, continuous: continuous)
                input.injectForTest([Float](repeating: 0.2, count: 4000), hostTime: host + second / 4, observedHost: host + second / 4, continuous: continuous + second * 10 + second / 4)
                input.drainForTest(); input.stop(); framer.flush()
                try require(frames.count == 1 && frames[0].samples.count == 8000, "converter and final drain retain every sample across a sleep")
                try require(frames[0].discontinuities.count == 1 && frames[0].discontinuities[0].offsetSamples == 4000, "callback stamps within the same bank must not be flattened")
                try require(abs(frames[0].discontinuities[0].toWallMs - frames[0].discontinuities[0].fromWallMs - 10000) < 1, "same-bank host timestamp gap survives conversion")
                print("PASS timestamped tap banks/converter: synthetic 10 s sleep, all 8000 samples and gap preserved")
                return
            }
            if which == "overrun-live" {
                var received = 0, atEnd = 0
                try input.prepareForTest(rate: 48000, receive: { samples, _ in received += samples.count }, ended: { _ in atEnd = received })
                input.injectForTest([Float](repeating: 0.1, count: 12000), hostTime: mach_absolute_time())
                input.injectForTest([Float](repeating: 0.1, count: 100000), hostTime: mach_absolute_time())
                input.drainForTest()
                try require(received == 4000 && atEnd == 4000, "live overrun must flush converter tail before reporting end to the client")
                print("PASS live overrun: 48 kHz conversion fully flushed before the failure callback")
                return
            }
            if which == "banks" {
                var result: [Float] = []
                try input.prepareForTest(channels: 2, receive: { samples, _ in result.append(contentsOf: samples) }, ended: { _ in })
                for n in 0..<3 {
                    let value = Float(n + 1) * 0.1
                    let stereo = (0..<4000).flatMap { _ in [value, value + 0.2] }
                    input.injectForTest(stereo, hostTime: mach_absolute_time(), channels: 2)
                    input.drainForTest()
                }
                input.stop()
                try require(result.count == 12000, "swapped banks preserve all three captured ranges")
                for n in 0..<3 { try require(abs(result[n * 4000 + 100] - Float(n + 2) * 0.1) < 0.00001, "swapped-bank channel layout and downmix") }
                print("PASS preallocated bank swap: both banks reused, stereo samples preserved outside IO critical section")
                return
            }
            var delivered = 0, first: Double?, error: String?
            try input.prepareForTest(receive: { delivered += $0.count; first = first ?? $1 }, ended: { error = $0 })
            let host = mach_absolute_time()
            var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
            let second = UInt64(1_000_000_000.0 * Double(info.denom) / Double(info.numer))
            let expected = Date().timeIntervalSince1970 * 1000 - 2000
            input.injectForTest([Float](repeating: 0.1, count: 4000), hostTime: host - 2 * second)
            if which == "timestamp" {
                input.drainForTest(); input.stop()
                try require(first != nil && abs(first! - expected) < 20, "first sample must use the input host timestamp, not delayed callback Date")
                print("PASS host timestamp: simulated 2-second callback delay is not baked into first sample")
            } else if which == "overrun" {
                input.injectForTest([Float](repeating: 0.1, count: 40000), hostTime: host)
                input.stop()
                try require(delivered == 4000, "final overrun drain must retain the previously copied good audio")
                try require(error?.contains("behind") == true, "final overrun drain must report loss, not a clean stop")
                print("PASS final overrun drain: 4000 good samples delivered and failure surfaced")
            }
        }
    }
}
