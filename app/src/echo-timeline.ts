// Worker-owned sample timeline. AEC's delayed output is NEVER used at its input position.
import type WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { captureDiscontinuities, type CaptureTiming } from './capture-gaps.ts';

export const ECHO_RATE = 16_000;
export const ECHO_BLOCK = 160;
export const ECHO_FADE = 80; // <=5 ms, blending raw and cleaned values of the SAME input sample.
export type TimedAudio = { pcm: Float32Array; timing?: CaptureTiming };
export type AudioSpan = { wallMs: number; pcm: Float32Array };
type Kernel = Pick<WebRtcAec3.AEC3, 'analyze' | 'process' | 'free'>;
export type EchoModule = { AEC3: new (rate: number, render: number, capture: number) => Kernel };

export function audioSpans(audio: TimedAudio, leadMs = 0): AudioSpan[] {
  if (!audio.timing || !Number.isFinite(audio.timing.captureWallMs)) return [];
  const cuts = captureDiscontinuities(audio.timing.discontinuities, audio.pcm.length);
  const spans: AudioSpan[] = [];
  let first = 0, wallMs = audio.timing.captureWallMs;
  for (const cut of [...cuts, { offsetSamples: audio.pcm.length, toWallMs: 0 }]) {
    spans.push({ wallMs: wallMs - leadMs, pcm: audio.pcm.subarray(first, cut.offsetSamples) });
    first = cut.offsetSamples; wallMs = cut.toWallMs;
  }
  return spans;
}
export function audioEnd(audio: TimedAudio): number {
  const last = audioSpans(audio).at(-1);
  return last ? last.wallMs + last.pcm.length / 16 : -Infinity;
}

/** Sorted spans; later starts win overlaps. Only CONFIRMED gaps <=5 ms are held from the preceding boundary. */
export function referenceBlock(spans: readonly AudioSpan[], wallMs: number, samples: number) {
  const pcm = new Float32Array(ECHO_BLOCK), covered = new Uint8Array(samples);
  const end = wallMs + samples / 16;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index], spanEnd = span.wallMs + span.pcm.length / 16, next = spans[index + 1];
    const bridge = next && next.wallMs > spanEnd && next.wallMs - spanEnd <= 5 ? next.wallMs : spanEnd;
    if (span.wallMs >= end || bridge <= wallMs) continue;
    const offset = Math.round((span.wallMs - wallMs) * 16);
    const first = Math.max(0, offset), last = Math.min(samples, Math.round((bridge - wallMs) * 16));
    for (let i = first; i < last; i++) { pcm[i] = span.pcm[Math.min(span.pcm.length - 1, i - offset)]; covered[i] = 1; }
  }
  return { pcm, missing: samples - covered.reduce((sum, value) => sum + value, 0) };
}

const delays = new WeakMap<EchoModule, number>();
/** Measure the pinned kernel's full 16->48->16 kHz impulse latency, including band split/merge.
 * A different/unsupported latency fails at worker startup and therefore passes raw, never guesses.
 */
export function processingDelay(module: EchoModule): number {
  const cached = delays.get(module);
  if (cached !== undefined) return cached;
  const aec = new module.AEC3(48_000, 1, 1), at = 720;
  let peak = 0, peakAt = -1;
  try {
    for (let pos = 0; pos < 3200; pos += ECHO_BLOCK) {
      const input = new Float32Array(ECHO_BLOCK), output = new Float32Array(ECHO_BLOCK);
      if (at >= pos && at < pos + ECHO_BLOCK) input[at - pos] = 0.5;
      aec.analyze([new Float32Array(ECHO_BLOCK)], { sampleRateIn: ECHO_RATE });
      aec.process([output], [input], { sampleRateIn: ECHO_RATE, sampleRateOut: ECHO_RATE });
      for (let i = 0; i < output.length; i++) if (Math.abs(output[i]) > peak) { peak = Math.abs(output[i]); peakAt = pos + i; }
    }
  } finally { aec.free(); }
  const delay = peakAt - at;
  if (peak < 0.01 || delay < ECHO_FADE || delay > 640) throw new Error('Unsupported AEC processing latency.');
  delays.set(module, delay);
  return delay;
}

type OutputFrame = { id: string; raw: Float32Array; pcm: Float32Array<ArrayBuffer>; written: number; appended: number; missingSamples: number };
type Target = { frame: OutputFrame; offset: number; start: number; count: number };
export type EchoOutput = { id: string; pcm: Float32Array<ArrayBuffer>; missingSamples: number };

/** Open a frame, append its spans in sample order, then takeReady(). Outputs can need the next
 * capture's first ~10 ms; flush() drains that tail with trailing input at Stop/checkpoint/reset.
 * Partial blocks carry across contiguous spans/frames; padding occurs ONLY when draining/resetting.
 */
