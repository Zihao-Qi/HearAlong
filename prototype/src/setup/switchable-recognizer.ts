import { LocalRecognizer, type Recognition } from '../recognizer.ts';
import type { Recognizer } from '../jobs.ts';
import type { Chunk } from '../store.ts';

export type SwitchOptions = { workerScript?: URL; loadMs?: number };

/** One stable queue adapter. Preflight owns a separate worker; the swap owns the gap between jobs. */
export class SwitchableRecognizer implements Recognizer {
  private current?: LocalRecognizer;
  private testing?: LocalRecognizer;
  private generation = 0;
  private inflight?: Promise<Recognition>;
  private barrier?: Promise<boolean>;
  private retiring = new Set<Promise<void>>();
  private switches = new Set<Promise<boolean>>();
  private closed = false;
  private closing?: Promise<void>;
  private options: SwitchOptions;
  constructor(path: string | null, options: SwitchOptions = {}) {
    this.options = options;
    if (path) this.current = new LocalRecognizer(path, options.workerScript);
  }
  available() { return !this.closed && Boolean(this.current); }
  get backend() { return this.current?.backend ?? 'unavailable'; }
  get modelPath() { return this.current?.modelPath ?? null; }
  cancelSwitch() {
    ++this.generation;
    const testing = this.testing;
    this.testing = undefined;
    if (testing) this.retire(testing);
  }
  private retire(candidate: LocalRecognizer) {
    const done = candidate.cancelLoad().catch(() => {}).finally(() => this.retiring.delete(done));
    this.retiring.add(done);
  }
  switchTo(path: string, applied?: () => void, canApply: () => boolean = () => true): Promise<boolean> {
    this.cancelSwitch();
    if (this.closed) return Promise.resolve(false);
    const generation = this.generation;
    const candidate = new LocalRecognizer(path, this.options.workerScript);
    this.testing = candidate;
    const work = (async () => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.retire(candidate); }, this.options.loadMs ?? 60_000);
      try {
        try { await candidate.load(); }
        catch (error) {
          if (generation !== this.generation || this.closed) return false;
          throw new Error(timedOut ? 'Speech model load timed out.' : `Could not load speech model: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}`);
        } finally { clearTimeout(timer); }
        for (;;) {
          if (generation !== this.generation || this.closed) return false;
          // A recording that began during preflight must keep using the old model too.
          if (!canApply()) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
          const previous = this.barrier;
          const swap = (async () => {
            await previous?.catch(() => {});
            await this.inflight?.catch(() => {});
            if (generation !== this.generation || this.closed || !canApply()) return false;
            if (!candidate.worker || candidate.worker.exitCode !== null || candidate.worker.signalCode !== null)
              throw new Error('Speech model process exited before the switch.');
            const old = this.current;
            // Commit ownership synchronously. Supersession can no longer kill this now-current worker.
            // The barrier prevents its first transcription until the old worker has exited.
            this.current = candidate;
            this.testing = undefined;
            applied?.();
            await old?.close();
            return true;
          })();
          this.barrier = swap;
          try { if (await swap) return true; }
          finally { if (this.barrier === swap) this.barrier = undefined; }
        }
      } finally {
        if (this.current !== candidate) await candidate.cancelLoad();
        if (this.testing === candidate) this.testing = undefined;
      }
    })();
    this.switches.add(work);
    void work.then(() => this.switches.delete(work), () => this.switches.delete(work));
    return work;
  }
  async transcribe(chunk: Chunk): Promise<Recognition> {
    while (this.barrier) await this.barrier.catch(() => {});
    if (this.closed) throw new Error('Recognizer has stopped.');
    if (!this.current) throw new Error('No local model is available.');
    const work = this.current.transcribe(chunk);
    this.inflight = work;
    try { return await work; }
    finally { if (this.inflight === work) this.inflight = undefined; }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.cancelSwitch();
      await Promise.allSettled([...this.retiring, ...this.switches, this.current?.close(), this.barrier]);
    })().catch(() => {});
    return this.closing;
  }
}
