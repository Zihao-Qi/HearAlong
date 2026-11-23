// A stand-in for the native meeting-app capture (launcher/AppCaptureClient.swift + capture-main.swift) for npm run bench:call.
// It speaks the same HTTP protocol to the real server: a 0.5 s /api/live/capture heartbeat, the app list, then ordered one-second
// float32 frames with X-Audio-Source app:…, X-Capture-Wall-Ms, X-Start-Ms from the command's clockStart, and pcm/end on Stop.
// The audio is a prepared buffer "played" from a wall-clock anchor, so frame n is sent once its last sample has been played.
import type { SpokenFrame } from './snapshot.ts';

export type AudioApp = { id: string; name: string };
type Command = { app: AudioApp; meetingId: string; recordingId: string; source: string; pageId: string; clockStart: number; stopping: boolean };
export type HelperFrame = SpokenFrame & { sequence: number; samples: number; sentAt: number; acceptedAt: number | null; status: number };

const FRAME = 16000;

/** First sample index to capture when the command arrives at `nowMs`, for audio whose sample 0 played at `anchorMs`. */
export function firstSample(anchorMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((nowMs - anchorMs) * 16));
}

export class BenchCallHelper {
  readonly app: AudioApp;
  readonly frames: HelperFrame[] = [];
  readonly errors: string[] = [];
  command: Command | null = null;
  ended = false;
  private audio: Float32Array;
  private base = '';
  private cookie = '';
  private anchorMs: number | null = null;
  private poller: NodeJS.Timeout | undefined;
  private framer: NodeJS.Timeout | undefined;
  private asking = false;
  private lastList = -Infinity;
  private announced = false;
  private next = 0;
  private first = 0;
  private sequence = 0;
  private queue: { pcm: Float32Array; wallMs: number; startSample: number }[] = [];
  private uploading = false;
  private stopping = false;
  private endSent = false;
  private closed = false;

  constructor(app: AudioApp, audio: Float32Array) { this.app = app; this.audio = audio; }

