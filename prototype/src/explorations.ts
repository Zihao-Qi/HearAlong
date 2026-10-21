// The runtime of explorations (M7b §4): the plan pass, and later Explore further. One runs at a time across the app, after the
// meeting's own work and outside recordings and quota cooldowns. Pi runs in a process group of its own, recorded with the job
// before it starts; its streamed tool results and text are saved in the run's folder as they arrive; and a server start ends
// whatever a crash left running before anything else. What a run computes and keeps (the plans, their checks) is the caller's:
// it passes its work as a function, which gets the run's folder, its stream log and a way to run Pi within the run's limits.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPiTask, toolResultOf, type PiTaskError, type PiTaskOptions, type PiTaskResult, type ToolResult } from './pi-task.ts';
import { endGroup, endRecorded, type ProcessRecord } from '../pi-extensions/process-groups.ts';
import { RATE_LIMIT, clockTime, webRateLimited, type Cooldowns } from './quota.ts';

export type ExplorationKind = 'plan' | 'explore';
/**
 * Pi's time for a whole run: 5 min for the plan pass, 20 for Explore further (M7b §2). The run itself, preparation included
 * (e.g. the Python environment), may take `prepareMs` more. A stopped run's work gets `stopGraceMs` to end before the run ends
 * without it.
 */
export const EXPLORATION_LIMITS: Record<ExplorationKind, number> & { pollMs: number; prepareMs: number; stopGraceMs: number } = {
  plan: 5 * 60_000, explore: 20 * 60_000, pollMs: 1000, prepareMs: 10 * 60_000, stopGraceMs: 5000,
};
export type ExplorationState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'stopped' | 'interrupted';
/** Why a run ended before its end: its time limit, Cancel, a quit, the quota (it gave way to a recording), or a crash. */
export type StopReason = 'time limit' | 'cancelled' | 'quit' | 'quota' | 'crash';
export type ExplorationJob = {
  id: string; meetingId: string; kind: ExplorationKind;
  /** What it is for within its kind (a plan's id for Explore further): one waiting or running job per meeting and key. */
  key: string;
  state: ExplorationState; createdAt: number; startedAt: number | null; finishedAt: number | null; error: string | null;
  stopped: StopReason | null;
  /** Pi's time across the run; and the whole run's, from its start (enforced whatever the work does). */
  limitMs: number; runLimitMs: number;
  /** Pi's process while it runs, saved before Pi starts: a server start ends its group after a crash. */
  worker: ProcessRecord | null;
  /** The caller's own data, kept with the record (what it pinned at the start); and what its work returned. */
  data: unknown; result: unknown;
};
export type WaitingReason = { reason: string; until?: number };
export type ExplorationPiOptions = Omit<PiTaskOptions, 'signal' | 'timeoutMs' | 'processDir' | 'onStart' | 'cwd'> & { cwd?: string };
export type ExplorationContext = {
  job: Readonly<ExplorationJob>;
  /** Aborted on Cancel, a quit, or when the run gives way to a recording. */
  signal: AbortSignal;
  /** The run's own folder: its record and its stream; the caller may keep its files here too. */
  folder: string;
  /** The scratch folder Pi works in, and the meeting's session folder (provenance). */
  cwd: string; sessionDir: string;
  log: StreamLog;
  /** Runs Pi for this run: in its own recorded process group, within what is left of the run's time, its events saved to the log. */
  pi(prompt: string, options: ExplorationPiOptions): Promise<PiTaskResult>;
  /** Waits for something (a preparation, a lock) but rejects as soon as the run is stopped. */
  wait<T>(promise: Promise<T>): Promise<T>;
  /** A synchronous publication commit: cancellation wins before it; afterwards the published outcome wins. */
  commit<T>(write: () => T): T;
};
export type ExplorationWork = (context: ExplorationContext) => Promise<unknown>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
async function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

export const STREAM_LIMITS = { textBytes: 200_000, eventBytes: 500_000, eventsBytes: 8_000_000 };
export type StreamEvent = { seq: number; at: number; type: string; [field: string]: unknown };
export type StreamState = {
  state: 'streaming' | 'complete' | 'stopped'; reason: string | null; at: number;
  textBytes: number; textCut: boolean; events: number; eventsDropped: number;
  /** The first write that failed; nothing after it was written, so what was saved stays in order. */
  error: string | null;
};
export type SavedStream = { text: string; events: StreamEvent[]; state: StreamState };

