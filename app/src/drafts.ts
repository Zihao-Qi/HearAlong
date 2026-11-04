import { fork, type ChildProcess } from 'node:child_process';
import { timedWords, midpoint, type TimedWord } from '../public/preview-composition.js';
import type { Chunk } from './store.ts';

/** A live window's draft text: shown in the transcript only, never stored, never read by correction, board or notes. */
export type Draft = {
  meetingId: string; source: string; window: string; windowStartMs: number; text: string; behind: boolean;
  /** Stable, irreversible audio coverage on the meeting clock. */
  committedUntilMs: number;
  /** Coverage of the current hypothesis (stable coverage or the last current token); may retract. */
  coveredUntilMs: number;
  /** Display words grouped from real token times, on the meeting audio clock. */
  words: TimedWord[];
};
export type PendingDraft = Draft & { chunkId: string; cutMs: number };
type DisplayChunk = Pick<Chunk, 'id' | 'source' | 'startMs' | 'seconds' | 'status' | 'text'>;
/** Terminal outcomes own the entire interval, including silent or failed successors of an older preview. */
export function ownsDisplayInterval(chunk: DisplayChunk, rendered: Set<string>): boolean {
  return chunk.status === 'failed' || chunk.status === 'cancelled'
    || (chunk.status === 'completed' && (!chunk.text.trim() || rendered.has(chunk.id)));
}

/**
 * `sent`: when each feed not yet answered was sent, across windows (the worker answers every feed, in order, including feeds
 * for a window it has already replaced). `queued`: commands held until the model has loaded.
 */
type Worker = { child: ChildProcess; modelPath: string; source: string; startedAt: number; ready: boolean; queued: { window: string; message: unknown }[]; sent: number[]; idle?: NodeJS.Timeout };

export type DraftOptions = {
  modelPath: string;
  streaming?: boolean;
  workerScript?: URL;
  /** A window whose worker has a feed this old unanswered stops being fed and shows that it is behind. */
  maxBacklogMs?: number;
  /** A source's worker is closed this long after its last window ends. */
  idleCloseMs?: number;
  /** A worker with a feed unanswered this long is killed (a hung native call); checked by a timer, not by new audio. */
  hangMs?: number;
  /** A worker that has not loaded its model by then is killed. */
  loadMs?: number;
  /** At most this many feeds wait for a loading model; beyond that the window shows it is behind. */
  maxQueued?: number;
  maxSources?: number;
  log?: (message: string) => void;
};

/**
 * Best-effort live drafts: one streaming worker process per live source (a stream holds the model's lease), one stream per
 * transcription window. Nothing here can block saving audio or producing finals; on any failure the window has no draft.
 */
