import Foundation
import AVFoundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ProbeError.message("FAIL: " + message) }
}
func sine(rate: Double, seconds: Double, frequency: Double, amplitudes: [Float]) -> [Float] {
    let count = Int(rate * seconds)
    var result = [Float](repeating: 0, count: count * amplitudes.count)
    for n in 0..<count {
        let value = Float(sin(2 * Double.pi * frequency * Double(n) / rate))
        for c in amplitudes.indices { result[n * amplitudes.count + c] = value * amplitudes[c] }
    }
    return result
}
func frequency(_ source: [Float]) -> Double {
    // Skip filter startup/end. Estimate from positive-going zero crossings with interpolation.
    var crossings: [Double] = []
    for n in 1001..<(source.count - 1000) where source[n - 1] <= 0 && source[n] > 0 {
        crossings.append(Double(n - 1) + Double(-source[n - 1] / (source[n] - source[n - 1])))
    }
    guard crossings.count >= 2 else { return 0 }
    return Double(crossings.count - 1) * 16000 / (crossings.last! - crossings.first!)
}

@main struct PipelineTests {
    static func main() throws {
        setbuf(stdout, nil)
        let sixty = sine(rate: 48000, seconds: 60, frequency: 1000, amplitudes: [0.8, 0.2])
        var frames = 0
        var frameSizesValid = true
        let result = try sixty.withUnsafeBufferPointer {
            try AudioPipeline.convert($0, sampleRate: 48000, channels: 2, inputChunks: [1, 7, 511, 4096, 1023]) { frame in
                frameSizesValid = frameSizesValid && frame.count == 16000
                frames += 1
            }
        }
        try require(frameSizesValid, "every frame is exactly 16000 samples")
        try require(result.samples.count == 960000 && result.tailSamples == 0 && frames == 60 && result.fullFrames == 60,
                    "48k 60s -> exactly 960000 output samples, 60 frames, no drift (got \(result.samples.count), \(frames))")
        let hz = frequency(result.samples)
        let rms = AudioPipeline.rms(Array(result.samples[1000..<result.samples.count - 1000]))
        try require(abs(hz - 1000) < 0.1, "correct sine frequency: \(hz)")
        try require(abs(rms - 0.5 / sqrt(2)) < 0.001, "channel mean RMS: \(rms)")
        print("PASS 48k stereo 60s: \(result.samples.count) samples, \(frames) exact frames; frequency=\(hz) Hz RMS=\(rms)")

        let regular = try sixty.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) }
        try require(regular.samples.count == result.samples.count, "chunk-invariant duration")
        let difference = zip(regular.samples, result.samples).map { abs($0 - $1) }.max() ?? 0
        try require(difference < 1e-5, "chunk-invariant values: max difference \(difference)")
        print("PASS irregular versus regular input chunks: max difference=\(difference)")

        let otherRate = sine(rate: 44100, seconds: 60, frequency: 997, amplitudes: [0.4, 0.4])
        let other = try otherRate.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 44100, channels: 2, inputChunks: [137, 4096, 1]) }
        try require(other.samples.count == 960000 && other.fullFrames == 60 && other.tailSamples == 0, "44.1k no drift: \(other.samples.count)")
        try require(abs(frequency(other.samples) - 997) < 0.1, "44.1k frequency")
        print("PASS 44.1k stereo 60s: exactly 960000 samples, correct 997 Hz frequency")

        let partial = sine(rate: 48000, seconds: 2.25, frequency: 500, amplitudes: [0.5, 0.5])
        let tail = try partial.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) }
        try require(tail.samples.count == 36000 && tail.fullFrames == 2 && tail.tailSamples == 4000, "partial tail retained without padding")
        print("PASS 2.25s: two full frames plus 4000-sample tail")

        let cancel = sine(rate: 48000, seconds: 1, frequency: 1000, amplitudes: [0.5, -0.5])
        let cancelled = try cancel.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) }
        try require(AudioPipeline.rms(cancelled.samples) < 1e-8, "arithmetic stereo downmix cancellation")
        let high = sine(rate: 48000, seconds: 2, frequency: 12000, amplitudes: [0.5, 0.5])
        let filtered = try high.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) }
        let aliasRMS = AudioPipeline.rms(Array(filtered.samples.dropFirst(1000).dropLast(1000)))
        try require(aliasRMS < 0.001, "anti-alias rejection: \(aliasRMS)")
        print("PASS downmix cancellation and 12kHz anti-alias rejection: RMS=\(aliasRMS)")

        let native = sine(rate: 16000, seconds: 1, frequency: 440, amplitudes: [0.25])
        let passThrough = try native.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 16000, channels: 1) }
        try require(passThrough.samples == native, "16k mono identity")
        let empty: [Float] = []
        let emptyResult = try empty.withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) }
        try require(emptyResult.samples.isEmpty, "empty input")
        var rejected = false
        do { _ = try [Float(0)].withUnsafeBufferPointer { try AudioPipeline.convert($0, sampleRate: 48000, channels: 2) } }
        catch { rejected = true }
        try require(rejected, "reject unaligned interleaved input")
        print("PASS 16k mono identity, empty input, invalid input rejection")

        let url = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("test-output.wav")
        try AudioPipeline.writeWAV(tail.samples, to: url)
        let file = try AVAudioFile(forReading: url)
        try require(file.fileFormat.sampleRate == 16000 && file.fileFormat.channelCount == 1 && file.length == 36000 && file.fileFormat.commonFormat == .pcmFormatFloat32, "WAV readback format")
        let read = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        var recovered: [Float] = []
        while recovered.count < tail.samples.count {
            try file.read(into: read, frameCount: AVAudioFrameCount(tail.samples.count - recovered.count))
            guard read.frameLength > 0 else { break }
            recovered.append(contentsOf: UnsafeBufferPointer(start: read.floatChannelData![0], count: Int(read.frameLength)))
        }
        let readbackDifference = zip(recovered, tail.samples).map { abs($0 - $1) }.max() ?? 0
        try require(recovered == tail.samples, "bit-exact float WAV round trip; read=\(recovered.count) expected=\(tail.samples.count) maxDiff=\(readbackDifference) format=\(file.processingFormat)")
        print("PASS float32 WAV round trip: 16000Hz mono, 36000 bit-exact samples")
        print("ALL TESTS PASSED")
    }
}