/**
 * One event as a saved line (newline included) of at most STREAM_LIMITS.eventBytes, measured as written: JSON escaping can make a
 * text several times longer (a newline becomes two bytes, a control character six). Its details go first, then its structured
 * data, then its text and arguments are shortened until the line fits; at worst only its identity is kept.
 */
function fitted(event: StreamEvent): string {
  const max = STREAM_LIMITS.eventBytes;
  const fits = (value: unknown) => { const line = `${JSON.stringify(value)}\n`; return Buffer.byteLength(line) <= max ? line : null; };
  const { details: _details, ...lighter } = event;
  const whole = fits(event) ?? fits({ ...lighter, cut: true });
  if (whole) return whole;
  const { structured: _structured, args, text, ...bare } = lighter;
  const short = (value: string, chars: number) => value.length > chars ? value.slice(0, chars).replace(/[\uD800-\uDBFF]$/, '') : value;
  const textAll = String(text ?? ''), argsAll = JSON.stringify(args ?? null);
  for (let chars = max / 2; chars >= 1000; chars = Math.floor(chars / 2)) {
    const line = fits({ ...bare, args: argsAll.length > 20_000 ? short(argsAll, Math.min(20_000, chars)) : args, text: short(textAll, chars), cut: true });
    if (line) return line;
  }
  const { seq, at, type, id, name, isError } = event;
  return `${JSON.stringify({ seq, at, type, id, name, isError, cut: true })}\n`;
}

/**
 * What a run has streamed, saved in its folder as it arrives (M7b §2, "While it streams"): the model's text so far in `text.md`
 * (at most 200 KB), and events (finished tool calls with their arguments and results) one per line in `events.jsonl`. Writes
 * are appended in order, one chain per log, so a crash loses at most what was still queued; a torn last line is skipped on
 * reading. `stream.json` says whether the run completed or stopped; one still "streaming" after its server is gone was cut
 * off by a crash.
 */
