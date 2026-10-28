import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const PARAKEET = {
  url: 'https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/7e948f21b7bdbac698d3318db9d350f1096f3b6c/parakeet-unified-en-0.6b-Q8_0.gguf',
  bytes: 731_357_568,
  sha256: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795',
};
export type DownloadState =
  | { state: 'idle' | 'checking' | 'damaged' }
  | { state: 'downloading'; bytes: number; total: number; etaSeconds: number | null }
  | { state: 'paused'; bytes: number }
  | { state: 'interrupted'; bytes: number; reason: string }
  | { state: 'done'; path: string }
  | { state: 'noSpace'; neededBytes: number };
export type DownloadOptions = { directory: string; url?: string; bytes?: number; sha256?: string;
  freeSpace?: (directory: string) => Promise<number>;
  onDone?: (path: string) => Promise<void> };
const RESERVE = 100 * 1024 * 1024;

/** A server-owned single job. All aborting operations await the writer before touching its part. */
export class ModelDownload {
  state: DownloadState = { state: 'idle' };
  readonly path: string;
  readonly part: string;
  readonly ready: Promise<void>;
  private options: Required<Pick<DownloadOptions, 'url' | 'bytes' | 'sha256' | 'freeSpace'>> & DownloadOptions;
  private controller?: AbortController;
  private job?: Promise<void>;
  private stopping?: 'pause' | 'cancel';
  private control?: Promise<void>;
  private requests = 0;
  private finalizing = false;
  /** The verified file exists, including while its completion callback is still running. */
  get completed() { return this.finalizing || this.state.state === 'done'; }
  private closed = false;
  constructor(options: DownloadOptions) {
    this.options = { ...options, url: options.url ?? PARAKEET.url, bytes: options.bytes ?? PARAKEET.bytes, sha256: options.sha256 ?? PARAKEET.sha256,
      freeSpace: options.freeSpace ?? (async directory => { const info = await statfs(directory); return info.bavail * info.bsize; }) };
    this.path = join(options.directory, 'models', 'parakeet-unified-en-0.6b-Q8_0.gguf');
    this.part = `${this.path}.part`;
    this.ready = this.initialize();
  }
  private async size() { return (await stat(this.part).catch(() => null))?.size ?? 0; }
  private async initialize() {
    const bytes = await this.size();
    if (bytes > this.options.bytes) await rm(this.part, { force: true });
    else if (bytes || await stat(this.part).catch(() => null)) this.state = { state: 'paused', bytes };
  }
  /** Starts immediately and returns the shared completion promise (the API need not await it). */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Re-run completion if another request arrived while it was applying setup state.
    // Record this before a control that may itself be waiting for that completion.
    ++this.requests;
    if (this.control) return this.control.then(() => this.start());
    if (this.job) return this.job;
    if (this.state.state === 'done') return Promise.resolve();
    this.stopping = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const bytes = 'bytes' in this.state ? this.state.bytes : 0;
    this.state = { state: 'downloading', bytes, total: this.options.bytes, etaSeconds: null };
    let job!: Promise<void>;
    job = (async () => {
      let completed = false;
      try {
        completed = await this.run(controller.signal);
        if (completed) {
          this.finalizing = true;
          let appliedRequest: number;
          do {
            appliedRequest = this.requests;
            try { await this.options.onDone?.(this.path); }
            catch (error) { console.warn(`The speech model was downloaded, but setup could not be updated: ${(error as Error).message}`); }
          } while (appliedRequest !== this.requests);
        }
      } finally {
        // No await between the last promotion check, publishing done, and releasing the shared job.
        if (this.job === job) {
          if (completed) this.state = { state: 'done', path: this.path };
          this.finalizing = false;
          this.job = undefined; this.controller = undefined;
        }
      }
    })();
    this.job = job;
    return job;
  }
  private async run(signal: AbortSignal): Promise<boolean> {
    let bytes = 0;
    try {
      await this.ready;
      await mkdir(join(this.options.directory, 'models'), { recursive: true, mode: 0o700 });
      bytes = await this.size();
      if (bytes > this.options.bytes) { await rm(this.part, { force: true }); bytes = 0; }
      const neededBytes = this.options.bytes - bytes + RESERVE;
      if (await this.options.freeSpace(join(this.options.directory, 'models')) < neededBytes) {
        this.state = { state: 'noSpace', neededBytes }; return false;
      }
      signal.throwIfAborted();
      let hash = createHash('sha256');
      if (bytes) {
        this.state = { state: 'checking' };
        for await (const chunk of createReadStream(this.part, { signal })) hash.update(chunk);
      }
      const started = performance.now(), initial = bytes;
      this.state = { state: 'downloading', bytes, total: this.options.bytes, etaSeconds: null };
      if (bytes < this.options.bytes) {
        const response = await fetch(this.options.url, { signal, headers: bytes ? { Range: `bytes=${bytes}-` } : {} });
        if (!response.ok || (response.status !== 200 && response.status !== 206)) {
          await response.body?.cancel(); throw new Error(`Download returned HTTP ${response.status}.`);
        }
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          if (!range || Number(range[1]) !== bytes || Number(range[3]) !== this.options.bytes || Number(range[2]) !== this.options.bytes - 1) {
            await response.body?.cancel(); throw new Error('The server returned an invalid download range.');
          }
        } else if (bytes) { bytes = 0; hash = createHash('sha256'); }
        if (!response.body) throw new Error('The download response was empty.');
        const file = await open(this.part, bytes ? 'a' : 'w', 0o600);
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            if (bytes + chunk.length > this.options.bytes) {
              this.state = { state: 'damaged' }; break;
            }
            let offset = 0;
            while (offset < chunk.length) {
              const written = await file.write(chunk, offset, chunk.length - offset);
              if (!written.bytesWritten) throw new Error('Could not write the model file.');
              hash.update(chunk.subarray(offset, offset + written.bytesWritten));
              offset += written.bytesWritten; bytes += written.bytesWritten;
            }
            const rate = (bytes - (response.status === 200 ? 0 : initial)) / ((performance.now() - started) / 1000);
            this.state = { state: 'downloading', bytes, total: this.options.bytes, etaSeconds: rate > 0 ? Math.ceil((this.options.bytes - bytes) / rate) : null };
          }
        } finally { await file.close(); }
      }
      signal.throwIfAborted();
      if (this.state.state === 'damaged') { await rm(this.part, { force: true }); return false; }
      if (bytes !== this.options.bytes) throw new Error('The connection ended before the file was complete.');
      this.state = { state: 'checking' };
      if (hash.digest('hex') !== this.options.sha256) {
        await rm(this.part, { force: true }); this.state = { state: 'damaged' }; return false;
      }
      await rename(this.part, this.path);
      return true;
    } catch (error) {
      bytes = await this.size();
      if (this.stopping || signal.aborted) this.state = { state: 'paused', bytes };
      else if ((error as NodeJS.ErrnoException).code === 'ENOSPC') this.state = { state: 'noSpace', neededBytes: Math.max(0, this.options.bytes - bytes) + RESERVE };
      else {
        const reason = error instanceof Error ? error.message : 'The connection was lost.';
        this.state = { state: 'interrupted', bytes, reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 180) };
      }
      return false;
    }
  }
  private stop(kind: 'pause' | 'cancel'): Promise<void> {
    // Serialize concurrent controls and starts, including a cancel racing a resume.
    const operation = (this.control ?? Promise.resolve()).then(async () => {
      await this.ready;
      const job = this.job;
      if (job) {
        this.stopping = kind;
        this.controller?.abort();
        await job;
      }
      if (['done', 'damaged', 'noSpace', 'idle'].includes(this.state.state)) return;
      if (kind === 'cancel' && (this.state.state === 'paused' || this.state.state === 'interrupted')) {
        await rm(this.part, { force: true }); this.state = { state: 'idle' };
      } else if (job && kind === 'pause') this.state = { state: 'paused', bytes: await this.size() };
    });
    const control = operation.finally(() => { if (this.control === control) this.control = undefined; });
    this.control = control;
    return control;
  }
  pause() { return this.stop('pause'); }
  cancel() { return this.stop('cancel'); }
  async close() {
    this.closed = true;
    await this.control?.catch(() => {});
    if (this.job) await this.pause().catch(() => {});
  }
}