  /** Before navigation: take a session cookie (as capture-main's renewSession does) and start the heartbeat. */
  async connect(url: string): Promise<void> {
    this.base = url.replace(/\/$/, '');
    const response = await fetch(`${this.base}/mini.html`, { headers: { Origin: this.base } });
    await response.arrayBuffer();
    this.cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!this.cookie) throw new Error('The server gave the call helper no session cookie.');
    this.poller = setInterval(() => { this.background(this.poll()); }, 500);
    this.background(this.poll());
  }

  /** Wall time (page clock) when the microphone file began playing; call sample k plays at `anchorMs + k / 16`. */
  anchor(anchorMs: number) { this.anchorMs ??= anchorMs; }

  private background(work: Promise<void>) { work.catch(error => { this.errors.push(error instanceof Error ? error.message : String(error)); }); }

  private headers(extra: Record<string, string> = {}) {
    return { Cookie: this.cookie, Origin: this.base, ...extra };
  }

  private async post(path: string, value: unknown, extra: Record<string, string> = {}) {
    return fetch(`${this.base}/${path}`, { method: 'POST', body: JSON.stringify(value), headers: this.headers({ 'Content-Type': 'application/json', ...extra }), signal: AbortSignal.timeout(10_000) });
  }

  private async poll() {
    if (this.asking || this.closed) return;
    this.asking = true;
    try {
      const response = await fetch(`${this.base}/api/live/capture`, { headers: this.headers(), signal: AbortSignal.timeout(2000) });
      if (response.status !== 200) { await response.arrayBuffer(); return; }
      const json = await response.json() as { appList?: boolean; appCapture?: Command | null };
      if (!this.announced || (json.appList && performance.now() - this.lastList >= 800)) {
        this.announced = true; this.lastList = performance.now();
        await (await this.post('api/live/apps', { available: true, apps: json.appList ? [this.app] : [] })).arrayBuffer();
      }
      const command = json.appCapture ?? null;
      if (command && !this.command && !this.ended) this.start(command);
      else if (this.command && (!command || command.source !== this.command.source || command.stopping)) this.stop();
    } catch (error) {
      // Only a capture in progress depends on the heartbeat; the server may already be closing after the end was sent.
      if (!this.closed && this.command && !this.ended) this.errors.push(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.asking = false; }
  }

  private start(command: Command) {
    if (this.anchorMs === null) { this.errors.push('The call capture started before the microphone playback time was known.'); return; }
    this.command = command;
    this.first = this.next = firstSample(this.anchorMs, Date.now());
    this.schedule();
  }

  private sampleWall(index: number) { return this.anchorMs! + index / 16; }

  /** Cut every complete frame already played, then wait for the next one to finish playing. Silence after the buffer's end. */
  private schedule() {
    clearTimeout(this.framer);
    if (this.stopping || !this.command) return;
    while (this.sampleWall(this.next + FRAME) <= Date.now()) this.cut(this.next + FRAME);
    this.framer = setTimeout(() => this.schedule(), Math.max(5, this.sampleWall(this.next + FRAME) - Date.now() + 2));
  }

  private cut(end: number) {
    if (end <= this.next) return;
    const pcm = new Float32Array(end - this.next);
    pcm.set(this.audio.subarray(Math.min(this.next, this.audio.length), Math.min(end, this.audio.length)));
    this.queue.push({ pcm, wallMs: this.sampleWall(this.next), startSample: this.next });
    this.next = end;
    this.background(this.pump());
  }

  private stop() {
    if (this.stopping || !this.command) return;
    this.stopping = true;
    clearTimeout(this.framer);
    // The final partial frame, as TimedMonoFramer.flush does on Stop.
    this.cut(Math.max(this.next, Math.min(this.next + FRAME - 1, firstSample(this.anchorMs!, Date.now()))));
    this.background(this.pump());
  }

  private async pump() {
    const command = this.command;
    if (this.uploading || !command) return;
    const item = this.queue.shift();
    if (!item) { if (this.stopping) await this.end(); return; }
    this.uploading = true;
    const sequence = this.sequence++;
    // AppTimeline.startMs: the first frame's wall time minus clockStart, then sample count.
    const startMs = Math.max(0, this.sampleWall(this.first) - command.clockStart) + (item.startSample - this.first) / 16;
    const body = new Uint8Array(item.pcm.buffer as ArrayBuffer, item.pcm.byteOffset, item.pcm.byteLength);
    const sentAt = Date.now();
    const frame: HelperFrame = { source: command.source, startMs, endMs: startMs + item.pcm.length / 16, captureWallMs: item.wallMs, sequence, samples: item.pcm.length, sentAt, acceptedAt: null, status: 0 };
    this.frames.push(frame);
    try {
      const response = await fetch(`${this.base}/api/meetings/${command.meetingId}/pcm`, { method: 'POST', body, signal: AbortSignal.timeout(10_000), headers: this.headers({
        'Content-Type': 'application/octet-stream', 'X-Audio-Source': command.source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000',
        'X-Start-Ms': String(startMs), 'X-Clock-Start': String(command.clockStart), 'X-Recording': command.recordingId, 'X-Page': command.pageId,
        'X-Pending': String(this.queue.length + 1), 'X-Capture-Wall-Ms': String(item.wallMs), 'X-Capture-Settings': JSON.stringify({ kind: 'app', app: command.app.name }),
      }) });
      frame.status = response.status;
      const reply = await response.json().catch(() => ({})) as { stop?: boolean; quit?: boolean; error?: string };
      if (response.status === 201) frame.acceptedAt = Date.now();
      else this.errors.push(`Call frame ${sequence}: HTTP ${response.status} ${reply.error ?? ''}`.trim());
      if (reply.stop || reply.quit) this.stop();
    } catch (error) {
      this.errors.push(`Call frame ${sequence}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.uploading = false; }
    await this.pump();
  }

  private async end() {
    const command = this.command;
    if (this.endSent || !command) return;
    this.endSent = true;
    try {
      const response = await this.post(`api/meetings/${command.meetingId}/pcm/end`, { source: command.source, lastSequence: this.sequence ? this.sequence - 1 : null, stopping: true }, { 'X-Page': command.pageId });
      if (response.status !== 200) this.errors.push(`Call end: HTTP ${response.status}`);
      await response.arrayBuffer();
    } catch (error) { this.errors.push(`Call end: ${error instanceof Error ? error.message : String(error)}`); }
    this.ended = true; this.command = null;
  }

  /** After the rehearsal: stop the heartbeat. A capture still running is stopped first (bounded). */
  async close() {
    if (this.command && !this.ended) {
      this.stop();
      const until = Date.now() + 15_000;
      while (!this.ended && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.closed = true;
    clearInterval(this.poller); clearTimeout(this.framer);
  }
}
