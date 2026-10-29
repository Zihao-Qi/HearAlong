import type { Recognition } from './recognizer.ts';
import type { Chunk, MeetingStore } from './store.ts';

export interface Recognizer { available?(): boolean; transcribe(chunk: Chunk): Promise<Recognition>; close(): void | Promise<void> }
type JobTiming = { clock?: () => number; setTimeout?: (callback: () => void, ms: number) => NodeJS.Timeout; clearTimeout?: (timer: NodeJS.Timeout) => void };
type Settlement = { job: Chunk; result: Recognition } | { job: Chunk; error: string; delayMs: number | null };

/** One disk-backed queue, bounded in-flight PCM, and no model duplication. */
export class JobManager {
  store: MeetingStore;
  recognizer: Recognizer;
  running = false;
  stopped = false;
  /** Independent of SQLite: a failed database cannot be the only place its own error is reported. */
  storageError: string | null = null;
  onSettled?: (meetingId: string) => void;
  private drained?: Promise<void>;
  private clock: () => number;
  private setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private clearTimer: (timer: NodeJS.Timeout) => void;
  private retryTimer?: NodeJS.Timeout;
  private storageRetryAt = 0;
  private storageFailures = 0;
  /** Keep a result/failure until its transaction succeeds; never strand a running chunk or rerun successful recognition. */
  private settlement?: Settlement;
  constructor(store: MeetingStore, recognizer: Recognizer, timing: JobTiming = {}) {
    this.store = store; this.recognizer = recognizer;
    this.clock = timing.clock ?? Date.now; this.setTimer = timing.setTimeout ?? setTimeout; this.clearTimer = timing.clearTimeout ?? clearTimeout;
  }
  private wake(at: number) {
    this.retryTimer = this.setTimer(() => { this.retryTimer = undefined; this.kick(); }, Math.max(0, at - this.clock()));
    this.retryTimer.unref();
  }
  kick() {
    if (this.running || this.stopped || this.recognizer.available?.() === false || this.clock() < this.storageRetryAt) return;
    if (this.retryTimer) { this.clearTimer(this.retryTimer); this.retryTimer = undefined; }
    this.running = true;
    this.drained = this.pump();
  }
  private async pump() {
    try {
      while (!this.stopped && this.recognizer.available?.() !== false) {
        if (this.settlement) {
          const saved = this.settlement;
          if ('result' in saved) this.store.completeChunk(saved.job.id, saved.result);
          else this.store.failChunk(saved.job.id, saved.error, saved.delayMs === null ? null : this.clock() + saved.delayMs);
          this.settlement = undefined;
          this.onSettled?.(saved.job.meetingId);
          continue;
        }
        const job = this.store.nextChunk(this.clock());
        if (!job) {
          const retryAt = this.store.nextRetryAt();
          if (retryAt !== null) this.wake(retryAt);
          break;
        }
        // A restart can recover a running third attempt; do not start a fourth.
        if (job.attempts >= 3) {
          this.settlement = { job, error: job.error ?? 'Transcription attempt limit reached.', delayMs: null };
          continue;
        }
        this.store.startChunk(job.id);
        try {
          const result = await this.recognizer.transcribe({ ...job, path: this.store.resolvePath(job.path) });
          if (!this.stopped) this.settlement = { job, result };
        } catch (error) {
          if (!this.stopped) {
            const attempts = job.attempts + 1;
            this.settlement = { job, error: error instanceof Error ? error.message : String(error),
              delayMs: attempts < 3 ? (attempts === 1 ? 15_000 : 60_000) : null };
          }
        }
      }
      this.storageError = null; this.storageFailures = 0; this.storageRetryAt = 0;
    } catch (error) {
      // Every fire-and-forget caller is safe. No database writes in this handler.
      if (this.stopped) return;
      this.storageError = error instanceof Error ? error.message : String(error);
      this.storageRetryAt = this.clock() + Math.min(60_000, 15_000 * 2 ** Math.min(this.storageFailures++, 2));
      this.wake(this.storageRetryAt);
    } finally {
      // Release before resolving: a due retry/terminal poll must not lose its kick to a drained pump.
      this.running = false;
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
