// Bounded worker transport; raw frame persistence/dedup stays in LiveCapture/MeetingStore.
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioEnd, audioSpans, type TimedAudio } from './echo-timeline.ts';
import type { CaptureTiming } from './capture-gaps.ts';

export const ECHO_WAIT_MS = 1500;
export const ECHO_DEADLINE_MS = 2000;
export const ECHO_REFERENCE_LEAD_MS = 100;
export type EchoOptions = { leadMs?: number; waitMs?: number; deadlineMs?: number; workerScript?: URL; log?: (message: string) => void;
  clock?: () => number; // Monotonic elapsed clock, never capture UTC.
  wallClock?: () => number; // Watchdog diagnosis only: a UTC step must not permanently disable AEC.
};
const monotonic = (options: EchoOptions) => options.clock?.() ?? performance.now();
export type EchoStats = { frames: number; samples: number; missingSamples: number; computeMs: number; delayMs: number; maxDelayMs: number; failures: number };
const floats = (pcm: Buffer) => new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
type Job = { raw: Buffer; resolve: (pcm: Buffer) => void; timer: NodeJS.Timeout; at: number };
type AudioReply = { kind: 'audio'; id: string; pcm: Float32Array; missingSamples: number; computeMs: number };

class EchoSession {
  private worker: Worker | null = null;
  private jobs = new Map<string, Job>();
  private controls = new Map<number, { resolve: () => void; timer: NodeJS.Timeout }>();
  private serial = 0;
  private options: EchoOptions;
  private onFailure: (resumable: boolean) => void;
  private onAudio: (message: AudioReply, delay: number) => void;
  private finishing: Promise<void> | null = null;
  failed = false;
  constructor(options: EchoOptions, fail: (resumable: boolean) => void, audio: EchoSession['onAudio']) {
    this.options = options; this.onFailure = fail; this.onAudio = audio;
    try {
      const worker = new Worker(options.workerScript ?? new URL('./echo-worker.ts', import.meta.url), { workerData: { leadMs: options.leadMs, waitMs: options.waitMs ?? ECHO_WAIT_MS } });
      this.worker = worker;
      worker.on('message', (message: AudioReply | { kind: 'flushed'; request: number }) => {
        if (this.worker !== worker) return;
        if (message.kind === 'flushed') {
          const control = this.controls.get(message.request);
          if (control) { clearTimeout(control.timer); this.controls.delete(message.request); control.resolve(); }
        } else if (message.kind === 'audio') {
          const job = this.jobs.get(message.id);
          if (!job) return;
          if (!(message.pcm instanceof Float32Array) || message.pcm.byteLength !== job.raw.length || !message.pcm.every(Number.isFinite)) { this.failure(); return; }
          this.jobs.delete(message.id); clearTimeout(job.timer);
          this.onAudio(message, monotonic(this.options) - job.at);
          job.resolve(Buffer.from(message.pcm.buffer, message.pcm.byteOffset, message.pcm.byteLength));
        }
      });
      worker.on('error', () => this.failure());
      worker.on('exit', () => { if (this.worker === worker) this.failure(); });
    } catch { this.failure(); }
  }
  private watchdog() {
    const budget = this.options.deadlineMs ?? ECHO_DEADLINE_MS;
    const at = monotonic(this.options), wallAt = (this.options.wallClock ?? Date.now)();
    return setTimeout(() => {
      const elapsed = monotonic(this.options) - at, wallElapsed = (this.options.wallClock ?? Date.now)() - wallAt;
      // A timer serviced >3 s late after whole-process sleep is not proof of a hung worker.
      // Resolve raw now, but permit a fresh worker when timestamped capture resumes.
      this.failure(elapsed > budget + 3000 || wallElapsed < elapsed - 250);
    }, budget);
  }
  private failure(resumable = false) {
    if (this.failed) return;
    this.failed = true;
    try { this.onFailure(resumable); } catch { /* Even logging must not break raw fallback. */ }
    for (const [id, job] of this.jobs) {
      clearTimeout(job.timer);
      this.onAudio({ kind: 'audio', id, pcm: floats(job.raw), missingSamples: job.raw.length / 4, computeMs: 0 }, monotonic(this.options) - job.at);
      job.resolve(job.raw); // Unemitted samples are literal raw; never apply a prior frame's correction.
    }
    this.jobs.clear();
    for (const control of this.controls.values()) { clearTimeout(control.timer); control.resolve(); }
    this.controls.clear();
    const worker = this.worker; this.worker = null;
    worker?.terminate().catch(() => {});
  }
  private post(message: unknown) {
    if (!this.worker || this.failed) return;
    try { this.worker.postMessage(message); } catch { this.failure(); }
  }
  reference(audio: TimedAudio) { if (!this.finishing) this.post({ kind: 'reference', ...audio }); }
  referenceEnded() { this.post({ kind: 'reference-ended' }); }
  switchReference(audio: TimedAudio[]) { this.post({ kind: 'switch', audio }); }
  microphone(id: string, raw: Buffer, timing: CaptureTiming): Promise<Buffer> {
    if (this.failed || this.finishing) return Promise.resolve(raw);
    if (this.jobs.size >= 32) { this.failure(); return Promise.resolve(raw); }
    return new Promise(resolve => {
      const timer = this.watchdog();
      this.jobs.set(id, { raw, resolve, timer, at: monotonic(this.options) });
      // Node worker_threads share this monotonic time origin; do not transmit an adjustable UTC deadline.
      this.post({ kind: 'microphone', id, pcm: floats(raw), timing, receivedAt: performance.now() });
    });
  }
  flush(fadeToRaw = true): Promise<void> {
    if (this.failed || !this.worker) return Promise.resolve();
    const request = ++this.serial;
    return new Promise(resolve => {
      const timer = this.watchdog();
      this.controls.set(request, { resolve, timer });
      this.post({ kind: 'flush', request, fadeToRaw });
    });
  }
  finish(fadeToRaw = false): Promise<void> {
    return this.finishing ??= (async () => {
      await this.flush(fadeToRaw); // Worker emits every aligned tail before the acknowledgement.
      const worker = this.worker; this.worker = null;
      await worker?.terminate().catch(() => {});
    })();
  }
}