export class EchoProcessor {
  private module: EchoModule;
  readonly leadMs: number;
  readonly delaySamples: number;
  private aec: Kernel | null = null;
  private referenceFrames: AudioSpan[][] = [];
  private spans: AudioSpan[] = [];
  referenceEndMs = -Infinity;
  private frames: OutputFrame[] = [];
  private byId = new Map<string, OutputFrame>();
  private targets: Target[] = [];
  private input = new Float32Array(ECHO_BLOCK);
  private render = new Float32Array(ECHO_BLOCK);
  private used = 0;
  private inputCount = 0;
  private processed = 0;
  private fadeOutAt = Infinity;
  private lastEndMs: number | null = null;
  constructor(module: EchoModule, leadMs: number) {
    this.module = module; this.leadMs = leadMs; this.delaySamples = processingDelay(module);
  }
  reference(audio: TimedAudio) {
    this.referenceFrames.push(audioSpans(audio, this.leadMs));
    if (this.referenceFrames.length > 10) this.referenceFrames.shift();
    this.spans = this.referenceFrames.flat().sort((a, b) => a.wallMs - b.wallMs);
    this.referenceEndMs = Math.max(-Infinity, ...this.spans.map(span => span.wallMs + span.pcm.length / 16));
  }
  resetReference() {
    this.flush(true);
    this.referenceFrames = []; this.spans = []; this.referenceEndMs = -Infinity;
  }
  open(id: string, raw: Float32Array) {
    if (this.byId.has(id) || this.frames.length >= 32) throw new Error('AEC frame queue invalid or full.');
    const frame = { id, raw, pcm: raw.slice(), written: 0, appended: 0, missingSamples: 0 };
    this.frames.push(frame); this.byId.set(id, frame);
  }
  append(id: string, offset: number, pcm: Float32Array, wallMs: number | null, allowReference = true) {
    const frame = this.byId.get(id);
    if (!frame || offset !== frame.appended || offset + pcm.length > frame.raw.length) throw new Error('AEC input sample order changed.');
    if (wallMs !== null && this.lastEndMs !== null && Math.abs(wallMs - this.lastEndMs) > 50) this.flush(true);
    for (let pos = 0; pos < pcm.length;) {
      const count = Math.min(ECHO_BLOCK - this.used, pcm.length - pos);
      const reference = allowReference && wallMs !== null ? referenceBlock(this.spans, wallMs + pos / 16, count) : null;
      if (!reference || reference.missing) {
        this.flush(true); // Drain the delayed clean prefix BEFORE switching to same-position raw samples.
        frame.written += count; frame.missingSamples += count;
      } else {
        this.aec ??= new this.module.AEC3(48_000, 1, 1);
        this.targets.push({ frame, offset: offset + pos, start: this.inputCount, count });
        this.input.set(pcm.subarray(pos, pos + count), this.used); this.render.set(reference.pcm.subarray(0, count), this.used);
        this.used += count; this.inputCount += count;
        if (this.used === ECHO_BLOCK) this.block();
      }
      pos += count;
    }
    frame.appended += pcm.length;
    this.lastEndMs = wallMs === null ? null : wallMs + pcm.length / 16;
  }
  /** Convenience for offline regressions; production worker appends as reference becomes available. */
  push(id: string, audio: TimedAudio) {
    this.open(id, audio.pcm);
    const spans = audioSpans(audio);
    let offset = 0;
    for (const span of spans) { this.append(id, offset, span.pcm, span.wallMs); offset += span.pcm.length; }
    if (!spans.length) this.append(id, 0, audio.pcm, null, false);
  }
  private block() {
    if (!this.aec) return;
    const cleaned = new Float32Array(ECHO_BLOCK);
    this.aec.analyze([this.render], { sampleRateIn: ECHO_RATE });
    this.aec.process([cleaned], [this.input], { sampleRateIn: ECHO_RATE, sampleRateOut: ECHO_RATE });
    if (!cleaned.every(Number.isFinite)) throw new Error('AEC produced nonfinite PCM.');
    const start = this.processed - this.delaySamples, end = start + ECHO_BLOCK;
    while (this.targets.length && this.targets[0].start < end) {
      const target = this.targets[0], first = target.start, last = Math.min(first + target.count, end);
      if (first < Math.max(0, start)) throw new Error('AEC output skipped an input sample.');
      for (let i = first; i < last; i++) {
        const gain = Math.max(0, Math.min(1, (i + 1) / ECHO_FADE, (this.fadeOutAt + ECHO_FADE - i - 1) / ECHO_FADE));
        const at = target.offset + i - first, raw = target.frame.raw[at];
        target.frame.pcm[at] = raw + gain * (cleaned[i - start] - raw);
      }
      const count = last - first;
      target.frame.written += count; target.offset += count; target.start += count; target.count -= count;
      if (!target.count) this.targets.shift();
    }
    this.processed += ECHO_BLOCK; this.used = 0; this.input.fill(0); this.render.fill(0);
  }
  flush(fadeToRaw = false) {
    if (!this.aec) return;
    if (fadeToRaw) this.fadeOutAt = Math.max(0, this.inputCount - ECHO_FADE);
    if (this.used) this.block(); // The unused suffix was zeroed after the previous block.
    while (this.processed < this.inputCount + this.delaySamples) this.block();
    if (this.targets.length) throw new Error('AEC did not flush its input tail.');
    this.aec.free(); this.aec = null; this.used = 0; this.inputCount = 0; this.processed = 0; this.fadeOutAt = Infinity;
  }
  takeReady(): EchoOutput[] {
    const result: EchoOutput[] = [];
    while (this.frames.length && this.frames[0].written === this.frames[0].raw.length && this.frames[0].appended === this.frames[0].raw.length) {
      const frame = this.frames.shift()!; this.byId.delete(frame.id);
      result.push({ id: frame.id, pcm: frame.pcm, missingSamples: frame.missingSamples });
    }
    return result;
  }
  buffered() { return { frames: this.frames.length, targets: this.targets.length, partialSamples: this.used, referenceFrames: this.referenceFrames.length }; }
  close() { this.flush(); return this.takeReady(); }
}
