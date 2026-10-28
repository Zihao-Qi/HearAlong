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
@main struct TapRegressionTests {
    static func require(_ value: @autoclosure () -> Bool, _ text: String) throws { if !value() { throw ProbeError.message(text) } }
    static func main() {
        do { try run() } catch { print("FAIL \(error)"); exit(1) }
    }
    static func run() throws {
        let which = CommandLine.arguments[1]
        if which == "backlog" {
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