export class StreamLog {
  readonly folder: string;
  private clock: () => number;
  private chain: Promise<void> = Promise.resolve();
  private pendingText = '';
  private pendingEvents: string[] = [];
  private scheduled = false;
  /** What is on disk: the counts grow only once a write succeeded. */
  private status: StreamState;
  /** What was accepted (for the bounds), saved or still queued; and whether complete() or stop() was called. */
  private textAccepted = 0;
  private eventsBytes = 0;
  private ending = false;
  private seq = 0;
  private starts = new Map<string, unknown>();
  private breakBeforeText = false;
  constructor(folder: string, clock: () => number = Date.now) {
    this.folder = folder;
    this.clock = clock;
    this.status = { state: 'streaming', reason: null, at: clock(), textBytes: 0, textCut: false, events: 0, eventsDropped: 0, error: null };
  }
  get state(): Readonly<StreamState> { return this.status; }
  /** Creates the folder and records that the run is streaming. */
  async open() {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.folder, 'stream.json'), JSON.stringify(this.status));
  }
  appendText(text: string) {
    if (!text || this.ending) return;
    const room = STREAM_LIMITS.textBytes - this.textAccepted;
    let part = text;
    if (Buffer.byteLength(part) > room) {
      part = Buffer.from(part).subarray(0, Math.max(0, room)).toString('utf8').replace(/�+$/, '');
      this.status.textCut = true;
    }
    if (!part) return;
    this.textAccepted += Buffer.byteLength(part);
    this.pendingText += part;
    this.schedule();
  }
  /** Saves one event in order, numbered; returns it, or null once the log is finished or full. */
  appendEvent(event: { type: string } & Record<string, unknown>): StreamEvent | null {
    if (this.ending) return null;
    const saved: StreamEvent = { ...event, seq: this.seq + 1, at: this.clock() };
    const line = fitted(saved);
    const bytes = Buffer.byteLength(line);
    // Checked again as it will be written: one line within its bound, and the file within its own.
    if (bytes > STREAM_LIMITS.eventBytes || this.eventsBytes + bytes > STREAM_LIMITS.eventsBytes) { this.status.eventsDropped++; return null; }
    this.seq++;
    this.eventsBytes += bytes;
    this.pendingEvents.push(line);
    this.schedule();
    return saved;
  }
  /**
   * Takes Pi's JSON events: a finished tool call (paired with its arguments) becomes a `tool` event, and the assistant's text
   * deltas the text, a blank line between messages. Returns the finished tool call, if this was one.
   */
  piEvent(event: any): ToolResult | null {
    if (event?.type === 'message_start' && event.message?.role === 'assistant') this.breakBeforeText = this.textAccepted > 0;
    else if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = String(event.assistantMessageEvent.delta ?? '');
      if (delta && this.breakBeforeText) { this.breakBeforeText = false; this.appendText('\n\n'); }
      this.appendText(delta);
    } else if (event?.type === 'tool_execution_start') this.starts.set(String(event.toolCallId), event.args);
    else if (event?.type === 'tool_execution_end') {
      const result = toolResultOf(event, this.starts.get(String(event.toolCallId)));
      this.appendEvent({ type: 'tool', ...result });
      return result;
    }
    return null;
  }
  /** Resolves once everything appended so far is written (or a write failed: see `state.error`). */
  flush() { return this.chain; }
  complete() { return this.finish('complete', null); }
  stop(reason: string) { return this.finish('stopped', reason); }
  /** Reads back what was saved, after the writes queued so far. */
  async read(): Promise<SavedStream> { await this.flush(); return StreamLog.read(this.folder); }
  static async read(folder: string): Promise<SavedStream> {
    const text = await readFile(join(folder, 'text.md'), 'utf8').catch(() => '');
    const lines = (await readFile(join(folder, 'events.jsonl'), 'utf8').catch(() => '')).split('\n');
    const events = lines.flatMap(line => { try { return line ? [JSON.parse(line) as StreamEvent] : []; } catch { return []; } });
    let state: StreamState;
    try { state = JSON.parse(await readFile(join(folder, 'stream.json'), 'utf8')); }
    catch { state = { state: 'stopped', reason: 'crash', at: 0, textBytes: Buffer.byteLength(text), textCut: false, events: events.length, eventsDropped: 0, error: null }; }
    return { text, events, state };
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.chain = this.chain.then(async () => {
      this.scheduled = false;
      const text = this.pendingText, lines = this.pendingEvents;
      this.pendingText = '';
      this.pendingEvents = [];
      if (this.status.error) return;
      try {
        if (text) { await appendFile(join(this.folder, 'text.md'), text, { mode: 0o600 }); this.status.textBytes += Buffer.byteLength(text); }
        if (lines.length) { await appendFile(join(this.folder, 'events.jsonl'), lines.join(''), { mode: 0o600 }); this.status.events += lines.length; }
      } catch (error) { this.status.error = `Could not save the run's progress: ${(error as Error).message}`; }
    });
  }
  private finish(state: 'complete' | 'stopped', reason: string | null) {
    if (this.ending) return this.chain;
    this.ending = true;
    // Written after every queued append has run, so it says what is really on disk (counts, and any error on the way).
    this.chain = this.chain.then(() => {
      Object.assign(this.status, { state, reason, at: this.clock() });
      return writeAtomic(join(this.folder, 'stream.json'), JSON.stringify(this.status));
    }).catch(error => {
      this.status.error ??= `Could not save the run's state: ${(error as Error).message}`;
    });
    return this.chain;
  }
}

/** A run's own folder: its record, its stream and what its work keeps (data/explorations/<meeting>/<run>). */
export const folderOf = (directory: string, meetingId: string, id: string) => join(directory, 'explorations', meetingId, id);
async function savedJobs(directory: string): Promise<ExplorationJob[]> {
  const jobs: ExplorationJob[] = [];
  const root = join(directory, 'explorations');
  for (const meetingId of await readdir(root).catch(() => [] as string[])) {
    for (const id of await readdir(join(root, meetingId)).catch(() => [] as string[])) {
      try { jobs.push(JSON.parse(await readFile(join(root, meetingId, id, 'job.json'), 'utf8'))); } catch { /* a damaged record is skipped */ }
    }
  }
  return jobs;
}
/**
 * At a server start, before anything else: ends the Pi group of every run recorded as running (if it is still the recorded
 * process) and every group recorded in its process folder, then marks the run interrupted. Its saved stream stays, marked as
 * cut off by a crash. Safe to call again: a finished record is left as it is.
 */