export class LiveDrafts {
  private options: Required<Omit<DraftOptions, 'log'>> & Pick<DraftOptions, 'log'>;
  private workers = new Map<string, Worker>();
  /** Workers being shut down: they still count against maxSources until they exit, and close() waits for them. */
  private retiring = new Set<Promise<void>>();
  private windows = new Map<string, Draft>();
  /** Display state outlives recognizer windows and source release; no cap per source. */
  private sealed = new Map<string, PendingDraft>();
  private closing = false;
  private watchdog: NodeJS.Timeout;
  constructor(options: DraftOptions) {
    this.options = { streaming: true, workerScript: new URL('./stt-stream-worker.ts', import.meta.url), maxBacklogMs: 4000, idleCloseMs: 60_000, hangMs: 10_000,
      loadMs: 30_000, maxQueued: 30, maxSources: 2, ...options };
    this.watchdog = setInterval(() => this.check(), Math.min(1000, this.options.hangMs / 2));
    this.watchdog.unref();
  }
  /** Existing windows retain their worker until the next begin for that source. */
  setModel(path: string | null, streaming: boolean) {
    this.options.modelPath = path ?? '';
    this.options.streaming = streaming;
    for (const worker of this.workers.values()) if (!this.covers(worker.source)) this.stop(worker);
  }
  /** Whether the current model can produce live previews (workers load lazily per source). */
  available(): boolean { return !this.closing && Boolean(this.options.modelPath) && this.options.streaming; }
  /** Starts a window's stream. Returns false when no draft will be made (too many live sources, or shutting down). */
  begin(meetingId: string, source: string, window: string, windowStartMs: number): boolean {
    const existing = this.workers.get(source);
    if (existing && (existing.modelPath !== this.options.modelPath || !this.options.streaming)) this.stop(existing);
    if (!this.available()) return false;
    const worker = this.worker(source);
    if (!worker) return false;
    this.windows.set(window, { meetingId, source, window, windowStartMs, text: '', words: [], behind: false, committedUntilMs: windowStartMs, coveredUntilMs: windowStartMs });
    this.send(worker, window, { kind: 'begin', window });
    return true;
  }
  /** 16 kHz mono PCM for an open window; fire and forget. */
  feed(window: string, pcm: Float32Array) {
    const draft = this.windows.get(window);
    const worker = draft && this.workers.get(draft.source);
    if (!draft || !worker || draft.behind) return;
    // Age, not amount: replaying a few seconds after a cut is a burst the worker clears in about a second.
    // Behind: stop feeding this window rather than skip over a gap; the next window starts fresh.
    if ((worker.ready && worker.sent.length && Date.now() - worker.sent[0] > this.options.maxBacklogMs)
      || (!worker.ready && worker.queued.length >= this.options.maxQueued)) { draft.behind = true; return; }
    this.send(worker, window, { kind: 'feed', window, pcm });
  }
  /** Freeze exactly the last displayed preview, then discard only the recognizer window. Late feeds cannot change this block. */
  seal(window: string, chunk: Pick<Chunk, 'id' | 'startMs' | 'seconds'>) {
    const draft = this.windows.get(window);
    if (draft) this.sealed.set(chunk.id, { ...draft, words: draft.words.map(w => ({ ...w })),
      chunkId: chunk.id, cutMs: chunk.startMs + chunk.seconds * 1000 });
    this.drop(window);
  }
  /** An abandoned recognizer window: commands still waiting for a loading model are discarded. Pending display blocks are separate. */
  drop(window: string) {
    const draft = this.windows.get(window);
    this.windows.delete(window);
    const worker = draft && this.workers.get(draft.source);
    if (!worker) return;
    worker.queued = worker.queued.filter(q => q.window !== window);
    if (![...this.windows.values()].some(w => w.source === draft!.source)) this.scheduleIdle(worker);
  }
  drafts(meetingId: string): Draft[] {
    return [...this.windows.values()].filter(w => w.meetingId === meetingId).map(d => ({ ...d, words: d.words.map(w => ({ ...w })) })).sort((a, b) => a.windowStartMs - b.windowStartMs);
  }
  /** Called with the finals in this very response: retirement and replacement are one snapshot, never two polls. */
  pending(meetingId: string, chunks: DisplayChunk[], rendered: Set<string>): PendingDraft[] {
    const byId = new Map(chunks.map(c => [c.id, c]));
    const terminal = chunks.filter(c => ownsDisplayInterval(c, rendered));
    const out: PendingDraft[] = [];
    for (const [id, pending] of this.sealed) {
      if (pending.meetingId !== meetingId) continue;
      const chunk = byId.get(id);
      if (!chunk || chunk.status === 'failed' || chunk.status === 'cancelled' || (chunk.status === 'completed' && !chunk.text.trim())) {
        this.sealed.delete(id); continue;
      }
      // Every terminal interval applies to every pending block of that source, not only its own block.
      pending.words = pending.words.filter(w => !terminal.some(c => c.source === pending.source
        && midpoint(w) >= c.startMs && midpoint(w) < c.startMs + c.seconds * 1000));
      pending.text = pending.words.map(w => w.text).join(' ');
      if (!pending.words.length && chunk.status === 'completed') { this.sealed.delete(id); continue; }
      out.push({ ...pending, words: pending.words.map(w => ({ ...w })) });
    }
    return out.sort((a, b) => a.windowStartMs - b.windowStartMs);
  }
  private retireCovered(draft: Draft) {
    for (const pending of this.sealed.values()) {
      if (pending.meetingId !== draft.meetingId || pending.source !== draft.source) continue;
      // Only the after-cut part belongs to the replay; before-cut text waits for its own final.
      pending.words = pending.words.filter(w => midpoint(w) < pending.cutMs || midpoint(w) < draft.windowStartMs || midpoint(w) >= draft.committedUntilMs);
      pending.text = pending.words.map(w => w.text).join(' ');
    }
  }
  /** The source has ended: its worker exits now instead of after the idle wait, so a new source (a re-added tab) can get a preview. */
  release(source: string) {
    for (const [id, w] of this.windows) if (w.source === source) this.windows.delete(id);
    const worker = this.workers.get(source);
    if (worker) this.stop(worker);
  }
  /** Whether a source currently has a draft stream (false: capped, failed or not started). */
  covers(source: string): boolean { return [...this.windows.values()].some(w => w.source === source); }
  async close() {
    this.closing = true;
    clearInterval(this.watchdog);
    for (const worker of [...this.workers.values()]) this.stop(worker);
    await Promise.allSettled([...this.retiring]);
  }

