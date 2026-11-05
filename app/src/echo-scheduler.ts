// Pure worker scheduling policy. An explicit clock makes long drift/sleep/rejoin simulations exact.
import { audioSpans, ECHO_BLOCK, type EchoProcessor, type TimedAudio } from './echo-timeline.ts';
type Pending = { id: string; receivedAt: number; spans: { pcm: Float32Array; wallMs: number | null }[]; span: number; pos: number; offset: number };
export class EchoScheduler {
  readonly processor: EchoProcessor;
  readonly waitMs: number;
  private pending: Pending[] = [];
  private admitted = new Map<string, number>();
  private ended = false;
  constructor(processor: EchoProcessor, waitMs: number) { this.processor = processor; this.waitMs = waitMs; }
  admit(id: string, audio: TimedAudio, receivedAt: number) {
    this.processor.open(id, audio.pcm); this.admitted.set(id, receivedAt);
    const spans = audioSpans(audio);
    this.pending.push({ id, receivedAt, spans: spans.length ? spans : [{ pcm: audio.pcm, wallMs: null }], span: 0, pos: 0, offset: 0 });
  }
  reference(audio: TimedAudio) { this.processor.reference(audio); }
  referenceEnded() { this.ended = true; }
  switchReference(audio: TimedAudio[], now: number) {
    const results = this.drain(now, true, true);
    this.processor.resetReference(); this.ended = false;
    for (const frame of audio) this.processor.reference(frame);
    return results;
  }
  drain(now: number, force = false, fadeToRaw = false) {
    while (this.pending.length) {
      const next = this.pending[0], span = next.spans[next.span];
      let count = Math.min(ECHO_BLOCK, span.pcm.length - next.pos);
      const wall = span.wallMs === null ? null : span.wallMs + next.pos / 16;
      if (!force && !this.ended && wall !== null && now - next.receivedAt < this.waitMs) {
        const available = Math.floor((this.processor.referenceEndMs - wall) * 16);
        if (available <= 0) break;
        count = Math.min(count, available);
      }
      this.processor.append(next.id, next.offset, span.pcm.subarray(next.pos, next.pos + count), wall);
      next.pos += count; next.offset += count;
      if (next.pos === span.pcm.length) { next.pos = 0; next.span++; }
      if (next.span === next.spans.length) this.pending.shift();
    }
    const expired = [...this.admitted.values()].some(at => now - at >= this.waitMs);
    // A timeout is a checkpoint, not EOF: its last samples must already fade to raw
    // in case the next capture has missing reference. Never cross an emitted clean/raw edge abruptly.
    if (force || expired) this.processor.flush(fadeToRaw || !force);
    const results = this.processor.takeReady();
    for (const result of results) this.admitted.delete(result.id);
    return results;
  }
  get deadline() { return this.admitted.size ? Math.min(...this.admitted.values()) + this.waitMs : Infinity; }
  buffered() { return { ...this.processor.buffered(), pending: this.pending.length, admitted: this.admitted.size }; }
}
