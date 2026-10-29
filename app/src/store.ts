import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { dataRelativeRecordingPath, repairedRecordingPath } from './recording-paths.ts';
import { CHUNK_SECONDS } from './audio.ts';
import { deleteMeeting, inspectMeetingDeletion } from './delete-meeting.ts';
import { buildSegments, type Timing } from './segments.ts';
import type { Recognition } from './recognizer.ts';
import { ROLE_LABEL, compareSegments, rolesFor, type Role, type Speakers } from './speakers.ts';
import { detectFrameCaptureGaps, type CaptureTiming } from './capture-gaps.ts';
import { CaptureConflict } from './capture-error.ts';
import { captureGapText, mergeCaptureGaps, type CaptureGap } from '../public/capture-gaps.js';

export type Mode = 'periodic' | 'manual' | 'questions';
export type Meeting = { id: string; title: string; createdAt: number; mode: Mode; intervalSeconds: number; replay: string | null; correction: string | null;
  audioDoneAt: number | null; audioRemovedAt: number | null; audioRemovedAfter: string | null; audioLegacy: number; audioKept: number; audioGeneration: number; audioEmpty: number };
export type Replay = { sourceId: string; startedAt: number; speed: number; baseMs: number; durationMs: number };
export type Edit = { start: number; end: number; from: string; to: string };
export type Segment = {
  id: string; meetingId: string; chunkId: string; source: string; ord: number; startMs: number; endMs: number;
  text: string; originalText: string; revision: number; state: 'final' | 'draft'; timing: Timing; edits: string;
  /** Glossary version this segment was last checked against; 0 = not yet checked. */
  correctionChecked: number;
};
export type Chunk = {
  id: string; meetingId: string; source: string; sequence: number; path: string;
  decodeStart: number; startMs: number; seconds: number; sampleRate: number | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  text: string; error: string | null; metrics: string | null; hash: string;
  attempts: number; retryAt: number | null;
};

/** A saved 1 s piece of live audio (16 kHz mono f32). It belongs to no window until a seal groups it into a chunk. */
export type Frame = {
  id: string; meetingId: string; source: string; sequence: number; path: string; startMs: number; samples: number; hash: string;
  windowChunkId: string | null; captureWallMs?: number | null; captureEndWallMs?: number | null;
};
export const FRAME_RATE = 16_000;
/** Live frames are 1 s; only the last frame of a source may be shorter. */
export const FRAME_SAMPLES = FRAME_RATE;

/** Shared with read-only tools that must not open a writable MeetingStore just to resolve a recording. */
export function resolveRecordingPath(directory: string, path: string): string {
  return !path || isAbsolute(path) ? path : join(directory, path);
}