export async function recoverExplorations(directory: string, clock: () => number = Date.now): Promise<{ ended: number; interrupted: number }> {
  const unfinished = (await savedJobs(directory)).filter(job => job.state === 'waiting' || job.state === 'running');
  let ended = 0;
  for (const job of unfinished) {
    if (job.state !== 'running' || !job.worker) continue;
    try { if (await endGroup(job.worker)) ended++; } catch (error) { console.warn(`Could not end a leftover plan run: ${(error as Error).message}`); }
  }
  for (const job of unfinished) {
    try { ended += (await endRecorded(join(directory, 'processes', job.id))).ended; } catch (error) { console.warn(`Could not end a leftover calculation: ${(error as Error).message}`); }
  }
  for (const job of unfinished) {
    const folder = folderOf(directory, job.meetingId, job.id);
    const ran = job.state === 'running';
    Object.assign(job, { state: 'interrupted', stopped: 'crash', worker: null, finishedAt: clock(),
      error: ran ? 'The app stopped before this run finished.' : 'The app stopped before this run started.' });
    await writeAtomic(join(folder, 'job.json'), JSON.stringify(job)).catch(() => {});
    const stream = (await StreamLog.read(folder)).state;
    if (ran && stream.state === 'streaming') await writeAtomic(join(folder, 'stream.json'), JSON.stringify({ ...stream, state: 'stopped', reason: 'crash', at: clock() })).catch(() => {});
  }
  return { ended, interrupted: unfinished.length };
}

type Active = { id: string; controller: AbortController; log: StreamLog; done: Promise<void>; committed?: boolean };
const duration = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
const STOPPED_ERROR: Record<StopReason, (job: ExplorationJob) => string> = {
  'time limit': job => `Stopped at the time limit (${duration(job.limitMs)}).`,
  cancelled: () => 'Cancelled.',
  quit: () => 'The app closed before this run finished.',
  quota: () => "Stopped to leave the model's quota to the recording.",
  crash: () => 'The app stopped before this run finished.',
};

/**
 * Every exploration of the server. Records are written in order (one chain per job) and a job waits for admission only once
 * its record is saved. At most one runs at a time; a waiting job says what it waits for. After a restart unfinished jobs are
 * interrupted and never started again by themselves (Plan again starts a new run, §4 "Versions").
 */
