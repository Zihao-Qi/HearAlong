import { lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Meeting, MeetingStore } from './store.ts';

export const AUDIO_RETENTION = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, always: Infinity } as const;
export type AudioRetentionSetting = keyof typeof AUDIO_RETENTION;
export const isAudioRetention = (v: unknown): v is AudioRetentionSetting => typeof v === 'string' && Object.hasOwn(AUDIO_RETENTION, v);
export const audioRetentionLabel = (v: AudioRetentionSetting) => ({ day: '1 day', week: '1 week', month: '1 month', always: 'Always' })[v];
type Notice = { count: number; bytes: number };

/** Owns only data/audio/<uuid>. Never follows database paths (imports can share a path with many chunks). */
export class AudioRetention {
  private stopped = false;
  private running: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  notice: Notice | null = null;
  private store: MeetingStore;
  private options: {
    setting: () => AudioRetentionSetting; active: (id: string) => boolean; clock?: () => number;
    /** Incoming audio not yet accepted: defer removal without resetting an existing completion clock. */
    pending?: (id: string) => boolean;
    log?: (message: string) => void;
    /** Filesystem boundary, injectable for crash/slow-disk tests. No database access after this starts. */
    removeFiles?: (path: string, names: string[]) => Promise<void>;
  };
  constructor(store: MeetingStore, options: AudioRetention['options']) { this.store = store; this.options = options; }
  private now() { return this.options.clock?.() ?? Date.now(); }
  private ready(m: Meeting) {
    const replay = this.store.replay(m.id);
    return !this.options.pending?.(m.id) && !this.store.recordingUnended(m.id) && !this.options.active(m.id) && !(replay && this.store.replayPositionMs(replay, this.now()) < replay.durationMs)
      && !this.store.chunks(m.id).some(c => c.status !== 'completed') && !this.store.heldFrames(m.id).length;
  }
  /** Called by the existing live loop: notices completion and arms the next meeting's expiry, without disk work. */
  observe(markOnly = false) {
    if (this.stopped && !markOnly) return;
    let next = Infinity;
    for (const m of this.store.meetings()) {
      if (m.audioRemovedAt !== null || m.audioKept || m.audioEmpty || this.options.pending?.(m.id)) continue;
      if (!this.ready(m)) {
        if (m.audioDoneAt !== null) this.store.db.prepare('UPDATE meetings SET audioDoneAt=NULL WHERE id=?').run(m.id);
        continue;
      }
      if (m.audioDoneAt === null) {
        if (m.audioLegacy) { if (!markOnly) void this.run(); continue; }
        if (!this.store.chunks(m.id).length) continue;
        this.store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(this.now(), m.id);
        m.audioDoneAt = this.now();
      }
      if (m.audioLegacy && !this.decision()) continue;
      next = Math.min(next, m.audioDoneAt + AUDIO_RETENTION[this.options.setting()]);
    }
    if (markOnly) return;
    clearTimeout(this.timer);
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => { void this.run(); }, Math.min(2_147_483_647, Math.max(1, next - this.now())));
      this.timer.unref();
    }
  }
  private decision() { return (this.store.db.prepare('SELECT decision FROM audio_retention WHERE id=1').get() as { decision: string | null }).decision; }
  answer(answer: 'remove' | 'keep') {
    if (!this.notice || this.decision()) throw Object.assign(new Error('No older audio question is pending.'), { status: 409 });
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('UPDATE audio_retention SET decision=? WHERE id=1').run(answer);
      if (answer === 'keep') this.store.db.exec('UPDATE meetings SET audioKept=1 WHERE audioLegacy=1 AND audioRemovedAt IS NULL');
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.notice = null;
    void this.run();
  }
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ??= this.sweep().catch(error => this.options.log?.(`Audio retention: ${(error as Error).message}`))
      .finally(() => { this.running = null; });
  }
  private async folder(id: string): Promise<string | null> {
    if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) return null;
    const root = join(this.store.directory, 'audio'), path = join(root, id);
    try {
      if (!(await lstat(root)).isDirectory() || !(await lstat(path)).isDirectory()) return null;
      const data = await realpath(this.store.directory);
      if (await realpath(root) !== join(data, 'audio') || await realpath(path) !== join(data, 'audio', id)) return null;
      return path;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private inGeneration(name: string, generation: number) {
    return name.endsWith('.f32') && (generation === 0 ? !/^g[1-9]\d*-/.test(name) : name.startsWith(`g${generation}-`));
  }
  private async files(id: string, generation?: number) {
    const path = await this.folder(id);
    if (!path) return { count: 0, bytes: 0, newest: 0 };
    let count = 0, bytes = 0, newest = 0;
    for (const name of await readdir(path)) {
      const s = await lstat(join(path, name)).catch(() => null);
      if ((generation === undefined ? name.endsWith('.f32') : this.inGeneration(name, generation)) && s?.isFile()) {
        count++; bytes += s.size; newest = Math.max(newest, s.mtimeMs);
      }
    }
    return { count, bytes, newest };
  }
  private async erase(id: string, generation: number) {
    const path = await this.folder(id);
    if (!path || this.stopped) return;
    const names = (await readdir(path)).filter(name => this.inGeneration(name, generation));
    if (this.options.removeFiles) { await this.options.removeFiles(path, names); return; }
    // Only this removed generation's top-level raw audio. New recordings and unexpected files stay untouched.
    for (const name of names) {
      if (this.stopped) return;
      const file = join(path, name);
      if (name.endsWith('.f32') && (await lstat(file).catch(() => null))?.isFile()) await rm(file, { force: true });
    }
    await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
  }
  private latestTime(id: string) {
    const row = this.store.db.prepare(`SELECT MAX(time) AS time FROM (
      SELECT completedAt AS time FROM chunks WHERE meetingId=? AND status='completed' AND path<>''
      UNION ALL SELECT savedAt AS time FROM frames WHERE meetingId=? AND path<>''
      UNION ALL SELECT recordingEndedAt AS time FROM meetings WHERE id=?)`).get(id, id, id) as { time: number | null };
    return row.time ?? 0;
  }
  private audioRowCount(id: string) {
    return (this.store.db.prepare(`SELECT (SELECT COUNT(*) FROM chunks WHERE meetingId=?) +
      (SELECT COUNT(*) FROM frames WHERE meetingId=?) AS count`).get(id, id) as { count: number }).count;
  }
  private async sweep() {
    let count = 0, bytes = 0;
    const removals = this.store.db.prepare('SELECT meetingId,generation FROM audio_removals').all() as { meetingId: string; generation: number }[];
    for (const removal of removals) {
      if (this.stopped) return;
      await this.erase(removal.meetingId, removal.generation);
    }
    if (this.stopped) return;
    for (let m of this.store.meetings()) {
      if (this.stopped) return;
      // Committed removals above are finished even if the setting is now Always or a new generation records.
      if (m.audioRemovedAt !== null || m.audioEmpty || m.audioKept || !this.ready(m)) continue;
      const generation = m.audioGeneration, rows = this.audioRowCount(m.id);
      const owned = await this.files(m.id); // Ownership is independent of transcript rows and covers every generation, never imports.
      if (this.stopped) return;
      m = this.store.meeting(m.id);
      if (!this.ready(m) || m.audioGeneration !== generation || this.audioRowCount(m.id) !== rows) continue;
      if (!owned.count) {
        this.store.db.prepare('UPDATE meetings SET audioEmpty=1 WHERE id=?').run(m.id);
        continue;
      }
      if (m.audioDoneAt === null) {
        let done = this.latestTime(m.id);
        // Legacy startMs is a position within the audio, not a wall-clock timestamp (meetings can be resumed days later).
        if (!done) done = (await this.files(m.id, m.audioGeneration)).newest;
        if (this.stopped) return;
        if (!this.ready(this.store.meeting(m.id))) continue;
        if (!done) continue;
        done = Math.max(done, this.latestTime(m.id)); // capture/transcription may have finished during the file scan
        // A new meeting interrupted without an explicit Stop starts conservatively at recovery.
        const ended = this.store.db.prepare('SELECT recordingEndedAt FROM meetings WHERE id=?').get(m.id) as { recordingEndedAt: number | null };
        if (!m.audioLegacy && ended.recordingEndedAt === null) done = this.now();
        this.store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(done, m.id);
        m = this.store.meeting(m.id);
      }
      if (this.options.setting() === 'always' || this.now() < m.audioDoneAt! + AUDIO_RETENTION[this.options.setting()]) continue;
      if (m.audioLegacy && !this.decision()) {
        const size = await this.files(m.id, m.audioGeneration);
        if (size.bytes) { count++; bytes += size.bytes; }
        continue;
      }
      // Revalidate after any async work; the mark and path clearing are one synchronous durable transaction.
      if (this.stopped) return;
      m = this.store.meeting(m.id);
      if (!this.ready(m) || m.audioKept || m.audioDoneAt === null || this.now() < m.audioDoneAt + AUDIO_RETENTION[this.options.setting()]) continue;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.db.prepare('INSERT OR IGNORE INTO audio_removals(meetingId,generation) VALUES (?,?)').run(m.id, m.audioGeneration);
        this.store.db.prepare('UPDATE meetings SET audioRemovedAt=?, audioRemovedAfter=? WHERE id=?').run(this.now(), audioRetentionLabel(this.options.setting()), m.id);
        this.store.db.prepare("UPDATE chunks SET path='' WHERE meetingId=?").run(m.id);
        this.store.db.prepare("UPDATE frames SET path='' WHERE meetingId=?").run(m.id);
        this.store.db.exec('COMMIT');
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
      await this.erase(m.id, m.audioGeneration);
    }
    if (!this.stopped) { this.notice = !this.decision() && count ? { count, bytes } : null; this.observe(); }
  }
  /** Does not await filesystem work. In-flight deletions never access the closed store. */
  close() { this.stopped = true; clearTimeout(this.timer); }
}