/** Makes a new file's name durable, not just its bytes (power loss). Not every platform can sync a directory. */
async function syncDirectory(directory: string) {
  try { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch { /* best effort */ }
}

/** An old generation may finish removing its now-empty directory just after new capture creates it. */
async function openAudioFile(directory: string, path: string) {
  for (;;) {
    try { return await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(directory, { recursive: true });
    }
  }
}

export class MeetingStore {
  db: DatabaseSync;
  directory: string;
  private deletionGuards = new Map<string, (id: string) => boolean>();
  /** Job owners supply their existing in-process busy records, including preparation before persistence. */
  registerDeletionGuard(name: string, busy: (id: string) => boolean) { this.deletionGuards.set(name, busy); }
  deletionBusy(id: string) { return [...this.deletionGuards].filter(([, busy]) => busy(id)).map(([name]) => name); }
  inspectMeetingDeletion(id: string) { return inspectMeetingDeletion(this, id); }
  deleteMeeting(id: string) { return deleteMeeting(this, id); }
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.db = new DatabaseSync(join(this.directory, 'meetings.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'periodic', intervalSeconds INTEGER NOT NULL DEFAULT 60);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id),
        source TEXT NOT NULL, sequence INTEGER NOT NULL, path TEXT NOT NULL, decodeStart REAL NOT NULL,
        startMs REAL NOT NULL, seconds REAL NOT NULL, sampleRate INTEGER, status TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '', error TEXT, metrics TEXT, hash TEXT NOT NULL,
        UNIQUE(meetingId, source, sequence));
      CREATE INDEX IF NOT EXISTS chunk_queue ON chunks(status, startMs);
      CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id),
        chunkId TEXT NOT NULL REFERENCES chunks(id), source TEXT NOT NULL, ord INTEGER NOT NULL,
        startMs REAL NOT NULL, endMs REAL NOT NULL, text TEXT NOT NULL, originalText TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'final', timing TEXT NOT NULL,
        edits TEXT NOT NULL DEFAULT '[]', UNIQUE(chunkId, ord));
      CREATE INDEX IF NOT EXISTS segment_order ON segments(meetingId, startMs);
      CREATE TABLE IF NOT EXISTS frames (id TEXT PRIMARY KEY, meetingId TEXT NOT NULL REFERENCES meetings(id), source TEXT NOT NULL,
        sequence INTEGER NOT NULL, path TEXT NOT NULL, startMs REAL NOT NULL, samples INTEGER NOT NULL, hash TEXT NOT NULL,
        windowChunkId TEXT REFERENCES chunks(id), UNIQUE(meetingId, source, sequence));
      CREATE INDEX IF NOT EXISTS frames_held ON frames(meetingId, source, windowChunkId);
      CREATE TABLE IF NOT EXISTS capture_gaps (meetingId TEXT NOT NULL REFERENCES meetings(id), source TEXT NOT NULL,
        atMs REAL NOT NULL, fromWallMs REAL NOT NULL, toWallMs REAL NOT NULL, reason TEXT,
        PRIMARY KEY (meetingId, source, atMs));
      CREATE TABLE IF NOT EXISTS source_settings (meetingId TEXT NOT NULL REFERENCES meetings(id), source TEXT NOT NULL, settings TEXT NOT NULL,
        PRIMARY KEY (meetingId, source));
    `);
    const columns = (this.db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).map(c => c.name);
    for (const column of ['replay', 'correction']) if (!columns.includes(column)) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${column} TEXT`);
    // Existing rows are the one-time consent cohort; new rows explicitly opt out of that cohort.
    for (const column of ['audioDoneAt INTEGER', 'audioRemovedAt INTEGER', 'audioRemovedAfter TEXT', 'audioLegacy INTEGER NOT NULL DEFAULT 1', 'audioKept INTEGER NOT NULL DEFAULT 0', 'recordingEndedAt INTEGER', 'audioGeneration INTEGER NOT NULL DEFAULT 0', 'audioEmpty INTEGER NOT NULL DEFAULT 0']) {
      if (!columns.includes(column.split(' ')[0])) this.db.exec(`ALTER TABLE meetings ADD COLUMN ${column}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS audio_retention (id INTEGER PRIMARY KEY CHECK(id=1), decision TEXT);
      INSERT OR IGNORE INTO audio_retention(id) VALUES (1);
      CREATE TABLE IF NOT EXISTS audio_removals (meetingId TEXT NOT NULL REFERENCES meetings(id), generation INTEGER NOT NULL,
        PRIMARY KEY (meetingId, generation));
      INSERT OR IGNORE INTO audio_removals SELECT id, audioGeneration FROM meetings WHERE audioRemovedAt IS NOT NULL;
      CREATE TABLE IF NOT EXISTS recording_sources (meetingId TEXT NOT NULL REFERENCES meetings(id), source TEXT NOT NULL,
        pageId TEXT, state TEXT NOT NULL, PRIMARY KEY (meetingId, source));`);
    const chunkColumns = (this.db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[]).map(c => c.name);
    if (!chunkColumns.includes('completedAt')) this.db.exec('ALTER TABLE chunks ADD COLUMN completedAt INTEGER');
    if (!chunkColumns.includes('attempts')) this.db.exec('ALTER TABLE chunks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!chunkColumns.includes('retryAt')) this.db.exec('ALTER TABLE chunks ADD COLUMN retryAt INTEGER');
    const frameColumns = (this.db.prepare('PRAGMA table_info(frames)').all() as { name: string }[]).map(c => c.name);
    if (!frameColumns.includes('savedAt')) this.db.exec('ALTER TABLE frames ADD COLUMN savedAt INTEGER');
    if (!frameColumns.includes('captureWallMs')) this.db.exec('ALTER TABLE frames ADD COLUMN captureWallMs REAL');
    if (!frameColumns.includes('captureEndWallMs')) this.db.exec('ALTER TABLE frames ADD COLUMN captureEndWallMs REAL');
    const segmentColumns = (this.db.prepare('PRAGMA table_info(segments)').all() as { name: string }[]).map(c => c.name);
    if (!segmentColumns.includes('correctionChecked')) this.db.exec('ALTER TABLE segments ADD COLUMN correctionChecked INTEGER NOT NULL DEFAULT 0');
    // Schema 2, run once (also for databases that gained the column without this repair):
    // carry over the old time cursor so an upgrade does not re-process already checked speech.
    if (Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 2) {
      this.db.exec('UPDATE segments SET correctionChecked=1 WHERE revision > 0 AND correctionChecked=0');
      for (const row of this.db.prepare('SELECT id, correction FROM meetings WHERE correction IS NOT NULL').all() as { id: string; correction: string }[]) {
        const old = JSON.parse(row.correction) as { cursorMs?: number; cursorId?: string; glossaryVersion?: number };
        if (typeof old.cursorMs !== 'number') continue;
        this.db.prepare('UPDATE segments SET correctionChecked=? WHERE meetingId=? AND correctionChecked=0 AND (startMs < ? OR (startMs = ? AND id <= ?))')
          .run(old.glossaryVersion || 1, row.id, old.cursorMs, old.cursorMs, old.cursorId ?? '');
      }
      this.db.exec('PRAGMA user_version = 2');
    }
    // Repair on every open: a folder may have moved, or an older build may have written absolute rows since our last open.
    this.repairRecordingPaths();
    this.db.exec("UPDATE chunks SET status='queued', error='Recovered an interrupted transcription after restart.' WHERE status='running' AND meetingId NOT IN (SELECT id FROM meetings WHERE audioRemovedAt IS NOT NULL)");
    this.backfillSegments();
  }
  /** Resolve a recording reference at the disk boundary; empty means removed, not the data folder. */
  resolvePath(path: string): string {
    return resolveRecordingPath(this.directory, path);
  }
  /** Normalize before testing containment, but never change the spelling of an outside absolute reference. */
  private relativePath(path: string): string | null {
    return dataRelativeRecordingPath(this.directory, path);
  }
  /** Store owned files relative to data; imports outside it retain their absolute location. */
  private storedPath(path: string): string {
    if (!path) return path;
    const absolute = isAbsolute(path) ? path : resolve(path);
    return this.relativePath(absolute) ?? absolute;
  }
  private repairRecordingPaths() {
    this.transaction(() => {
      const absolutePaths = sep === '/' ? "path GLOB '/*'"
        : "(path GLOB '[A-Za-z]:[/\\\\]*' OR path GLOB '[/\\\\]*')";
      for (const table of ['frames', 'chunks']) {
        // Filter native absolute paths in SQLite; relative and removed rows need no JS or filesystem work.
        const rows = this.db.prepare(`SELECT id,meetingId,path FROM ${table} WHERE path <> '' AND ${absolutePaths}`).all() as { id: string; meetingId: string; path: string }[];
        const update = this.db.prepare(`UPDATE ${table} SET path=? WHERE id=?`);
        for (const row of rows) {
          const candidate = repairedRecordingPath(this.directory, row.path, row.meetingId);
          if (candidate !== row.path) update.run(candidate, row.id);
        }
      }
      // A marker only: never use this to skip repair, and do not downgrade a future schema version.
      if (Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 3) this.db.exec('PRAGMA user_version = 3');
    });
  }
  /** Completed chunks from before segments existed get them once; legacy native timings are kept. */
  private backfillSegments() {
    const missing = this.db.prepare(`SELECT * FROM chunks c WHERE status='completed' AND text <> ''
      AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.chunkId = c.id)`).all() as Chunk[];
    for (const chunk of missing) this.transaction(() => this.publishSegments(chunk, chunk.text, chunk.metrics ? JSON.parse(chunk.metrics) : null));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Own a new file until its row commits. A failed write/sync/publication must not strand audio on disk. */
  private async writeAudio(table: 'frames' | 'chunks', id: string, path: string, pcm: Buffer, publish: () => void) {
    const directory = dirname(path), file = await openAudioFile(directory, path);
    try {
      try { await file.writeFile(pcm); await file.sync(); } finally { await file.close(); }
      await syncDirectory(directory);
      publish();
    } catch (error) {
      // Never delete a file whose publication did commit. If the database cannot be read, startup reconciliation decides.
      try { if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) await rm(path, { force: true }); }
      catch { /* Best effort while storage is failing; removeOrphanAudioFiles retries at startup. */ }
      throw error;
    }
  }
  private publishSegments(chunk: Chunk, text: string, metrics: Partial<Recognition> & { segments?: { text: string; t0Ms: number; t1Ms: number }[] } | null) {
    const insert = this.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    buildSegments(chunk.seconds * 1000, { text, words: metrics?.words, segments: metrics?.segments }).forEach((segment, ord) => {
      insert.run(`${chunk.id}:${ord}`, chunk.meetingId, chunk.id, chunk.source, ord, chunk.startMs + segment.startMs,
        chunk.startMs + segment.endMs, segment.text, segment.text, segment.timing);
    });
  }
  /** Chunk result and its segments become visible together; published segments are never re-split. */
  completeChunk(id: string, result: Recognition) {
    this.transaction(() => {
      const chunk = this.chunk(id);
      if (!chunk) throw new Error('Chunk not found.');
      this.setStatus(id, 'completed', result.text, null, result);
      const existing = this.db.prepare('SELECT 1 FROM segments WHERE chunkId=? LIMIT 1').get(id);
      if (!existing) this.publishSegments(chunk, result.text, result);
    });
  }
  segments(meetingId: string): Segment[] {
    return this.db.prepare('SELECT * FROM segments WHERE meetingId=? ORDER BY startMs, ord').all(meetingId) as Segment[];
  }
  segment(id: string): Segment | undefined {
    return this.db.prepare('SELECT * FROM segments WHERE id=?').get(id) as Segment | undefined;
  }
  replay(meetingId: string): Replay | null {
    const raw = this.meeting(meetingId).replay;
    return raw ? JSON.parse(raw) as Replay : null;
  }
  /** Replay plays one source from its own start; wall-clock time keeps running across restarts. */
  startReplay(meetingId: string, sourceId: string, speed: number, now = Date.now()) {
    if (this.replay(meetingId)) throw new Error('This meeting has already been replayed; replay the file again into a new meeting.');
    const chunks = this.chunks(meetingId);
    const own = chunks.filter(c => c.source === sourceId);
    if (!own.length) throw new Error('Replay needs an imported source in this meeting.');
    if (chunks.some(c => c.source !== sourceId)) throw new Error('Replay must use a meeting that holds only that source.');
    const baseMs = Math.min(...own.map(c => c.startMs));
    const durationMs = Math.max(...own.map(c => c.startMs + c.seconds * 1000)) - baseMs;
    const replay: Replay = { sourceId, startedAt: now, speed, baseMs, durationMs };
    this.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify(replay), meetingId);
    return replay;
  }
  replayPositionMs(replay: Replay, now = Date.now()) {
    return Math.min(replay.durationMs, Math.max(0, (now - replay.startedAt) * replay.speed));
  }
  /** The single answer to "what has been said so far" for the UI, corrections and later agents. */
  visibleSegments(meetingId: string, now = Date.now()): Segment[] {
    const replay = this.replay(meetingId);
    const all = this.segments(meetingId);
    if (!replay) return all;
    const position = this.replayPositionMs(replay, now);
    return all.filter(s => s.source === replay.sourceId && s.endMs - replay.baseMs <= position);
  }
  /** Compare-and-swap on revision: a correction computed from older text is refused. */
  applyEdits(id: string, baseRevision: number, text: string, edits: Edit[]): boolean {
    const result = this.db.prepare('UPDATE segments SET text=?, edits=?, revision=revision+1 WHERE id=? AND revision=?')
      .run(text, JSON.stringify(edits), id, baseRevision);
    return Number(result.changes) === 1;
  }
  markCorrectionChecked(ids: string[], glossaryVersion: number) {
    const mark = this.db.prepare('UPDATE segments SET correctionChecked=? WHERE id=?');
    this.transaction(() => { for (const id of ids) mark.run(glossaryVersion, id); });
  }
  correctionState<T>(meetingId: string): T | null {
    const raw = this.meeting(meetingId).correction;
    return raw ? JSON.parse(raw) as T : null;
  }
  setCorrectionState(meetingId: string, state: unknown) {
    this.db.prepare('UPDATE meetings SET correction=? WHERE id=?').run(JSON.stringify(state), meetingId);
  }
  createMeeting(title = 'Untitled meeting'): Meeting {
    const meeting: Meeting = { id: randomUUID(), title, createdAt: Date.now(), mode: 'periodic', intervalSeconds: 60, replay: null, correction: null,
      audioDoneAt: null, audioRemovedAt: null, audioRemovedAfter: null, audioLegacy: 0, audioKept: 0, audioGeneration: 0, audioEmpty: 0 };
    this.db.prepare('INSERT INTO meetings (id,title,createdAt,audioLegacy) VALUES (?,?,?,0)').run(meeting.id, title, meeting.createdAt);
    return meeting;
  }
  meeting(id: string): Meeting {
    const result = this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as Meeting | undefined;
    if (!result) throw new Error('Meeting not found.');
    return result;
  }
  meetings(): Meeting[] {
    return this.db.prepare('SELECT * FROM meetings ORDER BY createdAt DESC').all() as Meeting[];
  }
  rename(id: string, title: string) {
    this.meeting(id);
    this.db.prepare('UPDATE meetings SET title=? WHERE id=?').run(title, id);
  }
  updateMode(id: string, mode: Mode, intervalSeconds: number) {
    this.meeting(id);
    this.db.prepare('UPDATE meetings SET mode=?, intervalSeconds=? WHERE id=?').run(mode, intervalSeconds, id);
  }
  chunks(id: string): Chunk[] {
    this.meeting(id);
    return this.db.prepare('SELECT * FROM chunks WHERE meetingId=? ORDER BY startMs, sequence').all(id) as Chunk[];
  }
  queuedCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE status IN ('queued','running')").get() as { count: number }).count);
  }
  nextChunk(now = Date.now()): Chunk | undefined {
    return this.db.prepare("SELECT * FROM chunks WHERE status='queued' AND (retryAt IS NULL OR retryAt <= ?) AND path <> '' AND meetingId NOT IN (SELECT id FROM meetings WHERE audioRemovedAt IS NOT NULL) ORDER BY rowid LIMIT 1").get(now) as Chunk | undefined;
  }
  nextRetryAt(): number | null {
    return (this.db.prepare("SELECT MIN(retryAt) AS at FROM chunks WHERE status='queued' AND path <> '' AND meetingId NOT IN (SELECT id FROM meetings WHERE audioRemovedAt IS NOT NULL)").get() as { at: number | null }).at;
  }
  startChunk(id: string) {
    this.transaction(() => {
      this.setStatus(id, 'running');
      this.db.prepare('UPDATE chunks SET attempts=attempts+1, retryAt=NULL WHERE id=?').run(id);
    });
  }
  failChunk(id: string, error: string, retryAt: number | null) {
    this.transaction(() => {
      this.setStatus(id, retryAt === null ? 'failed' : 'queued', '', error);
      this.db.prepare('UPDATE chunks SET retryAt=? WHERE id=?').run(retryAt, id);
    });
  }
  /** Manual retry starts a fresh bounded budget, unlike an automatic retry. */
  retryChunk(id: string) {
    this.transaction(() => {
      this.setStatus(id, 'queued');
      this.db.prepare('UPDATE chunks SET attempts=0, retryAt=NULL WHERE id=?').run(id);
    });
  }
  setStatus(id: string, status: Chunk['status'], text = '', error: string | null = null, metrics: unknown = null) {
    const chunk = this.chunk(id);
    if (chunk && !chunk.path) throw Object.assign(new Error('Audio removed; transcription cannot be retried.'), { status: 409 });
    this.db.prepare('UPDATE chunks SET status=?, text=?, error=?, metrics=?, completedAt=? WHERE id=?')
      .run(status, text, error, metrics === null ? null : JSON.stringify(metrics), status === 'completed' ? Date.now() : null, id);
    if (chunk && status !== 'completed') this.db.prepare('UPDATE meetings SET audioDoneAt=NULL WHERE id=?').run(chunk.meetingId);
  }
  chunk(id: string): Chunk | undefined {
    return this.db.prepare('SELECT * FROM chunks WHERE id=?').get(id) as Chunk | undefined;
  }
  /** A replay meeting is immutable: new audio would be hidden by its source filter, so refuse it. */
  assertAudioAvailable(meetingId: string) {
    if (this.meeting(meetingId).audioRemovedAt !== null) throw Object.assign(new Error('Audio removed; transcription cannot be retried.'), { status: 409 });
  }
  recordingStarted(meetingId: string) {
    this.meeting(meetingId);
    // The previous generation's durable cleanup record remains independent of this meeting's current capture.
    this.db.prepare(`UPDATE meetings SET audioGeneration=audioGeneration + CASE WHEN audioRemovedAt IS NULL THEN 0 ELSE 1 END,
      audioLegacy=CASE WHEN audioRemovedAt IS NULL THEN audioLegacy ELSE 0 END,
      audioRemovedAt=NULL, audioRemovedAfter=NULL, audioDoneAt=NULL, recordingEndedAt=NULL, audioEmpty=0 WHERE id=?`).run(meetingId);
  }
  /** Legacy files have no prefix; resumed generations always do, so cleanup never enumerates new audio as old. */
  private audioName(meetingId: string, name: string) {
    const generation = this.meeting(meetingId).audioGeneration;
    return generation ? `g${generation}-${name}` : name;
  }
  claimRecording(meetingId: string, source: string, pageId: string | null) {
    const previous = this.db.prepare('SELECT state FROM recording_sources WHERE meetingId=? AND source=?').get(meetingId, source) as { state: string } | undefined;
    // Early HTTP admission may precede body validation; never reopen a finished source just to reject its frame later.
    if (previous?.state === 'ended') return;
    this.recordingStarted(meetingId);
    this.db.prepare(`INSERT INTO recording_sources(meetingId,source,pageId,state) VALUES (?,?,?,'open')
      ON CONFLICT(meetingId,source) DO UPDATE SET pageId=excluded.pageId, state='open'`).run(meetingId, source, pageId);
  }
  openRecordings() {
    return this.db.prepare("SELECT meetingId,source,pageId,state FROM recording_sources WHERE state IN ('open','recovering')").all() as { meetingId: string; source: string; pageId: string | null; state: string }[];
  }
  recordingUnended(meetingId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM recording_sources WHERE meetingId=? AND state IN ('open','recovering') LIMIT 1").get(meetingId));
  }
  recoverRecordings() { this.db.exec("UPDATE recording_sources SET state='recovering' WHERE state='open'"); }
  finishRecordingSource(meetingId: string, source: string, state: 'ended' | 'abandoned', now: number) {
    this.db.prepare('UPDATE recording_sources SET state=? WHERE meetingId=? AND source=?').run(state, meetingId, source);
    if (!this.recordingUnended(meetingId) && !this.heldFrames(meetingId).length) this.recordingEnded(meetingId, now);
  }
  recordingEnded(meetingId: string, now = Date.now()) {
    this.db.prepare('UPDATE meetings SET recordingEndedAt=? WHERE id=?').run(now, meetingId);
  }
  private assertNotReplay(meetingId: string) {
    if (this.meeting(meetingId).replay) throw new CaptureConflict('This meeting is a replay; create a new meeting to record or import.');
  }
  /**
   * Saves one live frame before it is acknowledged. A repeat with the same bytes returns the saved frame (`added: false`);
   * anything else out of order, overlapping or leaving a gap is refused. Frames are 1 s; a shorter one ends the source.
   */
  async addFrame(meetingId: string, source: string, sequence: number, startMs: number, pcm: Buffer, timing?: CaptureTiming): Promise<{ frame: Frame; added: boolean }> {
    this.assertNotReplay(meetingId);
    const recording = this.db.prepare('SELECT state FROM recording_sources WHERE meetingId=? AND source=?').get(meetingId, source) as { state: string } | undefined;
    if (recording?.state === 'ended') throw new CaptureConflict('This audio source has ended; start a new recording.');
    const samples = pcm.length / 4;
    if (!samples || !Number.isInteger(samples) || samples > FRAME_SAMPLES) throw new CaptureConflict('A live audio frame holds at most 1 s of float32 samples.');
    const hash = createHash('sha256').update(pcm).digest('hex');
    const previous = this.db.prepare('SELECT * FROM frames WHERE meetingId=? AND source=? AND sequence=?').get(meetingId, source, sequence) as Frame | undefined;
    if (previous) {
      if (!previous.path) throw new CaptureConflict('This audio source was removed; start a new recording source.');
      if (previous.hash !== hash || previous.startMs !== startMs) throw new CaptureConflict('A different audio frame already uses this source and sequence.');
      return { frame: previous, added: false };
    }
    const last = this.db.prepare('SELECT * FROM frames WHERE meetingId=? AND source=? ORDER BY sequence DESC LIMIT 1').get(meetingId, source) as Frame | undefined;
    const expected = last ? last.sequence + 1 : 0;
    if (sequence !== expected) throw new CaptureConflict(`Audio frame ${sequence} arrived out of order; expected ${expected}.`);
    if (last && last.samples < FRAME_SAMPLES) throw new CaptureConflict('This source already sent its last (partial) frame.');
    if (last && Math.abs(startMs - (last.startMs + last.samples * 1000 / FRAME_RATE)) > 1) throw new CaptureConflict('This frame does not start where the previous one ended.');
    this.recordingStarted(meetingId);
    const id = randomUUID();
    const directory = join(this.directory, 'audio', meetingId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, this.audioName(meetingId, `${id}.frame.f32`));
    await this.writeAudio('frames', id, path, pcm, () => {
      this.assertNotReplay(meetingId);
      this.recordingStarted(meetingId);
      // The metadata and frame row commit together; a retry after a lost reply cannot duplicate or lose the note.
      const { gaps, endWallMs } = detectFrameCaptureGaps(last, timing, startMs, samples, FRAME_RATE);
      this.transaction(() => {
        this.db.prepare('INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash,savedAt,captureWallMs,captureEndWallMs) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, meetingId, source, sequence, this.storedPath(path), startMs, samples, hash, Date.now(), timing?.captureWallMs ?? null, endWallMs);
        for (const gap of gaps) this.db.prepare('INSERT INTO capture_gaps (meetingId,source,atMs,fromWallMs,toWallMs,reason) VALUES (?,?,?,?,?,?)')
          .run(meetingId, source, gap.atMs, gap.fromWallMs, gap.toWallMs, gap.reason);
      });
    });
    return { frame: this.db.prepare('SELECT * FROM frames WHERE id=?').get(id) as Frame, added: true };
  }
  /** Merged only for presentation; the durable evidence remains per source. */
  captureGaps(meetingId: string): CaptureGap[] {
    return mergeCaptureGaps(this.db.prepare('SELECT * FROM capture_gaps WHERE meetingId=?').all(meetingId) as CaptureGap[]);
  }
  /** How a live source is captured (device label, room mode, browser processing), as the browser reported it. */
  setSourceSettings(meetingId: string, source: string, settings: Record<string, unknown>) {
    this.db.prepare('INSERT INTO source_settings (meetingId, source, settings) VALUES (?,?,?) ON CONFLICT(meetingId, source) DO UPDATE SET settings=excluded.settings').run(meetingId, source, JSON.stringify(settings));
  }
  sourceSettings(meetingId: string): Record<string, Record<string, unknown>> {
    const rows = this.db.prepare('SELECT source, settings FROM source_settings WHERE meetingId=?').all(meetingId) as { source: string; settings: string }[];
    return Object.fromEntries(rows.map(r => [r.source, JSON.parse(r.settings)]));
  }
  lastFrameSequence(meetingId: string, source: string): number | null {
    return (this.db.prepare('SELECT MAX(sequence) AS last FROM frames WHERE meetingId=? AND source=?').get(meetingId, source) as { last: number | null }).last;
  }
  /** Frames of a source not yet in a window, in order. */
  heldFrames(meetingId: string, source?: string): Frame[] {
    return (source === undefined
      ? this.db.prepare('SELECT * FROM frames WHERE meetingId=? AND windowChunkId IS NULL ORDER BY source, sequence').all(meetingId)
      : this.db.prepare('SELECT * FROM frames WHERE meetingId=? AND source=? AND windowChunkId IS NULL ORDER BY sequence').all(meetingId, source)) as Frame[];
  }
  /** Meetings and sources that still hold frames (startup recovery). */
  heldSources(): { meetingId: string; source: string }[] {
    return this.db.prepare('SELECT DISTINCT meetingId, source FROM frames WHERE windowChunkId IS NULL').all() as { meetingId: string; source: string }[];
  }
  /**
   * Groups held frames (consecutive, in order) into one transcription window. The window's PCM is written first; the chunk row
   * and the frames' link to it are committed together, so a crash either leaves the frames held (the seal runs again) or
   * fully sealed. The window's identity is its first frame's sequence, so a repeated seal cannot make a second window.
   */
  async sealWindow(meetingId: string, frames: Frame[]): Promise<Chunk> {
    if (frames.some(f => !(this.db.prepare('SELECT path FROM frames WHERE id=?').get(f.id) as { path: string } | undefined)?.path)) {
      throw new Error('Audio removed; transcription cannot be retried.');
    }
    if (!frames.length) throw new Error('Nothing to seal.');
    const source = frames[0].source;
    frames.forEach((f, i) => { if (f.source !== source || (i && f.sequence !== frames[i - 1].sequence + 1)) throw new Error('A window needs consecutive frames of one source.'); });
    const parts = await Promise.all(frames.map(f => readFile(this.resolvePath(f.path))));
    const pcm = Buffer.concat(parts);
    const hash = createHash('sha256').update(pcm).digest('hex');
    const id = randomUUID();
    const path = join(this.directory, 'audio', meetingId, this.audioName(meetingId, `${id}.f32`));
    await this.writeAudio('chunks', id, path, pcm, () => {
      this.transaction(() => {
        const held = this.db.prepare(`SELECT COUNT(*) AS n FROM frames WHERE meetingId=? AND source=? AND sequence BETWEEN ? AND ? AND windowChunkId IS NULL`)
          .get(meetingId, source, frames[0].sequence, frames.at(-1)!.sequence) as { n: number };
        if (Number(held.n) !== frames.length) throw new Error('These frames were already sealed.');
        this.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
          VALUES (?,?,?,?,?,0,?,?,?,'queued',?)`).run(id, meetingId, source, frames[0].sequence, this.storedPath(path), frames[0].startMs, pcm.length / 4 / FRAME_RATE, FRAME_RATE, hash);
        this.db.prepare('UPDATE frames SET windowChunkId=? WHERE meetingId=? AND source=? AND sequence BETWEEN ? AND ?')
          .run(id, meetingId, source, frames[0].sequence, frames.at(-1)!.sequence);
      });
    });
    // Committed: the window is queued whatever happens next. Frame files are only cleanup (retried at startup).
    await Promise.allSettled(frames.map(f => rm(this.resolvePath(f.path), { force: true })));
    return this.chunk(id)!;
  }
  /** Startup only, under the server lock and before jobs/capture: reclaim writes interrupted before publication. */
  async removeOrphanAudioFiles() {
    const data = await realpath(this.directory), root = join(data, 'audio');
    if (!(await lstat(root).catch(() => null))?.isDirectory() || await realpath(root) !== root) return;
    const referenced = new Set((this.db.prepare("SELECT path FROM frames WHERE path<>'' UNION SELECT path FROM chunks WHERE path<>''").all() as { path: string }[])
      .map(row => { const path = resolve(this.resolvePath(row.path)), relative = this.relativePath(path); return relative === null ? path : join(data, relative); }));
    for (const meeting of await readdir(root)) {
      if (!/^[a-f0-9-]{36}$/.test(meeting)) continue;
      const folder = join(root, meeting);
      if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) continue;
      for (const name of await readdir(folder)) {
        if (!/^(?:g[1-9]\d*-)?[a-f0-9-]{36}(?:\.frame)?\.f32$/.test(name)) continue;
        const path = join(folder, name);
        if (!referenced.has(path) && (await lstat(path)).isFile()) await rm(path, { force: true });
      }
    }
  }
  /** Removes frame files whose audio is already in a window (a crash between the seal and the cleanup). */
  async removeSealedFrameFiles() {
    // Only when the window's own file exists: otherwise the frame files are the only copy of that audio.
    const sealed = this.db.prepare(`SELECT f.path AS path, c.path AS windowPath FROM frames f JOIN chunks c ON c.id = f.windowChunkId`).all() as { path: string; windowPath: string }[];
    await Promise.allSettled(sealed.map(async f => {
      if (!f.path || !f.windowPath) return;
      await access(this.resolvePath(f.windowPath)); await rm(this.resolvePath(f.path), { force: true });
    }));
  }
  /** Speaker roles of a meeting's sources (see speakers.ts), from saved chunks and held frames. */
  speakers(meetingId: string): Speakers {
    const ranges = [
      ...(this.db.prepare('SELECT source, MIN(startMs) AS startMs, MAX(startMs + seconds * 1000) AS endMs FROM chunks WHERE meetingId=? GROUP BY source').all(meetingId) as { source: string; startMs: number; endMs: number }[]),
      ...(this.db.prepare(`SELECT source, MIN(startMs) AS startMs, MAX(startMs + samples * 1000.0 / ${FRAME_RATE}) AS endMs FROM frames WHERE meetingId=? GROUP BY source`).all(meetingId) as { source: string; startMs: number; endMs: number }[]),
    ];
    return rolesFor(ranges);
  }
  /** End of all audio saved for a meeting, including frames not yet in a window: new capture and imports start here. */
  audioEndMs(meetingId: string): number {
    const chunks = this.db.prepare('SELECT MAX(startMs + seconds * 1000) AS end FROM chunks WHERE meetingId=?').get(meetingId) as { end: number | null };
    const frames = this.db.prepare(`SELECT MAX(startMs + samples * 1000.0 / ${FRAME_RATE}) AS end FROM frames WHERE meetingId=? AND windowChunkId IS NULL`).get(meetingId) as { end: number | null };
    return Math.max(0, chunks.end ?? 0, frames.end ?? 0);
  }
  async addPcm(meetingId: string, source: string, sequence: number, startMs: number, sampleRate: number, pcm: Buffer) {
    this.assertNotReplay(meetingId);
    const hash = createHash('sha256').update(pcm).digest('hex');
    const previous = this.db.prepare('SELECT * FROM chunks WHERE meetingId=? AND source=? AND sequence=?')
      .get(meetingId, source, sequence) as Chunk | undefined;
    if (previous) {
      if (!previous.path) throw new Error('This audio source was removed; start a new recording source.');
      if (previous.hash !== hash || previous.startMs !== startMs || previous.sampleRate !== sampleRate) {
        throw new Error('A different audio chunk already uses this source and sequence.');
      }
      return previous;
    }
    this.recordingStarted(meetingId);
    const id = randomUUID();
    const directory = join(this.directory, 'audio', meetingId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, this.audioName(meetingId, `${id}.f32`));
    await this.writeAudio('chunks', id, path, pcm, () => {
      // A replay may have started while the audio was being written; re-check right before the insert.
      this.assertNotReplay(meetingId);
      this.recordingStarted(meetingId);
      this.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
        VALUES (?,?,?,?,?,0,?,?,?,'queued',?)`).run(id, meetingId, source, sequence, this.storedPath(path), startMs, pcm.length / 4 / sampleRate, sampleRate, hash);
    });
    return this.chunk(id)!;
  }
  addMedia(meetingId: string, path: string, duration: number) {
    this.assertNotReplay(meetingId);
    this.recordingStarted(meetingId);
    const source = `file:${randomUUID()}`;
    const offset = this.audioEndMs(meetingId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let sequence = 0;
      for (let start = 0; start < duration; start += CHUNK_SECONDS) {
        this.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
          VALUES (?,?,?,?,?,?,?,?,NULL,'queued','file')`)
          .run(randomUUID(), meetingId, source, sequence++, this.storedPath(path), start, offset + start * 1000, Math.min(CHUNK_SECONDS, duration - start));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return source;
  }
  /** Both exports share entries and paragraph boundaries; only their presentation differs. */
  private transcriptParagraphs(id: string, mode: 'corrected' | 'raw', locale?: string, plain = false) {
    const prefix = (ms: number) => plain ? '' : `[${new Date(ms).toISOString().slice(11, 19)}] `;
    // Online meetings (a tab source): Me/Them per paragraph, a new paragraph at each change of speaker, one fixed order.
    const { labelled, roleOf } = this.speakers(id);
    const segments = this.segments(id);
    if (labelled) segments.sort(compareSegments);
    const entries = [
      ...this.captureGaps(id).map(g => ({ at: g.atMs, end: g.atMs, gap: plain ? `[${captureGapText(g, locale, false)}]` : `*${captureGapText(g, locale)}*` })),
      ...segments.map(s => ({ at: s.startMs, end: s.endMs, text: mode === 'raw' ? s.originalText : s.text, speaker: labelled ? roleOf(s.source, s.startMs, s.endMs) ?? null : null })),
      ...this.chunks(id).filter(c => c.status !== 'completed').map(c => ({ at: c.startMs, end: c.startMs, gap: `[${c.status}: ${c.error ?? 'not transcribed'}]` })),
    ].sort((a, b) => a.at - b.at);
    const paragraphs: string[] = [];
    let current: string[] = [];
    let start = 0;
    let last = -Infinity;
    let speaker: Role | null = null;
    const label = () => (speaker ? `${ROLE_LABEL[speaker]}: ` : '');
    for (const entry of entries) {
      const changed = labelled && !('gap' in entry) && entry.speaker !== speaker;
      if (current.length && ('gap' in entry || changed || entry.at - last >= 2000 || entry.at - start >= 45_000)) { paragraphs.push(`${prefix(start)}${label()}${current.join(' ')}`); current = []; }
      if ('gap' in entry) { paragraphs.push(`${prefix(entry.at)}${entry.gap}`); continue; }
      if (!current.length) { start = entry.at; speaker = entry.speaker; last = entry.end; }
      current.push(entry.text);
      last = labelled ? Math.max(last, entry.end) : entry.end; // overlapping sources: the latest end within this paragraph
    }
    if (current.length) paragraphs.push(`${prefix(start)}${label()}${current.join(' ')}`);
    return { labelled, paragraphs };
  }
  plainText(id: string): string {
    const title = this.meeting(id).title.replace(/[\r\n]/g, ' ');
    const { paragraphs } = this.transcriptParagraphs(id, 'corrected', undefined, true);
    return `${title}${paragraphs.length ? `\n\n${paragraphs.join('\n\n')}` : ''}\n`;
  }
  /** Paragraph export from segments; failed chunks stay visible as gaps rather than disappearing. */
  markdown(id: string, mode: 'corrected' | 'raw' = 'corrected', locale?: string): string {
    const meeting = this.meeting(id);
    const { labelled, paragraphs } = this.transcriptParagraphs(id, mode, locale);
    const note = mode === 'raw' ? 'Raw speech recognition, before glossary corrections.' : 'Glossary-corrected where marked in the app; raw export is available.';
    const who = labelled ? 'Speaker labels are capture channels: "Them" is the meeting tab (everyone on the call), "Me" is this microphone during the call.' : 'No speaker labels;';
    return `# ${meeting.title.replace(/[\r\n]/g, ' ')}\n\nTranscript — ${note} ${who}${labelled ? ' Not' : ' not'} verified meeting decisions.\n\n${paragraphs.join('\n\n')}\n`;
  }
  close() { this.db.close(); }
}
