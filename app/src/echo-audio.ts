// Bounded, best-effort AEC transport. Raw frame persistence/dedup belongs to LiveCapture/MeetingStore.
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptureTiming } from './capture-gaps.ts';
import type { TimedAudio } from './echo-timeline.ts';

export const ECHO_WAIT_MS = 1500;
export const ECHO_DEADLINE_MS = 2000;
export const ECHO_REFERENCE_LEAD_MS = 100;
export type EchoOptions = { leadMs?: number; waitMs?: number; deadlineMs?: number; workerScript?: URL; log?: (message: string) => void };
export type EchoStats = { frames: number; samples: number; missingSamples: number; computeMs: number; delayMs: number; maxDelayMs: number; failures: number };
const floats = (pcm: Buffer) => new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
type Job = { raw: Buffer; resolve: (pcm: Buffer) => void; timer: NodeJS.Timeout; at: number };

class EchoSession {
  private worker: Worker | null = null;
  private jobs = new Map<string, Job>();
  private idle: (() => void)[] = [];
  private settled() { if (!this.jobs.size) { for (const done of this.idle.splice(0)) done(); } }
  failed = false;
  finishing = false;
  stats: EchoStats = { frames: 0, samples: 0, missingSamples: 0, computeMs: 0, delayMs: 0, maxDelayMs: 0, failures: 0 };
  private options: EchoOptions;
  constructor(options: EchoOptions, fail: () => void) {
    this.options = options;
    try {
      const worker = new Worker(options.workerScript ?? new URL('./echo-worker.ts', import.meta.url), { workerData: { leadMs: options.leadMs, waitMs: options.waitMs ?? ECHO_WAIT_MS } });
      this.worker = worker;
      worker.on('message', (message: { kind: string; id: string; pcm: Float32Array; missingSamples: number; computeMs: number }) => {
        if (this.worker !== worker || message.kind !== 'audio') return;
        const job = this.jobs.get(message.id);
        if (!job) return;
        if (!(message.pcm instanceof Float32Array) || message.pcm.byteLength !== job.raw.length || !message.pcm.every(Number.isFinite)) { this.failure(fail); return; }
        this.jobs.delete(message.id); clearTimeout(job.timer);
        const delay = performance.now() - job.at;
        this.stats.frames++; this.stats.samples += message.pcm.length; this.stats.missingSamples += message.missingSamples;
        this.stats.computeMs += message.computeMs; this.stats.delayMs += delay; this.stats.maxDelayMs = Math.max(this.stats.maxDelayMs, delay);
        job.resolve(Buffer.from(message.pcm.buffer, message.pcm.byteOffset, message.pcm.byteLength));
        this.settled();
      });
      worker.on('error', () => this.failure(fail));
      worker.on('exit', code => { if (this.worker === worker && (!this.finishing || code !== 0 || this.jobs.size)) this.failure(fail); });
    } catch { this.failure(fail); }
    this.onFailure = fail;
  }
  private onFailure: () => void = () => {};
  private failure(fail = this.onFailure) {
    if (this.failed) return;
    this.failed = true; this.stats.failures++; fail();
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.resolve(job.raw); }
    this.jobs.clear(); this.settled();
    const worker = this.worker; this.worker = null;
    worker?.terminate().catch(() => {});
  }
  reference(audio: TimedAudio) {
    if (!this.failed && !this.finishing) {
      try { this.worker?.postMessage({ kind: 'reference', ...audio }); } catch { this.failure(); }
    }
  }
  microphone(id: string, raw: Buffer, timing: CaptureTiming): Promise<Buffer> {
    if (this.failed || this.finishing) return Promise.resolve(raw);
    if (this.jobs.size >= 32) { this.failure(); return Promise.resolve(raw); }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.failure(), this.options.deadlineMs ?? ECHO_DEADLINE_MS);
      this.jobs.set(id, { raw, resolve, timer, at: performance.now() });
      try { this.worker?.postMessage({ kind: 'microphone', id, pcm: floats(raw), timing, receivedAt: Date.now() }); }
      catch { this.failure(); }
    });
  }
  async finish() {
    if (!this.finishing && !this.failed) {
      this.finishing = true;
      try { this.worker?.postMessage({ kind: 'finish' }); } catch { this.failure(); }
    }
    // Jobs have a main-thread deadline even if WASM startup or the worker event loop is stuck.
    if (this.jobs.size) await new Promise<void>(resolve => this.idle.push(resolve));
    await this.close();
  }
  async close() {
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.resolve(job.raw); }
    this.jobs.clear(); this.settled();
    const worker = this.worker; this.worker = null;
    await worker?.terminate().catch(() => {});
  }
}

