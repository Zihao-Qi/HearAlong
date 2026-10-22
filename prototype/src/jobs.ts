import type { Recognition } from './recognizer.ts';
import type { Chunk, MeetingStore } from './store.ts';

export interface Recognizer { available?(): boolean; transcribe(chunk: Chunk): Promise<Recognition>; close(): void | Promise<void> }

/** One disk-backed queue, bounded in-flight PCM, and no model duplication. */
export class JobManager {
  store: MeetingStore;
  recognizer: Recognizer;
  running = false;
  stopped = false;
  onSettled?: (meetingId: string) => void;
  private drained?: Promise<void>;
  constructor(store: MeetingStore, recognizer: Recognizer) { this.store = store; this.recognizer = recognizer; }
  kick() {
    if (this.running || this.stopped || this.recognizer.available?.() === false) return;
    this.running = true;
    this.drained = this.pump().finally(() => { this.running = false; });
  }
  private async pump() {
    while (!this.stopped && this.recognizer.available?.() !== false) {
      const job = this.store.nextChunk();
      if (!job) break;
      this.store.setStatus(job.id, 'running');
      try {
        const result = await this.recognizer.transcribe({ ...job, path: this.store.resolvePath(job.path) });
        if (!this.stopped) this.store.completeChunk(job.id, result);
      } catch (error) {
        if (!this.stopped) this.store.setStatus(job.id, 'failed', '', error instanceof Error ? error.message : String(error));
      }
      if (!this.stopped) this.onSettled?.(job.meetingId);
    }
  }
  async wait() { await this.drained; }
  async close() {
    this.stopped = true;
    await this.recognizer.close();
    await this.drained;
    // A running record intentionally remains recoverable; reopen requeues it.
  }
}
