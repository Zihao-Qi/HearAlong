// Worker-owned PCM timeline. No I/O, device access, persistence or product clocks.
import type WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { captureDiscontinuities, type CaptureTiming } from './capture-gaps.ts';

export const ECHO_RATE = 16_000;
export const ECHO_BLOCK = 160;
export type TimedAudio = { pcm: Float32Array; timing?: CaptureTiming };
export type AudioSpan = { wallMs: number; pcm: Float32Array };

/** A sleep inside a frame changes wall time, not the compact recording/sample clock. */
export function audioSpans(audio: TimedAudio, leadMs = 0): AudioSpan[] {
  if (!audio.timing || !Number.isFinite(audio.timing.captureWallMs)) return [];
  const cuts = captureDiscontinuities(audio.timing.discontinuities, audio.pcm.length);
  const spans: AudioSpan[] = [];
  let first = 0, jumpMs = 0;
  for (const cut of [...cuts, { offsetSamples: audio.pcm.length, fromWallMs: 0, toWallMs: 0 }]) {
    spans.push({ wallMs: audio.timing.captureWallMs + first / 16 + jumpMs - leadMs, pcm: audio.pcm.subarray(first, cut.offsetSamples) });
    jumpMs += cut.toWallMs - cut.fromWallMs;
    first = cut.offsetSamples;
  }
  return spans;
}

/** Latest starts win in overlaps (small per-frame drift corrections). Uncovered samples stay silent. */
export function referenceBlock(spans: readonly AudioSpan[], wallMs: number, samples: number) {
  const pcm = new Float32Array(ECHO_BLOCK), covered = new Uint8Array(samples);
  const end = wallMs + samples / 16;
  for (const span of spans) {
    if (span.wallMs >= end || span.wallMs + span.pcm.length / 16 <= wallMs) continue;
    const offset = Math.round((span.wallMs - wallMs) * 16);
    const first = Math.max(0, offset), last = Math.min(samples, offset + span.pcm.length);
    for (let i = first; i < last; i++) { pcm[i] = span.pcm[i - offset]; covered[i] = 1; }
  }
  return { pcm, missing: samples - covered.reduce((sum, value) => sum + value, 0) };
}

export function audioEnd(audio: TimedAudio): number {
  const last = audioSpans(audio).at(-1);
  return last ? last.wallMs + last.pcm.length / 16 : -Infinity;
}

/** One instance per microphone recording. Only called in the worker, in capture sequence order. */
export class EchoProcessor {
  private aec: WebRtcAec3.AEC3;
  private spans: AudioSpan[] = [];
  private referenceFrames: AudioSpan[][] = [];
  private lastEndMs: number | null = null;
  referenceEndMs = -Infinity;
  private module: WebRtcAec3.WebRtcAec3;
  readonly leadMs: number;
  constructor(module: WebRtcAec3.WebRtcAec3, leadMs: number) {
    this.module = module; this.leadMs = leadMs;
    this.aec = new module.AEC3(48_000, 1, 1);
  }
  reference(audio: TimedAudio) {
    this.referenceFrames.push(audioSpans(audio, this.leadMs));
    // Bound by PCM frames, NOT wall duration: a sleep inside one frame must not evict its pre-sleep half.
    if (this.referenceFrames.length > 10) this.referenceFrames.shift();
    this.spans = this.referenceFrames.flat().sort((a, b) => a.wallMs - b.wallMs);
    this.referenceEndMs = Math.max(...this.spans.map(span => span.wallMs + span.pcm.length / 16));
  }
  process(audio: TimedAudio) {
    const output = audio.pcm.slice();
    let position = 0, missingSamples = 0;
    for (const span of audioSpans(audio)) {
      // Ignore small per-frame clock drift, reset adaptive history across real discontinuities/sleep/backward jumps.
      if (this.lastEndMs !== null && Math.abs(span.wallMs - this.lastEndMs) > 50) {
        this.aec.free(); this.aec = new this.module.AEC3(48_000, 1, 1);
      }
      for (let pos = 0; pos < span.pcm.length; pos += ECHO_BLOCK) {
        const count = Math.min(ECHO_BLOCK, span.pcm.length - pos);
        const capture = new Float32Array(ECHO_BLOCK); capture.set(span.pcm.subarray(pos, pos + count));
        const reference = referenceBlock(this.spans, span.wallMs + pos / 16, count);
        const cleaned = new Float32Array(ECHO_BLOCK);
        this.aec.analyze([reference.pcm], { sampleRateIn: ECHO_RATE });
        this.aec.process([cleaned], [capture], { sampleRateIn: ECHO_RATE, sampleRateOut: ECHO_RATE });
        // Missing reference means literal pass-through, not suppression by an AEC fed silence.
        if (!reference.missing) output.set(cleaned.subarray(0, count), position + pos);
        missingSamples += reference.missing;
      }
      this.lastEndMs = span.wallMs + span.pcm.length / 16;
      position += span.pcm.length;
    }
    if (!position) missingSamples = audio.pcm.length;
    if (!output.every(Number.isFinite)) throw new Error('AEC produced nonfinite PCM.');
    return { pcm: output, missingSamples };
  }
  close() { this.aec.free(); }
}