type Reference = { source: string; audio: TimedAudio[] };
/** One manager for LiveCapture, one worker per live microphone recording with a call reference.
 * No state is restored from disk: recovered frames always seal raw.
 */
export class LiveEcho {
  private references = new Map<string, Reference>();
  private sessions = new Map<string, { meetingId: string; session: EchoSession }>();
  private finished: EchoStats[] = [];
  private disabled = new Set<string>();
  private logged = new Set<string>();
  private options: EchoOptions;
  constructor(options: EchoOptions = {}) {
    const configured = Number(process.env.MEETING_AEC_REFERENCE_LEAD_MS ?? ECHO_REFERENCE_LEAD_MS);
    const leadMs = options.leadMs ?? (Number.isFinite(configured) && configured >= 0 && configured <= 300 ? configured : ECHO_REFERENCE_LEAD_MS);
    this.options = { ...options, leadMs };
  }
  reference(meetingId: string, source: string, pcm: Buffer, timing?: CaptureTiming) {
    // Legacy pages without wall-clock metadata stay raw; never align by receipt time.
    if (!timing) return;
    let reference = this.references.get(meetingId);
    if (!reference || reference.source !== source) { reference = { source, audio: [] }; this.references.set(meetingId, reference); }
    const audio = { pcm: floats(pcm), timing };
    reference.audio.push(audio);
    if (reference.audio.length > 10) reference.audio.shift();
    for (const entry of this.sessions.values()) if (entry.meetingId === meetingId) entry.session.reference(audio);
  }
  microphone(meetingId: string, source: string, id: string, pcm: Buffer, timing?: CaptureTiming): Promise<Buffer> | null {
    const reference = this.references.get(meetingId);
    if (!reference || !timing || this.disabled.has(source)) return null;
    let entry = this.sessions.get(source);
    if (!entry) {
      const session = new EchoSession(this.options, () => {
        this.disabled.add(source);
        if (!this.logged.has(source)) { this.logged.add(source); this.options.log?.('AEC unavailable or behind its seal deadline; microphone passes through raw for this recording.'); }
      });
      entry = { meetingId, session }; this.sessions.set(source, entry);
      for (const audio of reference.audio) session.reference(audio);
    }
    return entry.session.microphone(id, pcm, timing);
  }
  async end(meetingId: string, source: string) {
    if (this.references.get(meetingId)?.source === source) {
      this.references.delete(meetingId);
      for (const [mic, entry] of this.sessions) if (entry.meetingId === meetingId) {
        this.sessions.delete(mic); // Retire ownership before awaiting: mic Stop and call Stop may overlap.
        await entry.session.finish(); this.finished.push({ ...entry.session.stats });
      }
    } else {
      const entry = this.sessions.get(source);
      if (entry) {
        this.sessions.delete(source);
        await entry.session.finish(); this.finished.push({ ...entry.session.stats });
      }
    }
  }
  stats(): EchoStats {
    const stats: EchoStats = { frames: 0, samples: 0, missingSamples: 0, computeMs: 0, delayMs: 0, maxDelayMs: 0, failures: 0 };
    for (const item of [...this.finished, ...[...this.sessions.values()].map(entry => entry.session.stats)]) for (const key of Object.keys(stats) as (keyof EchoStats)[]) {
      if (key === 'maxDelayMs') stats[key] = Math.max(stats[key], item[key]); else stats[key] += item[key];
    }
    return stats;
  }
  prune(existing: ReadonlySet<string>) {
    for (const meeting of this.references.keys()) if (!existing.has(meeting)) this.references.delete(meeting);
    for (const [mic, entry] of this.sessions) if (!existing.has(entry.meetingId)) { this.sessions.delete(mic); entry.session.close().catch(() => {}); }
  }
  async close() {
    this.references.clear();
    await Promise.all([...this.sessions.values()].map(entry => entry.session.close()));
    this.sessions.clear();
  }
}

/** Headless bundle smoke switch: starts only a worker, never a server, UI, device or process tap. */
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
