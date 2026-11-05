// Bounded worker transport; raw frame persistence/dedup stays in LiveCapture/MeetingStore.
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioEnd, audioSpans, type TimedAudio } from './echo-timeline.ts';
import type { CaptureTiming } from './capture-gaps.ts';

export const ECHO_WAIT_MS = 1500;
export const ECHO_DEADLINE_MS = 2000;
export const ECHO_REFERENCE_LEAD_MS = 100;
export type EchoOptions = { leadMs?: number; waitMs?: number; deadlineMs?: number; workerScript?: URL; log?: (message: string) => void; clock?: () => number };
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
  private lastDelta = 0;
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
          this.lastDelta = message.pcm.at(-1)! - job.raw.readFloatLE(job.raw.length - 4);
          this.onAudio(message, performance.now() - job.at);
          job.resolve(Buffer.from(message.pcm.buffer, message.pcm.byteOffset, message.pcm.byteLength));
        }
      });
      worker.on('error', () => this.failure());
      worker.on('exit', () => { if (this.worker === worker) this.failure(); });
    } catch { this.failure(); }
  }
  /** A crashed worker cannot supply new clean samples. Decay only its last same-position correction,
   * over <=5 ms of current raw input (never replay/hold earlier microphone samples).
   */
  fallback(raw: Buffer): Buffer {
    const delta = this.lastDelta; this.lastDelta = 0;
    if (!delta) return raw;
    const pcm = floats(raw), count = Math.min(80, pcm.length);
    for (let i = 0; i < count; i++) pcm[i] += delta * (1 - (i + 1) / count);
    return Buffer.from(pcm.buffer);
  }
  private watchdog() {
    const budget = this.options.deadlineMs ?? ECHO_DEADLINE_MS;
    const at = this.options.clock?.() ?? Date.now();
    return setTimeout(() => {
      const elapsed = (this.options.clock?.() ?? Date.now()) - at;
      // A timer serviced >3 s late after whole-process sleep is not proof of a hung worker.
      // Resolve raw now, but permit a fresh worker when timestamped capture resumes.
      this.failure(elapsed > budget + 3000);
    }, budget);
  }
  private failure(resumable = false) {
    if (this.failed) return;
    this.failed = true;
    try { this.onFailure(resumable); } catch { /* Even logging must not break raw fallback. */ }
    for (const [id, job] of this.jobs) {
      clearTimeout(job.timer);
      this.onAudio({ kind: 'audio', id, pcm: floats(job.raw), missingSamples: job.raw.length / 4, computeMs: 0 }, performance.now() - job.at);
      job.resolve(this.fallback(job.raw));
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
    if (this.failed || this.finishing) return Promise.resolve(this.fallback(raw));
    if (this.jobs.size >= 32) { this.failure(); return Promise.resolve(this.fallback(raw)); }
    return new Promise(resolve => {
      const timer = this.watchdog();
      this.jobs.set(id, { raw, resolve, timer, at: performance.now() });
      this.post({ kind: 'microphone', id, pcm: floats(raw), timing, receivedAt: Date.now() });
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
type MicRecord = { meetingId: string; logged: boolean; disabled: boolean; missing: number; retiring: Promise<EchoSession> | null };
type Entry = { meetingId: string; source: string; session: EchoSession; record: MicRecord };

export class LiveEcho {
  private references = new Map<string, MeetingReference>();
  private sessions = new Map<string, Entry>();
  private records = new Map<string, MicRecord>();
  private retiring = new Set<Promise<EchoSession>>();
  private totals: EchoStats = { frames: 0, samples: 0, missingSamples: 0, computeMs: 0, delayMs: 0, maxDelayMs: 0, failures: 0 };
  private options: EchoOptions;
  constructor(options: EchoOptions = {}) {
    const configured = Number(process.env.MEETING_AEC_REFERENCE_LEAD_MS ?? ECHO_REFERENCE_LEAD_MS);
    this.options = { ...options, leadMs: options.leadMs ?? (Number.isFinite(configured) && configured >= 0 && configured <= 300 ? configured : ECHO_REFERENCE_LEAD_MS) };
  }
  private now() { return this.options.clock?.() ?? Date.now(); }
  private warn(record: MicRecord, reason: string) {
    if (record.logged) return;
    record.logged = true;
    try { this.options.log?.(`AEC passes raw for this recording: ${reason}.`); } catch { /* Recording must not depend on a logger. */ }
  }
  private missing(record: MicRecord, samples: number, reason: string) {
    record.missing += samples;
    if (record.missing > 10 * 16000) this.warn(record, `more than 10 s of missing/late reference (${reason})`);
  }
  private active(reference: Reference, micEnd = -Infinity) {
    return !reference.ended && reference.timed && this.now() - reference.lastAt <= 3000 && micEnd - (reference.endMs - this.options.leadMs!) <= 5000;
  }
  private select(meeting: MeetingReference, micEnd = -Infinity): Reference | undefined {
    const pinned = meeting.pinned ? meeting.sources.get(meeting.pinned) : undefined;
    if (pinned && this.active(pinned, micEnd)) return pinned;
    const next = [...meeting.sources.values()].find(reference => this.active(reference, micEnd));
    meeting.pinned = next?.source ?? null;
    return next;
  }
  private retire(mic: string, entry: Entry): void {
    if (this.sessions.get(mic) === entry) this.sessions.delete(mic);
    const pending = entry.session.finish(true).catch(() => this.warn(entry.record, 'worker retirement failed; unprocessed samples pass raw')).then(() => entry.session);
    entry.record.retiring = pending; this.retiring.add(pending);
    pending.finally(() => { this.retiring.delete(pending); }).catch(() => {});
  }
  reference(meetingId: string, source: string, pcm: Buffer, timing?: CaptureTiming) {
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
      for (const [mic, entry] of this.sessions) if (entry.meetingId === meetingId && entry.source === source) {
        this.warn(entry.record, 'reference lost its capture wall clock'); this.retire(mic, entry);
      }
      if (meeting.pinned === source) meeting.pinned = null;
      return;
    }
    const audio = { pcm: floats(pcm), timing };
    reference.audio.push(audio); if (reference.audio.length > 10) reference.audio.shift();
    reference.endMs = Math.max(...reference.audio.map(audioEnd));
    this.select(meeting);
    // Other remotes are bounded standby histories, never mixed into the pinned render stream.
    for (const entry of this.sessions.values()) if (entry.meetingId === meetingId && entry.source === source) entry.session.reference(audio);
  }
  microphone(meetingId: string, source: string, id: string, pcm: Buffer, timing?: CaptureTiming): Promise<Buffer> | null {
    const meeting = this.references.get(meetingId);
    let entry = this.sessions.get(source), record = this.records.get(source);
    if (!meeting && !entry && !record) return null;
    if (!record) { record = { meetingId, logged: false, disabled: false, missing: 0, retiring: null }; this.records.set(source, record); }
    const micEnd = timing ? audioEnd({ pcm: floats(pcm), timing }) : Infinity;
    const micStart = timing ? audioSpans({ pcm: floats(pcm), timing })[0]?.wallMs ?? Infinity : Infinity;
    const selected = meeting ? this.select(meeting, micEnd) : undefined;
    if (entry) {
      const current = meeting?.sources.get(entry.source);
      // A call's buffered final second is still useful after its /end, including when a standby exists.
      const finalReference = current?.ended && micStart < current.endMs - this.options.leadMs!;
      if (!timing || record.disabled || entry.session.failed || !current || (!finalReference && !this.active(current, micEnd))) {
        if (current && !current.ended && timing) this.warn(record, current.timed ? 'reference is stale (>3 s without frames or >5 s behind microphone)' : 'reference has no capture wall clock');
        this.retire(source, entry); entry = undefined;
      } else if (!finalReference && selected && selected.source !== entry.source) {
        entry.session.switchReference(selected.audio); entry.source = selected.source;
      }
    }
    if (!entry && selected && timing && !record.disabled) {
      const activeRecord = record;
      const session = new EchoSession(this.options, resumable => {
        if (!resumable) activeRecord.disabled = true;
        this.totals.failures++;
        this.warn(activeRecord, resumable ? 'server paused; pending samples passed raw, AEC will retry on resumed capture' : 'worker unavailable or exceeded its bounded processing deadline');
      }, (message, delay) => {
        this.totals.frames++; this.totals.samples += message.pcm.length; this.totals.missingSamples += message.missingSamples;
        this.totals.computeMs += message.computeMs; this.totals.delayMs += delay; this.totals.maxDelayMs = Math.max(this.totals.maxDelayMs, delay);
        if ([...this.references.get(meetingId)?.sources.values() ?? []].some(item => !item.ended)) this.missing(activeRecord, message.missingSamples, 'uncovered render samples');
      });
      entry = { meetingId, source: selected.source, session, record }; this.sessions.set(source, entry);
      for (const audio of selected.audio) session.reference(audio);
    }
    if (entry && timing) return entry.session.microphone(id, pcm, timing);
    const liveCall = meeting && [...meeting.sources.values()].some(item => !item.ended);
    if (liveCall) {
      const known = [...meeting.sources.values()].find(item => !item.ended);
      if (!timing) this.warn(record, 'microphone has no capture wall clock');
      if (known && (!known.timed || !this.active(known, micEnd))) this.warn(record, known.timed ? 'reference is stale (>3 s without frames or >5 s behind microphone)' : 'reference has no capture wall clock');
      this.missing(record, pcm.length / 4, 'inactive reference or missing microphone clock');
    }
    return record.retiring ? record.retiring.then(session => session.fallback(pcm)) : null;
  }
  async flush(source?: string) {
    const entries = source ? [this.sessions.get(source)].filter((entry): entry is Entry => Boolean(entry)) : [...this.sessions.values()];
    await Promise.all(entries.map(entry => entry.session.flush()));
    if (source) await this.records.get(source)?.retiring;
  }
  async end(meetingId: string, source: string) {
    const meeting = this.references.get(meetingId), reference = meeting?.sources.get(source);
    if (reference) {
      reference.ended = true;
      if (meeting) this.select(meeting);
      for (const entry of this.sessions.values()) if (entry.meetingId === meetingId && entry.source === source) entry.session.referenceEnded();
      if (meeting && [...meeting.sources.values()].every(item => item.ended) && ![...this.sessions.values()].some(entry => entry.meetingId === meetingId)) this.references.delete(meetingId);
      return;
    }
    const entry = this.sessions.get(source);
    if (entry) { this.sessions.delete(source); await entry.session.finish(); }
    await this.records.get(source)?.retiring; this.records.delete(source);
    if (meeting && [...meeting.sources.values()].every(item => item.ended) && ![...this.sessions.values()].some(item => item.meetingId === meetingId)) this.references.delete(meetingId);
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
    await Promise.all([...this.retiring]);
    this.sessions.clear(); this.references.clear(); this.records.clear();
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
