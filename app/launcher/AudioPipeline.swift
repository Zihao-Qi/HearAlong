import Foundation
import AVFoundation

enum ProbeError: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let text): return text } }
}

/// Frames never cross a 16000-sample boundary; a final short tail is retained separately.
final class MonoFramer {
    private var pending: [Float] = []
    private(set) var frameCount = 0
    private(set) var sampleCount = 0
    let onFrame: ([Float]) -> Void
    init(onFrame: @escaping ([Float]) -> Void) {
        self.onFrame = onFrame
        pending.reserveCapacity(16000)
    }
    func append(_ samples: UnsafeBufferPointer<Float>) {
        var index = 0
        sampleCount += samples.count
        while index < samples.count {
            let amount = min(16000 - pending.count, samples.count - index)
            pending.append(contentsOf: samples[index ..< index + amount])
            index += amount
            if pending.count == 16000 {
                onFrame(pending)
                frameCount += 1
                pending.removeAll(keepingCapacity: true)
            }
        }
    }
    var tail: [Float] { pending }
}

struct ConversionResult {
    let samples: [Float]
    let fullFrames: Int
    let tailSamples: Int
}

enum AudioPipeline {
    /// Offline pull conversion after capture: explicit arithmetic channel mean, then Apple's
    /// band-limited sample-rate converter. Input chunk sizes are deliberately independent
    /// of output/framing boundaries. Nothing here runs in the hardware callback.
    static func convert(_ source: UnsafeBufferPointer<Float>, sampleRate: Double, channels: Int,
                        inputChunks: [Int] = [4096],
                        onFrame: @escaping ([Float]) -> Void = { _ in }) throws -> ConversionResult {
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate),
              (1...8).contains(channels), source.count % channels == 0,
              !inputChunks.isEmpty, inputChunks.allSatisfy({ $0 > 0 && $0 <= 4096 }) else {
            throw ProbeError.message("Invalid PCM input rate/channels/count/chunks")
        }
        let framer = MonoFramer(onFrame: onFrame)
        guard !source.isEmpty else { return ConversionResult(samples: [], fullFrames: 0, tailSamples: 0) }
        let inputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                        channels: 1, interleaved: false)!
        let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000,
                                         channels: 1, interleaved: false)!
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat),
              let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 4096),
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4096) else {
            throw ProbeError.message("Cannot create AVAudioConverter/buffers")
        }
        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        // Normal mode reads ahead for filter priming instead of adding live-mode latency.
        converter.primeMethod = .normal
        let sourceFrames = source.count / channels
        var position = 0
        var chunkIndex = 0
        var converted: [Float] = []
        converted.reserveCapacity(Int(ceil(Double(sourceFrames) * 16000 / sampleRate)) + 4096)
        var noProgress = 0
        while true {
            var error: NSError?
            let oldPosition = position
            let status = converter.convert(to: output, error: &error) { requested, state in
                guard position < sourceFrames else { state.pointee = .endOfStream; return nil }
                let count = min(Int(requested), inputChunks[chunkIndex % inputChunks.count], sourceFrames - position)
                chunkIndex += 1
                input.frameLength = AVAudioFrameCount(count)
                let destination = input.floatChannelData![0]
                for frame in 0..<count {
                    var sum: Float = 0
                    for channel in 0..<channels { sum += source[(position + frame) * channels + channel] }
                    destination[frame] = sum / Float(channels)
                }
                position += count
                state.pointee = .haveData
                return input
            }
            if status == .error { throw error ?? ProbeError.message("AVAudioConverter returned .error") }
            let samples = UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength))
            converted.append(contentsOf: samples)
            framer.append(samples)
            if status == .endOfStream { break }
            noProgress = (position == oldPosition && samples.isEmpty) ? noProgress + 1 : 0
            if noProgress > 8 { throw ProbeError.message("AVAudioConverter stalled") }
        }
        return ConversionResult(samples: converted, fullFrames: framer.frameCount, tailSamples: framer.tail.count)
    }

    static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        return sqrt(samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count))
    }

    /// IEEE float WAV (format tag 3), little endian, mono 16 kHz, with a fact chunk.
    static func writeWAV(_ samples: [Float], to url: URL) throws {
        guard samples.count < (Int(UInt32.max) - 64) / 4 else { throw ProbeError.message("WAV too large") }
        var data = Data()
        func text(_ value: String) { data.append(contentsOf: value.utf8) }
        func u16(_ value: UInt16) { var x = value.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var x = value.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 4)
        text("RIFF"); u32(48 + bytes); text("WAVE")
        text("fmt "); u32(16); u16(3); u16(1); u32(16000); u32(64000); u16(4); u16(32)
        text("fact"); u32(4); u32(UInt32(samples.count))
        text("data"); u32(bytes)
        for sample in samples { u32(sample.bitPattern) }
        try data.write(to: url, options: .atomic)
    }
}