type Reference = { source: string; audio: TimedAudio[]; lastAt: number; endMs: number; ended: boolean; timed: boolean };
type MeetingReference = { pinned: string | null; sources: Map<string, Reference> };
type MicRecord = { meetingId: string; logged: boolean; disabled: boolean; missing: number };
type Entry = { meetingId: string; source: string; session: EchoSession; record: MicRecord };

export class LiveEcho {
  private references = new Map<string, MeetingReference>();
  private sessions = new Map<string, Entry>();
  private records = new Map<string, MicRecord>();
  private retiring = new Set<Promise<void>>();
  private expiry: NodeJS.Timeout | undefined;
  private totals: EchoStats = { frames: 0, samples: 0, missingSamples: 0, computeMs: 0, delayMs: 0, maxDelayMs: 0, failures: 0 };
  private options: EchoOptions;
  constructor(options: EchoOptions = {}) {
    const configured = Number(process.env.MEETING_AEC_REFERENCE_LEAD_MS ?? ECHO_REFERENCE_LEAD_MS);
    this.options = { ...options, leadMs: options.leadMs ?? (Number.isFinite(configured) && configured >= 0 && configured <= 300 ? configured : ECHO_REFERENCE_LEAD_MS) };
  }
  private now() { return monotonic(this.options); }
  private warn(record: MicRecord, reason: string) {
    if (record.logged) return;
    record.logged = true;
    try { this.options.log?.(`AEC passes raw for this recording: ${reason}.`); } catch { /* Recording must not depend on a logger. */ }
  }
  private missing(record: MicRecord, samples: number, reason: string) {
    record.missing += samples;
    if (record.missing > 10 * 16000) this.warn(record, `more than 10 s of missing/late reference (${reason})`);
  }
  private active(reference: Reference, micPosition = -Infinity) {
    return !reference.ended && reference.timed && this.now() - reference.lastAt <= 3000 && micPosition - (reference.endMs - this.options.leadMs!) <= 5000;
  }
  private select(meeting: MeetingReference, micPosition = -Infinity): Reference | undefined {
    const pinned = meeting.pinned ? meeting.sources.get(meeting.pinned) : undefined;
    if (pinned && this.active(pinned, micPosition)) return pinned;
    const next = [...meeting.sources.values()].find(reference => this.active(reference, micPosition));
    meeting.pinned = next?.source ?? null;
    return next;
  }
  private collect() {
    clearTimeout(this.expiry);
    let next = Infinity;
    for (const [id, meeting] of this.references) {
      for (const [source, reference] of meeting.sources) if (reference.ended) {
        if (this.now() - reference.lastAt >= 10000) meeting.sources.delete(source);
        else next = Math.min(next, reference.lastAt + 10000);
      }
      if (!meeting.sources.size) this.references.delete(id);
    }
    if (Number.isFinite(next)) this.expiry = setTimeout(() => this.collect(), Math.max(1, next - this.now())).unref();
  }
  private retire(mic: string, entry: Entry): void {
    this.sessions.delete(mic);
    const pending = entry.session.finish(true).catch(() => this.warn(entry.record, 'worker retirement failed; unprocessed samples pass raw')).then(() => {
      this.retiring.delete(pending);
      // Once a mic has crossed the reference end, no ended history for that meeting is useful.
      const meeting = this.references.get(entry.meetingId);
      if (meeting && ![...this.sessions.values()].some(item => item.meetingId === entry.meetingId)) {
        for (const [source, reference] of meeting.sources) if (reference.ended) meeting.sources.delete(source);
      }
      this.collect();
    });
    this.retiring.add(pending);
  }
  reference(meetingId: string, source: string, pcm: Buffer, timing?: CaptureTiming) {
    this.collect();
    let meeting = this.references.get(meetingId);
    if (!meeting) { meeting = { pinned: null, sources: new Map() }; this.references.set(meetingId, meeting); }
    let reference = meeting.sources.get(source);
    if (!reference) {
      if (meeting.sources.size >= 4) {
        const disposable = [...meeting.sources.values()].find(item => item.source !== meeting!.pinned && ![...this.sessions.values()].some(entry => entry.source === item.source));
        if (!disposable) return;
        meeting.sources.delete(disposable.source);
      }
      reference = { source, audio: [], lastAt: this.now(), endMs: -Infinity, ended: false, timed: false };
      meeting.sources.set(source, reference);
    }
    reference.lastAt = this.now(); reference.ended = false; reference.timed = Boolean(timing);
    if (!timing) {
      reference.audio = []; reference.endMs = -Infinity;
      const standby = this.select(meeting);
      for (const [mic, entry] of this.sessions) if (entry.meetingId === meetingId && entry.source === source) {
        if (standby) { entry.session.switchReference(standby.audio); entry.source = standby.source; }
        else { this.warn(entry.record, 'reference lost its capture wall clock'); this.retire(mic, entry); }
      }
      return;
    }
    const audio = { pcm: floats(pcm), timing };
    const spans = audioSpans(audio);
    if (spans.some((span, i) => span.wallMs < (i ? spans[i - 1].wallMs + spans[i - 1].pcm.length / 16 : reference.endMs) - 50)) reference.audio = [];
    reference.audio.push(audio); if (reference.audio.length > 10) reference.audio.shift();
    reference.endMs = audioEnd(audio);
    this.select(meeting);
    // Other remotes are bounded standby histories, never mixed into the pinned render stream.
    for (const entry of this.sessions.values()) if (entry.meetingId === meetingId && entry.source === source) entry.session.reference(audio);
  }
  microphone(meetingId: string, source: string, id: string, pcm: Buffer, timing?: CaptureTiming): Promise<Buffer> | null {
    this.collect();
    const meeting = this.references.get(meetingId);
    let entry = this.sessions.get(source), record = this.records.get(source);
    if (!meeting && !entry && !record) return null;
    if (!record) { record = { meetingId, logged: false, disabled: false, missing: 0 }; this.records.set(source, record); }
    const micStart = timing?.captureWallMs ?? Infinity;
    const crossesGap = timing?.discontinuities?.some(cut => cut.toWallMs > cut.fromWallMs);
    const current = entry && meeting?.sources.get(entry.source);
    const overlaps = (reference: Reference) => reference.ended && reference.timed && micStart < reference.endMs - this.options.leadMs!;
    // Preserve overlapping final render; otherwise prefer a live standby BEFORE considering retirement.
    const boundary = current?.timed && !current.ended && crossesGap && micStart - (current.endMs - this.options.leadMs!) <= 5000;
    const selected = timing && !record.disabled && meeting ? (current && overlaps(current) ? current
      : this.select(meeting, micStart) ?? (boundary ? current : [...meeting.sources.values()].find(overlaps))) : undefined;
    if (entry) {
      if (!selected || entry.session.failed) { this.retire(source, entry); entry = undefined; }
      else if (selected.source !== entry.source) {
        entry.session.switchReference(selected.audio); entry.source = selected.source;
        if (selected.ended) entry.session.referenceEnded();
      }
    }
    if (!entry && selected && timing && !record.disabled) {
      const activeRecord = record;
      const session = new EchoSession(this.options, resumable => {
        if (!resumable) activeRecord.disabled = true;
        this.totals.failures++;
        this.warn(activeRecord, resumable ? 'server paused or wall clock stepped; pending samples passed raw, AEC will retry on resumed capture' : 'worker unavailable or exceeded its bounded processing deadline');
      }, (message, delay) => {
        this.totals.frames++; this.totals.samples += message.pcm.length; this.totals.missingSamples += message.missingSamples;
        this.totals.computeMs += message.computeMs; this.totals.delayMs += delay; this.totals.maxDelayMs = Math.max(this.totals.maxDelayMs, delay);
        if ([...this.references.get(meetingId)?.sources.values() ?? []].some(item => !item.ended)) this.missing(activeRecord, message.missingSamples, 'uncovered render samples');
      });
      entry = { meetingId, source: selected.source, session, record }; this.sessions.set(source, entry);
      for (const audio of selected.audio) session.reference(audio);
      if (selected.ended) session.referenceEnded();
    }
    if (entry && timing) return entry.session.microphone(id, pcm, timing);
    const liveCall = meeting && [...meeting.sources.values()].some(item => !item.ended);
    if (liveCall) {
      const known = [...meeting.sources.values()].find(item => !item.ended);
      if (!timing) this.warn(record, 'microphone has no capture wall clock');
      if (known && (!known.timed || !this.active(known, micStart))) this.warn(record, known.timed ? 'reference is stale (>3 s without frames or >5 s behind microphone)' : 'reference has no capture wall clock');
      this.missing(record, pcm.length / 4, 'inactive reference or missing microphone clock');
    }
    return null; // Raw fallback is immediate; it must not depend on a retired worker.
  }
  async flush(source?: string) {
    const entries = source ? [this.sessions.get(source)].filter((entry): entry is Entry => Boolean(entry)) : [...this.sessions.values()];
    await Promise.all(entries.map(entry => entry.session.flush()));
    await Promise.all([...this.retiring]);
  }
  async end(meetingId: string, source: string) {
    const meeting = this.references.get(meetingId), reference = meeting?.sources.get(source);
    if (reference) {
      reference.ended = true; reference.lastAt = this.now();
      if (meeting) this.select(meeting);
      for (const entry of this.sessions.values()) if (entry.meetingId === meetingId && entry.source === source) entry.session.referenceEnded();
      this.collect(); // Retain up to 10 s for a call-overlapping FIRST microphone frame.
      return;
    }
    const entry = this.sessions.get(source);
    if (entry) this.retire(source, entry);
    await Promise.all([...this.retiring]); this.records.delete(source);
  }
  stats(): EchoStats { return { ...this.totals }; }
  buffered() { return { meetings: this.references.size, sessions: this.sessions.size, records: this.records.size, retiring: this.retiring.size,
    referenceFrames: [...this.references.values()].reduce((sum, meeting) => sum + [...meeting.sources.values()].reduce((n, ref) => n + ref.audio.length, 0), 0) }; }
  prune(existing: ReadonlySet<string>) {
    for (const meeting of this.references.keys()) if (!existing.has(meeting)) this.references.delete(meeting);
    for (const [mic, entry] of this.sessions) if (!existing.has(entry.meetingId)) this.retire(mic, entry);
    for (const [mic, record] of this.records) if (!existing.has(record.meetingId)) this.records.delete(mic);
  }
  async close() {
    await this.flush();
    await Promise.all([...this.sessions.values()].map(entry => entry.session.finish()));
    this.sessions.clear(); this.references.clear(); this.records.clear(); clearTimeout(this.expiry);
  }
}

/** Test-only CLI: no server/UI/device/tap. The packager invokes the shipped Node on this file. */
async function selfTest() {
  const worker = new Worker(new URL('./echo-worker.ts', import.meta.url), { workerData: { selfTest: true } });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AEC bundle smoke timed out.')), 10_000);
      worker.once('message', message => { clearTimeout(timer); resolve(message); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`AEC worker exited ${code} before a smoke result.`)); });
    });
    console.log(JSON.stringify(result));
  } finally { await worker.terminate(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--self-test') await selfTest();