  /** Kills workers that hang on a native call or never finish loading. Runs on a timer, so silence cannot hide a hang. */
  private check() {
    const now = Date.now();
    for (const worker of [...this.workers.values()]) {
      const hung = worker.ready && worker.sent.length > 0 && now - worker.sent[0] > this.options.hangMs;
      const stuck = !worker.ready && now - worker.startedAt > this.options.loadMs;
      if (!hung && !stuck) continue;
      this.options.log?.(hung ? 'Live draft process stopped answering; it is restarted for the next window.' : 'Live draft model did not load in time; drafts are off for this window.');
      this.fail(worker);
      worker.child.kill('SIGKILL');
    }
  }
  /** Its windows keep whatever text they had and show they are behind; finals are unaffected. */
  private fail(worker: Worker) {
    if (this.workers.get(worker.source) === worker) this.workers.delete(worker.source);
    for (const w of this.windows.values()) if (w.source === worker.source) w.behind = true;
    this.track(worker);
  }
  private worker(source: string): Worker | undefined {
    if (this.closing) return undefined;
    const existing = this.workers.get(source);
    if (existing) { clearTimeout(existing.idle); existing.idle = undefined; return existing; }
    if (this.workers.size + this.retiring.size >= this.options.maxSources) return undefined;
    const child = fork(this.options.workerScript, [this.options.modelPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    const worker: Worker = { child, modelPath: this.options.modelPath, source, startedAt: Date.now(), ready: false, queued: [], sent: [] };
    let stderr = '';
    child.stderr?.on('data', part => { stderr = (stderr + part.toString()).slice(-2000); });
    child.on('message', (message: any) => {
      if (message.kind === 'ready') {
        worker.ready = true;
        for (const queued of worker.queued.splice(0)) this.post(worker, queued.message);
        return;
      }
      if ((message.kind === 'draft' && !message.final) || message.kind === 'ack') worker.sent.shift();
      const draft = message.window ? this.windows.get(message.window) : undefined;
      if (message.kind === 'draft' && draft && draft.source === source) {
        draft.text = message.text;
        draft.words = timedWords(message.tokens ?? [], draft.windowStartMs);
        if (typeof message.committedMs === 'number') draft.committedUntilMs = Math.max(draft.committedUntilMs, draft.windowStartMs + message.committedMs);
        // Tentative suffixes are reversible display coverage, never an irreversible retirement watermark.
        draft.coveredUntilMs = Math.max(draft.committedUntilMs, ...draft.words.map(w => w.endMs));
        this.retireCovered(draft);
      } else if (message.kind === 'error') {
        this.options.log?.(`Live draft failed: ${message.error}`);
        if (draft) draft.behind = true;
      }
    });
    child.on('error', () => {});
    child.on('exit', code => {
      if (this.workers.get(source) !== worker) return;
      if (!this.closing) this.options.log?.(`Live draft process exited (${code}). ${stderr.trim()}`.trim());
      this.fail(worker);
    });
    this.workers.set(source, worker);
    return worker;
  }
  private send(worker: Worker, window: string, message: unknown) {
    if (!worker.ready) { worker.queued.push({ window, message }); return; }
    this.post(worker, message);
  }
  private post(worker: Worker, message: any) {
    if (!worker.child.connected) return;
    if (message.kind === 'feed') worker.sent.push(Date.now()); // Ages from when the worker can actually take it.
    try { worker.child.send(message); } catch { /* exit is reported separately */ }
  }
  private scheduleIdle(worker: Worker) {
    clearTimeout(worker.idle);
    worker.idle = setTimeout(() => this.stop(worker), this.options.idleCloseMs);
    worker.idle.unref();
  }
  /** Asks the worker to exit (killed after 3 s); its slot is released only when it has exited. */
  private stop(worker: Worker) {
    if (this.workers.get(worker.source) === worker) this.workers.delete(worker.source);
    clearTimeout(worker.idle);
    const child = worker.child;
    if (child.connected) { try { child.send({ kind: 'shutdown' }); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL');
    this.track(worker);
  }
  private track(worker: Worker) {
    const child = worker.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const tracked: Promise<void> = exited.finally(() => { this.retiring.delete(tracked); });
    this.retiring.add(tracked);
  }
}
