import type { Recognition } from './recognizer.ts';
import type { Chunk, MeetingStore } from './store.ts';

export interface Recognizer { available?(): boolean; transcribe(chunk: Chunk): Promise<Recognition>; close(): void | Promise<void> }
type JobTiming = { clock?: () => number; setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout; clearTimeout?: (timer: NodeJS.Timeout) => void };

/** One disk-backed queue, bounded in-flight PCM, and no model duplication. */
export class JobManager {
  store: MeetingStore;
  recognizer: Recognizer;
  running = false;
  stopped = false;
  onSettled?: (meetingId: string) => void;
  private drained?: Promise<void>;
  private clock: () => number;
  private setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private clearTimer: (timer: NodeJS.Timeout) => void;
  private retryTimer?: NodeJS.Timeout;
  constructor(store: MeetingStore, recognizer: Recognizer, timing: JobTiming = {}) {
    this.store = store; this.recognizer = recognizer;
    this.clock = timing.clock ?? Date.now; this.setTimer = timing.setTimeout ?? setTimeout; this.clearTimer = timing.clearTimeout ?? clearTimeout;
  }
  kick() {
    if (this.running || this.stopped || this.recognizer.available?.() === false) return;
    if (this.retryTimer) { this.clearTimer(this.retryTimer); this.retryTimer = undefined; }
    this.running = true;
    this.drained = this.pump().finally(() => { this.running = false; });
  }
  private async pump() {
    while (!this.stopped && this.recognizer.available?.() !== false) {
      const job = this.store.nextChunk(this.clock());
      if (!job) {
        const retryAt = this.store.nextRetryAt();
        if (retryAt !== null) {
          this.retryTimer = this.setTimer(() => { this.retryTimer = undefined; this.kick(); }, Math.max(0, retryAt - this.clock()));
          this.retryTimer.unref();
        }
        break;
      }
      // A restart can recover a running third attempt; do not start a fourth.
      if (job.attempts >= 3) {
        this.store.failChunk(job.id, job.error ?? 'Transcription attempt limit reached.', null);
        this.onSettled?.(job.meetingId);
        continue;
      }
      this.store.startChunk(job.id);
      try {
        const result = await this.recognizer.transcribe({ ...job, path: this.store.resolvePath(job.path) });
        if (!this.stopped) this.store.completeChunk(job.id, result);
      } catch (error) {
        if (!this.stopped) {
          const attempts = job.attempts + 1;
          this.store.failChunk(job.id, error instanceof Error ? error.message : String(error),
            attempts < 3 ? this.clock() + (attempts === 1 ? 15_000 : 60_000) : null);
        }
      }
      if (!this.stopped) this.onSettled?.(job.meetingId);
    }
  }
  async wait() { await this.drained; }
  /** Wait for all chunks, including future retries. Call after sealing input; terminal failures/cancellations still need inspection.
   * Unlike wait(), this keeps the process alive and bounds even an unavailable or hung recognizer. Deadline is wall-clock ms.
   */
  async waitUntilTerminal(deadline: number): Promise<void> {
    if (!Number.isFinite(deadline)) throw new Error('A finite settlement deadline is required.');
    while (true) {
      if (this.stopped) throw new Error('Transcription queue closed before settlement.');
      if (this.store.queuedCount() === 0) return;
      if (this.clock() >= deadline) throw new Error('Transcription settlement deadline exceeded.');
      this.kick();
      await new Promise<void>(resolve => { this.setTimer(resolve, Math.min(100, deadline - this.clock())); });
    }
  }
  async close() {
    this.stopped = true;
    if (this.retryTimer) { this.clearTimer(this.retryTimer); this.retryTimer = undefined; }
    await this.recognizer.close();
    await this.drained;
    // A running record intentionally remains recoverable; reopen requeues it.
  }
}
