import Foundation

@main struct AppAudioTests {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw ProbeError.message(message) }
    }
    static func main() throws {
        let fictional = AudioProcess(object: 1, pid: 1, bundle: "test.fictional.meet", name: "Fictional Meet", running: true, excluded: false)
        let child = AudioProcess(object: 2, pid: 2, bundle: fictional.bundle, name: fictional.name, running: true, excluded: false)
        let excluded = [
            AudioProcess(object: 3, pid: 3, bundle: "com.google.Chrome.helper", name: "Chrome Helper", running: true, excluded: false),
            AudioProcess(object: 4, pid: 4, bundle: "", name: "No bundle", running: true, excluded: false),
            AudioProcess(object: 5, pid: 5, bundle: "test.server", name: "Server child", running: true, excluded: true),
            AudioProcess(object: 6, pid: 6, bundle: "local.meeting-research-assistant.helper", name: "Helper", running: true, excluded: false),
            AudioProcess(object: 7, pid: 7, bundle: "test.idle", name: "Idle", running: false, excluded: false),
        ]
        try require(groupAudioApps([fictional, child] + excluded) == [AudioApp(id: fictional.bundle, name: fictional.name)], "grouping/filtering")
        print("PASS app grouping: child processes, Chrome, own/server processes, no bundle, inactive outputs")

        let safari = AudioApp(id: "com.apple.Safari", name: "Safari")
        let raycast = AudioApp(id: "com.raycast.macos", name: "Raycast")
        let safariOwner = AudioAppOwner(app: safari, excluded: false), raycastOwner = AudioAppOwner(app: raycast, excluded: false)
        let gpu = AudioProcess(object: 20, pid: 200, bundle: "com.apple.WebKit.GPU", name: "Raycast Graphics and Media", running: true, excluded: false)
        let otherGPU = AudioProcess(object: 21, pid: 201, bundle: gpu.bundle, name: gpu.name, running: true, excluded: false)
        let idleHelper = AudioProcess(object: 22, pid: 202, bundle: gpu.bundle, name: gpu.name, running: false, excluded: false)
        let owners = [gpu.pid: safariOwner, otherGPU.pid: raycastOwner, idleHelper.pid: safariOwner]
        let attributed = [gpu, otherGPU, idleHelper].map { attributeAudioProcess($0, responsibleApp: owners[$0.pid]) }
        try require(groupAudioApps(attributed) == [raycast, safari], "WebKit GPU helpers must form separate named client-app rows")
        try require(audioProcesses(for: safari, in: attributed).map(\.object) == [20, 22], "Safari tap must contain only Safari-owned HAL objects, including idle helpers")
        try require(audioProcesses(for: raycast, in: attributed).map(\.object) == [21], "Raycast tap must not contain Safari's GPU")
        try require(attributed[0].pid == gpu.pid && attributed[0].running == gpu.running, "attribution must retain the actual audio process")
        try require(attributeAudioProcess(gpu, responsibleApp: nil) == gpu, "missing responsibility must preserve bundle/path fallback")
        let unknownOwner = AudioAppOwner(app: AudioApp(id: "", name: "Unknown"), excluded: false)
        try require(attributeAudioProcess(gpu, responsibleApp: unknownOwner) == gpu, "unresolved responsible app must preserve fallback")
        print("PASS WebKit attribution: Safari/Raycast GPU helpers give separate app names and disjoint tap process sets; missing owner falls back")

        let forbiddenOwners = [
            AudioAppOwner(app: AudioApp(id: "com.google.Chrome", name: "Chrome"), excluded: false),
            AudioAppOwner(app: AudioApp(id: "local.meeting-research-assistant.helper", name: "HearAlong"), excluded: false),
            AudioAppOwner(app: safari, excluded: true), // Responsible pid is this helper or in the server's group.
        ]
        let remappedExcluded = excluded.filter { $0.excluded || $0.bundle.hasPrefix("com.google.Chrome") || $0.bundle.hasPrefix("local.meeting-research-assistant") }
            .map { attributeAudioProcess($0, responsibleApp: safariOwner) }
            + forbiddenOwners.map { attributeAudioProcess(gpu, responsibleApp: $0) }
        try require(groupAudioApps(remappedExcluded).isEmpty, "raw or responsible-app exclusions must survive attribution")
        for owner in [safari, raycast] + forbiddenOwners.map(\.app) {
            try require(audioProcesses(for: owner, in: remappedExcluded).isEmpty, "excluded processes must never reach a tap")
        }
        print("PASS attribution exclusions: raw and mapped Chrome, HearAlong and server-group processes stay out of rows and taps")

        let clock = 1_000_000.0, first = clock + 2375.5
        let timeline = AppTimeline(clockStart: clock, firstWallMs: first)
        for second in 0...3600 {
            try require(abs(timeline.startMs(samples: second * 16000) - (2375.5 + Double(second) * 1000)) < 0.001, "sample-count timeline drift")
        }
        print("PASS timeline: first frame wall placement; one hour fixed-rate drift < 0.001 ms")

        for rate in [44100.0, 48000.0, 16000.0] {
            let converter = try TapConverter(rate: rate)
            let count = Int(rate * 2.25), channels = 2
            var converted: [Float] = []
            var position = 0
            while position < count {
                let frames = min(1379, count - position)
                var samples: [Float] = []
                for n in 0..<frames {
                    let value = Float(sin(Double(position + n) * 2 * .pi * 440 / rate))
                    samples.append(value * 0.8); samples.append(value * 0.2)
                }
                try converter.convert(samples, channels: channels, final: false) { converted.append(contentsOf: $0) }
                position += frames
            }
            try converter.convert([], channels: channels, final: true) { converted.append(contentsOf: $0) }
            try require(abs(converted.count - 36000) <= 1, "continuous conversion duration at \(rate): \(converted.count)")
            var sizes: [Int] = []
            let framer = MonoFramer { sizes.append($0.count) }
            converted.withUnsafeBufferPointer { framer.append($0) }
            try require(sizes == [16000, 16000] && abs(framer.tail.count - 4000) <= 1, "framing and unpadded tail")
            try require(abs(AudioPipeline.rms(Array(converted.dropFirst(1000).dropLast(1000))) - 0.5 / sqrt(2)) < 0.002, "continuous downmix amplitude")
            print("PASS live converter \(rate) Hz: 2 full frames and \(framer.tail.count)-sample tail")
        }
#if APP_AUDIO_TESTING
        let fake = FakeAudioInput()
        var firstReceived: Double?, firstWall: Double?, count = 0
        let expectedStart = Date().timeIntervalSince1970 * 1000
        try fake.start(app: AudioApp(id: fictional.bundle, name: fictional.name), receive: { samples, wall in
            firstReceived = firstReceived ?? Date().timeIntervalSince1970 * 1000
            firstWall = firstWall ?? wall; count += samples.count
        }, ended: { _ in })
        let until = Date().addingTimeInterval(2.2)
        while Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        fake.stop()
        try require(firstReceived != nil && count >= 32000, "fixed-rate fake produces samples")
        try require(abs(AppTimeline(clockStart: clock, firstWallMs: firstWall!).startMs(samples: 0) - (expectedStart - clock)) < 100, "fake first frame within 100 ms")
        print("PASS fixed-rate fake: expected first frame within 100 ms, no HAL/tap calls")
#endif
    }
}