export class Explorations {
  private jobs = new Map<string, ExplorationJob>();
  private work = new Map<string, ExplorationWork>();
  private queue: string[] = [];
  private active: Active | null = null;
  private writes = new Map<string, Promise<void>>();
  private poll: NodeJS.Timeout | undefined;
  private closing = false;
  private unsubscribe: () => void;
  private options: {
    directory: string; clock: () => number; cooldowns: Cooldowns;
    /** A recording or replay running anywhere in the app, in words ('the recording to end'); nothing starts meanwhile. */
    recording?: () => string | null;
    /** The meeting's own work running or waiting, in words ('the notes'): it goes first. */
    meetingWork?: (meetingId: string) => string | null;
    /** Pi itself; tests give a stand-in that runs a fake Pi. */
    runPi?: typeof runPiTask;
    /** Whether a run will have web tools; local-only work ignores a web-service cooldown. */
    usesWeb?: (job: ExplorationJob) => boolean;
    /** Told once a job has ended and its record is saved (a deferred automatic attempt may go then). */
    onEnd?: (job: Readonly<ExplorationJob>) => void;
  };
  constructor(options: Explorations['options']) {
    this.options = options;
    // A rate-limit error of another sol job during a recording: the exploration is the first to give way (§4).
    this.unsubscribe = options.cooldowns.onHit((kind, from) => {
      if (kind === 'model' && this.active && from !== this.active.id && options.recording?.()) this.active.controller.abort('quota');
    });
  }
  private folder(job: ExplorationJob) { return folderOf(this.options.directory, job.meetingId, job.id); }
  /** Saves a snapshot of the job; writes for one job are chained, so an older state can never overwrite a newer one. */
  private persist(job: ExplorationJob): Promise<void> {
    const snapshot = JSON.stringify(job);
    const write = (this.writes.get(job.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.folder(job), { recursive: true, mode: 0o700 });
      await writeAtomic(join(this.folder(job), 'job.json'), snapshot);
    });
    this.writes.set(job.id, write);
    return write;
  }
  /** Ends what a crash left running (recoverExplorations) and loads the saved jobs. */
  async load() {
    await recoverExplorations(this.options.directory, this.options.clock);
    for (const job of await savedJobs(this.options.directory)) if (!this.jobs.has(job.id)) this.jobs.set(job.id, job);
  }

  /** Waiting or running for this meeting: a move waits for it, and so does the idle stop. */
  busy(meetingId: string) {
    return [...this.jobs.values()].some(j => j.meetingId === meetingId && (j.state === 'waiting' || j.state === 'running'));
  }
  get(id: string) { return this.jobs.get(id); }
  /** A meeting's jobs, newest first; a waiting one says what it waits for. */
  list(meetingId: string) {
    return [...this.jobs.values()].filter(j => j.meetingId === meetingId).sort((a, b) => b.createdAt - a.createdAt)
      .map(job => ({ ...job, waiting: job.state === 'waiting' ? this.waitingFor(job) : null }));
  }
  /** What the run streamed so far (or before it stopped). */
  async stream(id: string): Promise<SavedStream> {
    const job = this.jobs.get(id);
    if (!job) throw fail(404, 'No such run.');
    if (this.active?.id === id) return this.active.log.read();
    const saved = await StreamLog.read(this.folder(job));
    // Streaming, but not running here: its server stopped without saying so.
    if (saved.state.state === 'streaming') saved.state = { ...saved.state, state: 'stopped', reason: 'crash' };
    return saved;
  }
  /**
   * What a waiting job waits for, the most lasting first: a recording, the meeting's own work, the model's quota, another run.
   * Null when it may start.
   */
  waitingFor(job: ExplorationJob): WaitingReason | null {
    const recording = this.options.recording?.();
    if (recording) return { reason: `Waiting for ${recording}` };
    const own = this.options.meetingWork?.(job.meetingId);
    if (own) return { reason: `Waiting for ${own}` };
    const until = this.options.cooldowns.pausedUntil('model');
    if (until) return { reason: `Waiting for the model's quota, until ${clockTime(until)}`, until };
    const webUntil = this.options.usesWeb?.(job) ? this.options.cooldowns.pausedUntil('web') : null;
    if (webUntil) return { reason: `Waiting for the web tools, until ${clockTime(webUntil)}`, until: webUntil };
    if (this.active && this.active.id !== job.id) return { reason: 'Waiting for another plan run to finish' };
    return null;
  }

  /** Saves a new job and lets it wait for admission. Refused while the same kind and key waits or runs for the meeting. */
  async submit(meetingId: string, request: { kind: ExplorationKind; work: ExplorationWork; key?: string; limitMs?: number; runLimitMs?: number; data?: unknown }) {
    if (this.closing) throw fail(503, 'The server is closing.');
    if (!/^[\w-]{1,64}$/.test(meetingId)) throw fail(400, 'Unknown meeting.');
    const key = request.key ?? request.kind;
    if ([...this.jobs.values()].some(j => j.meetingId === meetingId && j.kind === request.kind && j.key === key && (j.state === 'waiting' || j.state === 'running'))) {
      throw fail(409, request.kind === 'plan' ? 'Plans are already being made for this meeting.' : 'This plan is already being explored.');
    }
    const limitMs = request.limitMs ?? EXPLORATION_LIMITS[request.kind];
    const job: ExplorationJob = {
      id: randomUUID(), meetingId, kind: request.kind, key, state: 'waiting', createdAt: this.options.clock(), startedAt: null, finishedAt: null,
      error: null, stopped: null, limitMs, runLimitMs: request.runLimitMs ?? limitMs + EXPLORATION_LIMITS.prepareMs, worker: null, data: request.data ?? null, result: null,
    };
    this.jobs.set(job.id, job); // counted by busy() from here on
    this.work.set(job.id, request.work);
    try { await this.persist(job); }
    catch (error) { this.jobs.delete(job.id); this.work.delete(job.id); throw fail(500, `Could not save the run: ${(error as Error).message}`); }
    if (this.closing || job.state !== 'waiting') return job;
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  /** Cancel: a waiting job never starts; a running one is stopped (its process groups ended), keeping what it saved. */
  async cancel(meetingId: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.meetingId !== meetingId) throw fail(404, 'No such run.');
    if (job.state === 'waiting') {
      this.queue = this.queue.filter(q => q !== id);
      this.work.delete(id);
      Object.assign(job, { state: 'cancelled', stopped: 'cancelled', finishedAt: this.options.clock(), error: STOPPED_ERROR.cancelled(job) });
      await this.persist(job);
      this.ended(job);
    } else if (job.state === 'running' && this.active?.id === id && !this.active.committed) this.active.controller.abort('cancelled');
    return job;
  }

  /** Starts the first waiting job that may start; while any waits, looks again every second (recordings and notes end by themselves). */
  private pump() {
    if (this.poll) { clearTimeout(this.poll); this.poll = undefined; }
    if (this.closing) return;
    this.queue = this.queue.filter(id => this.jobs.get(id)?.state === 'waiting');
    if (this.active) return; // pumped again when it ends
    const id = this.queue.find(id => !this.waitingFor(this.jobs.get(id)!));
    if (id) {
      this.queue = this.queue.filter(q => q !== id);
      const job = this.jobs.get(id)!;
      const work = this.work.get(id)!;
      const controller = new AbortController();
      const active: Active = { id, controller, log: new StreamLog(this.folder(job), this.options.clock), done: Promise.resolve() };
      this.active = active;
      Object.assign(job, { state: 'running', startedAt: this.options.clock() });
      active.done = this.run(job, work, active).finally(() => { this.active = null; this.work.delete(id); this.pump(); });
      return;
    }
    if (this.queue.length) {
      this.poll = setTimeout(() => this.pump(), EXPLORATION_LIMITS.pollMs);
      this.poll.unref();
    }
  }

  private async run(job: ExplorationJob, work: ExplorationWork, active: Active) {
    const { controller, log } = active;
    const directory = this.options.directory;
    const cwd = join(directory, 'scratch', 'explore', job.meetingId, job.id);
    const sessionDir = join(directory, 'sessions', job.meetingId);
    const processDir = join(directory, 'processes', job.id);
    const runPi = this.options.runPi ?? runPiTask;
    // Pi's time is counted from its first start, so preparing (e.g. the Python environment) is not; the run's own limit,
    // counted from now, holds whatever the work does.
    let deadline: number | null = null;
    let timedOut = false;
    let runExpired = false;
    // Set once the run has ended: from then on its abandoned work (if it ignored the stop) can start or save nothing.
    let finished = false;
    const runTimer = setTimeout(() => { runExpired = true; controller.abort('time limit'); }, job.runLimitMs);
    runTimer.unref();
    const stoppedWait = new Promise<never>((_, reject) => {
      const stop = () => { if (!active.committed) reject(Object.assign(new Error('The run was stopped.'), { reason: 'cancelled' })); };
      if (controller.signal.aborted) stop(); else controller.signal.addEventListener('abort', stop, { once: true });
    });
    stoppedWait.catch(() => {});
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, stoppedWait]);
    const pi = async (prompt: string, options: ExplorationPiOptions) => {
      if (controller.signal.aborted) throw Object.assign(new Error('Pi task was cancelled.'), { reason: 'cancelled' });
      deadline ??= performance.now() + job.limitMs;
      const left = Math.round(deadline - performance.now());
      if (left <= 0) { timedOut = true; throw Object.assign(new Error('The run has used its time.'), { reason: 'timeout' }); }
      try {
        const result = await runPi(prompt, {
          ...options, cwd: options.cwd ?? cwd, sessionDir: options.sessionDir ?? sessionDir, signal: controller.signal, timeoutMs: left, processDir,
          // Ownership is on disk before Pi does anything: a crash from here on is cleaned up at the next start.
          onStart: async worker => {
            if (finished || controller.signal.aborted) throw new Error('The run has ended.');
            job.worker = worker;
            await this.persist(job);
          },
          onEvent: event => {
            const tool = log.piEvent(event);
            if (tool && webRateLimited(tool)) this.options.cooldowns.hit('web', job.id);
            options.onEvent?.(event);
          },
        });
        if (result.errorMessage && RATE_LIMIT.test(result.errorMessage)) this.options.cooldowns.hit('model', job.id);
        return result;
      } catch (error) {
        if ((error as PiTaskError).reason === 'timeout') timedOut = true;
        else if (!controller.signal.aborted && RATE_LIMIT.test((error as Error).message)) this.options.cooldowns.hit('model', job.id);
        throw error;
      } finally {
        if (job.worker && !finished) { job.worker = null; void this.persist(job).catch(() => {}); }
      }
    };
    let result: unknown = null;
    let failure: Error | null = null;
    try {
      await this.persist(job);
      await log.open();
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const commit = <T>(write: () => T): T => {
        if (finished) throw new Error('The run has ended.');
        controller.signal.throwIfAborted();
        // No await between the abort check, the filesystem commit and recording that publication won.
        const value = write();
        active.committed = true;
        return value;
      };
      const working = work({ job, signal: controller.signal, folder: this.folder(job), cwd, sessionDir, log, pi, wait, commit });
      try { result = await wait(working); }
      catch (error) {
        failure = error as Error;
        // Stopped: the work gets a moment to end (its Pi call stops by itself); then the run ends without it.
        if (controller.signal.aborted) await Promise.race([working.catch(() => {}), new Promise(resolve => setTimeout(resolve, EXPLORATION_LIMITS.stopGraceMs))]);
      }
    } catch (error) { failure = error as Error; }
    finished = true;
    clearTimeout(runTimer);
    // Whatever the run still owns is ended, whether or not its work handled the stop: Pi's group and every recorded script group.
    try {
      if (job.worker) await endGroup(job.worker);
      await endRecorded(processDir, undefined, { keepUnverified: true });
    } catch (error) { console.warn(`A plan run's processes could not be ended now (a server start will): ${(error as Error).message}`); }
    await rm(cwd, { recursive: true, force: true }).catch(error => console.warn(`A plan run's scratch folder could not be removed: ${(error as Error).message}`));
    // Publication is irreversible: a stop before its synchronous commit prevents it; a stop after it cannot cancel it.
    const why: StopReason | null = active.committed ? null : controller.signal.aborted ? controller.signal.reason as StopReason : timedOut ? 'time limit' : null;
    const state: ExplorationState = why === 'cancelled' ? 'cancelled' : why === 'quit' ? 'interrupted' : why ? 'stopped' : failure ? 'failed' : 'done';
    if (why) await log.stop(why);
    else if (failure) await log.stop('failed');
    else await log.complete();
    const final: Partial<ExplorationJob> = {
      state, stopped: why, worker: null, finishedAt: this.options.clock(), result: result ?? null,
      error: runExpired && !active.committed ? `Stopped at the run's time limit (${duration(job.runLimitMs)}).` : why ? STOPPED_ERROR[why](job) : failure ? failure.message.slice(0, 500) : null,
    };
    try { await this.persist({ ...job, ...final }); Object.assign(job, final); }
    catch (error) {
      Object.assign(job, { ...final, state: 'failed', error: `The run could not be saved: ${(error as Error).message}` });
      await this.persist(job).catch(() => {});
    }
    if (!this.closing) this.ended(job);
  }
  private ended(job: ExplorationJob) {
    try { this.options.onEnd?.(job); } catch (error) { console.warn(`After a plan run: ${(error as Error).message}`); }
  }

  /** Stops admission; a waiting job is interrupted, a running one stopped (its groups ended, what it saved kept). Waits for every write. */
  async close() {
    this.closing = true;
    if (this.poll) clearTimeout(this.poll);
    this.unsubscribe();
    for (const job of this.jobs.values()) {
      if (job.state !== 'waiting') continue;
      Object.assign(job, { state: 'interrupted', stopped: 'quit', finishedAt: this.options.clock(), error: 'The app closed before this run started.' });
      void this.persist(job).catch(() => {});
    }
    this.queue = [];
    if (this.active) { this.active.controller.abort('quit'); await this.active.done; }
    await Promise.allSettled([...this.writes.values()]);
  }
}
