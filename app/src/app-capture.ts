import { isRemote } from './speakers.ts';

export type AudioApp = { id: string; name: string };
export type AppCaptureRequest = { app: AudioApp; meetingId: string; recordingId: string; source: string; pageId: string; clockStart: number };
export type AppCaptureState = AppCaptureRequest & { stopping: boolean; ended: boolean; message: string | null; notice: string | null };

/** Desired helper state, not a consumable command queue: a lost poll never loses Start or Stop. */
export class AppCaptureControl {
  private seenAt = -Infinity;
  private wantedAt = -Infinity;
  private supported = false;
  private audioSeenAt = -Infinity;
  private apps: AudioApp[] = [];
  private used = new Set<string>();
  state: AppCaptureState | null = null;
  private clock: () => number;
  constructor(clock: () => number = Date.now) { this.clock = clock; }
  available() { return this.supported && this.clock() - this.seenAt < 3000; }
  requestList() { this.wantedAt = this.clock(); return { available: this.available(), apps: this.available() ? this.apps : [] }; }
  wantsList() { return this.clock() - this.wantedAt < 5000; }
  report(value: unknown) {
    const v = value as { available?: unknown; apps?: unknown } | null;
    if (!v || typeof v.available !== 'boolean' || !Array.isArray(v.apps) || v.apps.length > 200) throw new Error('Give availability and a small app list.');
    const apps: AudioApp[] = [];
    for (const item of v.apps) {
      if (!item || typeof item.id !== 'string' || !/^[\w.-]{1,200}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) throw new Error('Invalid audio app.');
      if (apps.some(a => a.id === item.id)) throw new Error('Duplicate audio app.');
      apps.push({ id: item.id, name: item.name });
    }
    this.supported = v.available; this.apps = apps; this.seenAt = this.clock();
  }
  start(value: unknown, current: { meetingId: string; recordingId: string | null; pageId: string | null; sources: string[]; stopping: boolean } | null): boolean {
    const v = value as AppCaptureRequest | null;
    if (!v || !v.app || typeof v.app.id !== 'string' || typeof v.meetingId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.recordingId) || !/^app:[a-f0-9-]{36}$/.test(v.source) || typeof v.pageId !== 'string' || !v.pageId || v.pageId.length > 64 || !Number.isFinite(v.clockStart) || v.clockStart <= 0 || v.clockStart >= 8.64e15) throw new Error('Invalid app capture request.');
    if (!current || current.stopping || current.meetingId !== v.meetingId || current.recordingId !== v.recordingId || current.pageId !== v.pageId) return false;
    if (this.used.has(v.source)) return false;
    if (!this.available()) throw new Error('The helper is not available.');
    if (this.state && !this.state.ended || current.sources.some(isRemote)) throw new Error('Only one call source can record at a time.');
    const app = this.apps.find(a => a.id === v.app.id);
    if (!app) throw new Error('That app is no longer playing sound.');
    this.used.add(v.source);
    this.audioSeenAt = this.clock();
    this.state = { ...v, app, stopping: false, ended: false, message: null, notice: null };
    return true;
  }
  stop(source?: string) { if (this.state && !this.state.ended && (!source || source === this.state.source)) this.state.stopping = true; }
  ended(source: string, message?: string) {
    if (this.state?.source !== source || this.state.ended) return;
    this.state.ended = true;
    this.state.message = message?.slice(0, 600) ?? null;
  }
  notice(source: string, message: string) { if (this.state?.source === source && !this.state.ended) this.state.notice ??= message.slice(0, 600); }
  lost(): boolean { return Boolean(this.state && !this.state.ended && this.clock() - Math.max(this.seenAt, this.audioSeenAt) >= 3500); }
  heartbeat() { this.seenAt = this.clock(); }
  frame(source: string) { if (this.state?.source === source && !this.state.ended) this.audioSeenAt = this.clock(); }
  command() { return this.state && !this.state.ended ? this.state : null; }
}
