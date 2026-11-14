import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { dataRelativeRecordingPath, repairedRecordingPath } from './recording-paths.ts';
import { CHUNK_SECONDS } from './audio.ts';
import { deleteMeeting, inspectMeetingDeletion } from './delete-meeting.ts';
import { buildSegments, wordSegments, EARLIER_SHORT_SENTENCE_PAUSE_MS, type Timing } from './segments.ts';
import { echoWords, type EchoWord } from './echo-words.ts';
import type { Recognition } from './recognizer.ts';
import { ROLE_LABEL, compareSegments, rolesFor, echoesFor, type Speakers } from './speakers.ts';
import { detectFrameCaptureGaps, type CaptureTiming } from './capture-gaps.ts';
import { CaptureConflict } from './capture-error.ts';
import { heldMicrophoneFinals } from './live-finals.ts';
import { captureGapText, mergeCaptureGaps, type CaptureGap } from '../public/capture-gaps.js';
import { paragraphsOf } from '../public/live-shared.js';

export type Mode = 'periodic' | 'manual' | 'questions';
/** autoTitle: the name HearAlong itself last gave the meeting (its dated name, or the notes' title); null once the user named it.
 * Notes may rename only while the title still equals it, so a rename by any build, older ones included, keeps the user's name. */
export type Meeting = { id: string; title: string; autoTitle: string | null; createdAt: number; mode: Mode; intervalSeconds: number; replay: string | null; correction: string | null;
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
  attempts: number; retryAt: number | null; completedAt?: number | null;
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

/** The page's dated name for a new meeting (public/app.js, "New meeting"), in the Mac's locale or in English. */
const STAMP_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
/** Exactly a name the app made up: "Untitled meeting", or "Meeting " and the page's stamp of the creation time (the page
 * stamps a moment before the server records createdAt, so the previous minute counts too). Anything else is the user's. */
export function isAppMadeTitle(title: string, createdAt: number): boolean {
  if (title === 'Untitled meeting') return true;
  if (!title.startsWith('Meeting ')) return false;
  // Browser and ICU versions differ only in which space precedes AM/PM (U+202F, U+00A0 or a plain space).
  const spaces = (text: string) => text.replace(/[\u202f\u00a0]/g, ' ');
  const stamp = spaces(title.slice('Meeting '.length));
  for (const locale of [undefined, 'en-US']) for (const at of [createdAt, createdAt - 60_000]) {
    if (spaces(new Date(at).toLocaleString(locale, STAMP_OPTIONS)) === stamp) return true;
  }
  return false;
}
/** The notes' suggested title as a meeting name: one line, no wrapping quotes or final full stop, at most 80 characters. */
export function cleanSuggestedTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  let title = value.replace(/\s+/g, ' ').trim();
  for (let previous = ''; previous !== title;) {
    previous = title;
    const chars = Array.from(title), open = chars[0], close = chars.at(-1);
    // Only a pair that wraps the whole title: '"Q3" vs "Q4"' has more of the same quotes inside and stays.
    if (chars.length >= 2 && open !== undefined && close !== undefined && QUOTE_PAIRS[open]?.includes(close)) {
      const inner = chars.slice(1, -1);
      if (!inner.some(c => c === open || c === close || QUOTE_PAIRS[open].includes(c))) title = inner.join('').trim();
    }
  }
  // One sentence-ending full stop; an ellipsis ("..."), an initialism ("U.S.") or a short abbreviation ("etc.") stays.
  if (/[^.]\.$/.test(title) && !/(?:^|[\s.])\p{L}\.$/u.test(title) && !SHORT_ABBREVIATION.test(title)) title = title.slice(0, -1).trim();
  const chars = Array.from(title);
  if (chars.length > 80) {
    const cut = chars.slice(0, 81).join('');
    const space = cut.lastIndexOf(' ');
    title = (space > 0 ? cut.slice(0, space) : chars.slice(0, 80).join('')).replace(/[\s,;:–—-]+$/u, '');
  }
  return /[\p{L}\p{N}]/u.test(title) ? title : '';
}
const QUOTE_PAIRS: Record<string, string> = { '"': '"“”', "'": "'‘’", '“': '”"', '”': '”', '‘': '’\'', '’': '’', '«': '»', '»': '«', '`': '`' };
const SHORT_ABBREVIATION = /(?:^|\s)(?:etc|vs|approx|incl|misc|dept|corp|inc|ltd|co|no|vol|mr|mrs|ms|dr|prof|st|jr|sr)\.$/i;

export class MeetingStore {
  db: DatabaseSync;
  directory: string;
  private deletionGuards = new Map<string, (id: string) => boolean>();
  private transcriptVersion = 0;
  /** Bounded to four meetings. Entries are private; callers receive fresh segment objects. */
  private transcripts = new Map<string, { version: number; external: number; roles: string; capture: string; all: Segment[]; echoes: Set<string>; wordsFor: (segment: Segment) => EchoWord[] | undefined }>();
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
      CREATE TABLE IF NOT EXISTS chunk_originals (id TEXT PRIMARY KEY REFERENCES chunks(id),
        meetingId TEXT NOT NULL REFERENCES meetings(id), path TEXT NOT NULL, hash TEXT NOT NULL);
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
    if (!columns.includes('autoTitle')) this.addAutoTitle();
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
    // Connection-local only: no persisted schema/data change. A JS epoch also advances for rolled-back writes.
    this.db.function('hearalong_transcript_changed', () => { this.transcriptVersion++; return null; });
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) this.db.exec(`CREATE TEMP TRIGGER transcript_${event}
      AFTER ${event} ON main.segments BEGIN SELECT hearalong_transcript_changed(); END`);
    this.db.exec(`CREATE TEMP TRIGGER transcript_chunk_words AFTER UPDATE OF metrics,startMs,seconds,source ON main.chunks
      BEGIN SELECT hearalong_transcript_changed(); END`);
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
      // An older binary may have removed this meeting's audio without knowing about originals.
      this.db.exec("UPDATE chunk_originals SET path='' WHERE path<>'' AND meetingId IN (SELECT id FROM meetings WHERE audioRemovedAt IS NOT NULL)");
      const absolutePaths = sep === '/' ? "path GLOB '/*'"
        : "(path GLOB '[A-Za-z]:[/\\\\]*' OR path GLOB '[/\\\\]*')";
      for (const table of ['frames', 'chunks', 'chunk_originals']) {
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
  /** Rows from before the column: an app-made name may later take the notes' title; every other name is the user's.
   * The column and its classification commit together, so a crash cannot leave unclassified rows for a later open. */
  private addAutoTitle() {
    this.transaction(() => {
      this.db.exec('ALTER TABLE meetings ADD COLUMN autoTitle TEXT');
      const mark = this.db.prepare('UPDATE meetings SET autoTitle=title WHERE id=?');
      for (const row of this.db.prepare("SELECT id,title,createdAt FROM meetings WHERE title='Untitled meeting' OR title GLOB 'Meeting *'").all() as { id: string; title: string; createdAt: number }[]) {
        if (isAppMadeTitle(row.title, row.createdAt)) mark.run(row.id);
      }
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
  /** Own all files until their rows commit together. A failed write/sync/publication cannot strand a partial seal. */
  private async writeAudio(table: 'frames' | 'chunks', id: string, path: string, pcm: Buffer, publish: () => void, sidecar?: { path: string; pcm: Buffer }) {
    const directory = dirname(path), created: string[] = [];
    try {
      for (const audio of [{ path, pcm }, ...(sidecar ? [sidecar] : [])]) {
        const file = await openAudioFile(directory, audio.path);
        created.push(audio.path);
        try { await file.writeFile(audio.pcm); await file.sync(); } finally { await file.close(); }
      }
      await syncDirectory(directory);
      publish();
    } catch (error) {
      // Never delete a file whose publication did commit. If the database cannot be read, startup reconciliation decides.
      try { if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) await Promise.all(created.map(file => rm(file, { force: true }))); }
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
  private transcript(meetingId: string, speakers = this.speakers(meetingId)) {
    // TEMP triggers cover all writes through this connection, including direct SQL and metadata-only edits.
    // data_version covers commits made by another SQLite connection. Never cache an uncommitted snapshot.
    const external = (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    const cached = this.transcripts.get(meetingId);
    // Capture edges now affect matching. Clip advancing ends to known transcript bounds so ordinary new frames still hit.
    const captureKey = (all: Segment[]) => {
      let first = Infinity, last = -Infinity;
      for (const s of all) { first = Math.min(first, s.startMs); last = Math.max(last, s.endMs); }
      return JSON.stringify(speakers.tabs.map(t => [Math.max(first, t.startMs), Math.min(last, t.endMs)]));
    };
    if (!this.db.isTransaction && cached?.version === this.transcriptVersion && cached.external === external
      && cached.roles === speakers.cacheKey && cached.capture === captureKey(cached.all)) {
      this.transcripts.delete(meetingId); this.transcripts.set(meetingId, cached);
      return cached;
    }
    // Normalize SQLite's row objects once; cloning ordinary records is much cheaper on every poll.
    const all = (this.db.prepare('SELECT * FROM segments WHERE meetingId=? ORDER BY startMs, ord').all(meetingId) as Segment[]).map(s => ({ ...s }));
    type Parts = ReturnType<typeof wordSegments>;
    // Lines saved before the current short-sentence rule may group differently; that grouping is built only on a mismatch.
    const byChunk = new Map<string, { group: (shortPauseMs?: number) => Parts; current: Parts; earlier?: Parts }>();
    const wordsFor = (segment: Segment): EchoWord[] | undefined => {
      if (segment.timing !== 'word') return undefined;
      let parts = byChunk.get(segment.chunkId);
      if (!parts) {
        const chunk = this.chunk(segment.chunkId);
        if (!chunk) return undefined;
        let metrics: Partial<Recognition> = {};
        try { metrics = chunk.metrics ? JSON.parse(chunk.metrics) : {}; } catch { /* Legacy malformed metrics: use whole text. */ }
        const group = (shortPauseMs?: number): Parts => {
          try {
            return wordSegments(chunk.seconds * 1000, Array.isArray(metrics.words) ? metrics.words : undefined, shortPauseMs).map(p => ({ ...p,
              words: p.words?.map(w => ({ ...w, t0Ms: w.t0Ms + chunk.startMs, t1Ms: w.t1Ms + chunk.startMs })) }));
          } catch { return []; } // Invalid legacy word records cannot make a transcript unreadable.
        };
        parts = { group, current: group() };
        byChunk.set(chunk.id, parts);
      }
      const matches = (part: Parts[number] | undefined) => Boolean(part?.words
        && echoWords(part.text).join(' ') === echoWords(segment.text).join(' ')
        && Math.abs(part.words[0].t0Ms - segment.startMs) <= 1 && Math.abs(part.words.at(-1)!.t1Ms - segment.endMs) <= 1);
      let part = parts.current[segment.ord];
      if (!matches(part)) part = (parts.earlier ??= parts.group(EARLIER_SHORT_SENTENCE_PAUSE_MS))[segment.ord];
      if (!matches(part)) return undefined;
      return part.words!.map(w => ({ text: w.text, startMs: w.t0Ms, endMs: w.t1Ms }));
    };
    const result = { version: this.transcriptVersion, external, roles: speakers.cacheKey, capture: captureKey(all), all,
      echoes: echoesFor(all, speakers, s => wordsFor(s as Segment)), wordsFor };
    if (!this.db.isTransaction) {
      this.transcripts.delete(meetingId); this.transcripts.set(meetingId, result);
      if (this.transcripts.size > 4) this.transcripts.delete(this.transcripts.keys().next().value!);
    }
    return result;
  }
  /** Shared transcript read boundary: echoes stay on disk and addressable by id, but no reader gets doubled lines. */
  segments(meetingId: string): Segment[] {
    const { all, echoes } = this.transcript(meetingId);
    return all.filter(s => !echoes.has(s.id)).map(s => ({ ...s }));
  }
  /** Recent call finals for live preview comparison, using real word times where available. */
  recentCallWords(meetingId: string, sources: Set<string>, afterMs: number): EchoWord[] {
    const snapshot = this.transcript(meetingId);
    return snapshot.all.filter(s => sources.has(s.source) && s.endMs >= afterMs).sort(compareSegments)
      .flatMap(s => snapshot.wordsFor(s) ?? [{ text: s.text, startMs: s.startMs, endMs: s.endMs }]).filter(w => w.endMs >= afterMs);
  }
  /** Main transcript and mini share this display-only hold; exports/AI keep reading settled segments(). */
  displaySegments(meetingId: string, callSources: string[], now: number) {
    const speakers = this.speakers(meetingId);
    if (this.replay(meetingId)) return { speakers, segments: this.visibleSegments(meetingId, now), heldChunks: new Set<string>() };
    const { all, echoes } = this.transcript(meetingId, speakers);
    const held = callSources.length ? heldMicrophoneFinals(all, this.chunks(meetingId), callSources, speakers, now) : new Set<string>();
    return { speakers, segments: all.filter(s => !held.has(s.id) && !echoes.has(s.id)).map(s => ({ ...s })),
      heldChunks: new Set(all.filter(s => held.has(s.id)).map(s => s.chunkId)) };
  }
  /** Resolve a hidden echo citation to an actual surviving span, never an unrelated nearby paragraph. */
  citationSegment(meetingId: string, id: string): string | undefined {
    const { all, echoes } = this.transcript(meetingId);
    const cited = all.find(s => s.id === id);
    if (!cited) return undefined;
    if (!echoes.has(id)) return id;
    const speakers = this.speakers(meetingId);
    const overlap = (s: Segment) => Math.min(s.endMs, cited.endMs) - Math.max(s.startMs, cited.startMs);
    return all.filter(s => !echoes.has(s.id) && speakers.roleOf(s.source, s.startMs, s.endMs) === 'them' && overlap(s) > 0)
      .sort((a, b) => overlap(b) - overlap(a) || compareSegments(a, b))[0]?.id;
  }
  /** Pinned evidence in an old notes file follows the same rule when used in a new prompt, without rewriting it. */
  withoutEchoes<T>(meetingId: string, lines: Record<string, T>): Record<string, T> {
    const { echoes } = this.transcript(meetingId);
    return Object.fromEntries(Object.entries(lines).filter(([id]) => !echoes.has(id)));
  }
  /** Raw id lookup preserves old citations, even when their line is now hidden. */
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
  /** A name given here is the user's unless the caller says the app made it up (the page's dated name). */
  createMeeting(title?: string, madeUp = title === undefined): Meeting {
    title ??= 'Untitled meeting';
    const autoTitle = madeUp ? title : null;
    const meeting: Meeting = { id: randomUUID(), title, autoTitle, createdAt: Date.now(), mode: 'periodic', intervalSeconds: 60, replay: null, correction: null,
      audioDoneAt: null, audioRemovedAt: null, audioRemovedAfter: null, audioLegacy: 0, audioKept: 0, audioGeneration: 0, audioEmpty: 0 };
    this.db.prepare('INSERT INTO meetings (id,title,autoTitle,createdAt,audioLegacy) VALUES (?,?,?,?,0)').run(meeting.id, title, autoTitle, meeting.createdAt);
    return meeting;
  }
  meeting(id: string): Meeting {
    const result = this.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as Meeting | undefined;
    if (!result) throw new Error('Meeting not found.');
    return result;
  }
  meetings(): (Meeting & { recorded: boolean })[] {
    const rows = this.db.prepare(`SELECT meetings.*, (EXISTS (SELECT 1 FROM recording_sources WHERE meetingId=meetings.id)
      OR EXISTS (SELECT 1 FROM chunks WHERE meetingId=meetings.id)) AS recorded FROM meetings ORDER BY createdAt DESC`).all() as (Meeting & { recorded: number })[];
    return rows.map(row => ({ ...row, recorded: Boolean(row.recorded) }));
  }
  /** The user's rename: from now on the name is theirs and AI never changes it. */
  rename(id: string, title: string) {
    this.meeting(id);
    this.db.prepare('UPDATE meetings SET title=?, autoTitle=NULL WHERE id=?').run(title, id);
  }
  /** Saved notes rename a meeting only while it still has the name HearAlong gave it; a user's name stays. True when renamed. */
  titleFromNotes(id: string, suggestion: unknown): boolean {
    const title = cleanSuggestedTitle(suggestion);
    if (!title) return false;
    return Number(this.db.prepare('UPDATE meetings SET title=?, autoTitle=? WHERE id=? AND autoTitle IS NOT NULL AND title=autoTitle AND title<>?')
      .run(title, title, id, title).changes) > 0;
  }
  updateMode(id: string, mode: Mode, intervalSeconds: number) {
    this.meeting(id);
    this.db.prepare('UPDATE meetings SET mode=?, intervalSeconds=? WHERE id=?').run(mode, intervalSeconds, id);
  }
  chunks(id: string): Chunk[] {
    this.meeting(id);
    return this.db.prepare('SELECT * FROM chunks WHERE meetingId=? ORDER BY startMs, sequence').all(id) as Chunk[];
  }
  /** Original microphone window, for recovery/inspection only; never a recognition or playback source. */
  originalAudio(chunkId: string): { path: string; hash: string } | undefined {
    return this.db.prepare('SELECT path,hash FROM chunk_originals WHERE id=?').get(chunkId) as { path: string; hash: string } | undefined;
  }
  /** All retained recording files, including AEC originals, excluding already-reclaimed sealed frames. Paths stay data-relative. */
  audioFiles(meetingId: string): { kind: 'chunk' | 'frame' | 'raw'; path: string; hash: string }[] {
    this.meeting(meetingId);
    return this.db.prepare(`SELECT 'chunk' AS kind,path,hash FROM chunks WHERE meetingId=? AND path<>''
      UNION SELECT 'raw',path,hash FROM chunk_originals WHERE meetingId=? AND path<>''
      UNION SELECT 'frame',path,hash FROM frames WHERE meetingId=? AND path<>'' AND windowChunkId IS NULL`).all(meetingId, meetingId, meetingId) as ReturnType<MeetingStore['audioFiles']>;
  }
  /** Read-only integrity check of saved recordings. Imported media has no admission hash. */
  async verifyAudioFiles(meetingId: string): Promise<{ path: string; problem: 'missing' | 'hash mismatch' }[]> {
    const problems: Awaited<ReturnType<MeetingStore['verifyAudioFiles']>> = [];
    for (const file of this.audioFiles(meetingId)) {
      try {
        if (file.hash === 'file') { await access(this.resolvePath(file.path)); continue; }
        const pcm = await readFile(this.resolvePath(file.path));
        if (createHash('sha256').update(pcm).digest('hex') !== file.hash) problems.push({ path: file.path, problem: 'hash mismatch' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        problems.push({ path: file.path, problem: 'missing' });
      }
    }
    return problems;
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
    if (source.startsWith('app:') && previous && previous.state !== 'open') throw new CaptureConflict('This app source is ended or abandoned; start a new source.');
    // Early HTTP admission may precede body validation; never reopen a finished source just to reject its frame later.
    if (previous?.state === 'ended') return;
    this.recordingStarted(meetingId);
    this.db.prepare(`INSERT INTO recording_sources(meetingId,source,pageId,state) VALUES (?,?,?,'open')
      ON CONFLICT(meetingId,source) DO UPDATE SET pageId=excluded.pageId, state='open'`).run(meetingId, source, pageId);
  }
  recordingSourceOpen(meetingId: string, source: string, pageId: string | null): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM recording_sources WHERE meetingId=? AND source=? AND pageId IS ? AND state='open'").get(meetingId, source, pageId));
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
  async sealWindow(meetingId: string, frames: Frame[], processedPcm?: Buffer): Promise<Chunk> {
    if (frames.some(f => !(this.db.prepare('SELECT path FROM frames WHERE id=?').get(f.id) as { path: string } | undefined)?.path)) {
      throw new Error('Audio removed; transcription cannot be retried.');
    }
    if (!frames.length) throw new Error('Nothing to seal.');
    const source = frames[0].source;
    frames.forEach((f, i) => { if (f.source !== source || (i && f.sequence !== frames[i - 1].sequence + 1)) throw new Error('A window needs consecutive frames of one source.'); });
    // Live AEC may replace window samples only, never durable raw frames or admission hashes.
    // Recovery/direct callers omit this argument and retain the original raw sealing path.
    if (processedPcm && processedPcm.length !== frames.reduce((sum, frame) => sum + frame.samples * 4, 0)) throw new Error('Processed window must preserve every frame sample.');
    const raw = Buffer.concat(await Promise.all(frames.map(f => readFile(this.resolvePath(f.path)))));
    const pcm = processedPcm ?? raw;
    // LiveCapture also supplies pass-through windows. Only changed samples need a second copy.
    const keepRaw = processedPcm !== undefined && !pcm.equals(raw);
    const hash = createHash('sha256').update(pcm).digest('hex');
    const id = randomUUID();
    const path = join(this.directory, 'audio', meetingId, this.audioName(meetingId, `${id}.f32`));
    const originalPath = path.replace(/\.f32$/, '.raw.f32');
    await this.writeAudio('chunks', id, path, pcm, () => {
      this.transaction(() => {
        const held = this.db.prepare(`SELECT COUNT(*) AS n FROM frames WHERE meetingId=? AND source=? AND sequence BETWEEN ? AND ? AND windowChunkId IS NULL`)
          .get(meetingId, source, frames[0].sequence, frames.at(-1)!.sequence) as { n: number };
        if (Number(held.n) !== frames.length) throw new Error('These frames were already sealed.');
        this.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
          VALUES (?,?,?,?,?,0,?,?,?,'queued',?)`).run(id, meetingId, source, frames[0].sequence, this.storedPath(path), frames[0].startMs, pcm.length / 4 / FRAME_RATE, FRAME_RATE, hash);
        if (keepRaw) this.db.prepare('INSERT INTO chunk_originals (id,meetingId,path,hash) VALUES (?,?,?,?)')
          .run(id, meetingId, this.storedPath(originalPath), createHash('sha256').update(raw).digest('hex'));
        this.db.prepare('UPDATE frames SET windowChunkId=? WHERE meetingId=? AND source=? AND sequence BETWEEN ? AND ?')
          .run(id, meetingId, source, frames[0].sequence, frames.at(-1)!.sequence);
      });
    }, keepRaw ? { path: originalPath, pcm: raw } : undefined);
    // Committed: both files and their hashes are published. Frame files are only cleanup (retried at startup).
    await Promise.allSettled(frames.map(f => rm(this.resolvePath(f.path), { force: true })));
    return this.chunk(id)!;
  }
  /** Startup only, under the server lock and before jobs/capture: reclaim writes interrupted before publication. */
  async removeOrphanAudioFiles() {
    const data = await realpath(this.directory), root = join(data, 'audio');
    if (!(await lstat(root).catch(() => null))?.isDirectory() || await realpath(root) !== root) return;
    const referenced = new Set((this.db.prepare("SELECT path FROM frames WHERE path<>'' UNION SELECT path FROM chunks WHERE path<>'' UNION SELECT path FROM chunk_originals WHERE path<>''").all() as { path: string }[])
      .map(row => { const path = resolve(this.resolvePath(row.path)), relative = this.relativePath(path); return relative === null ? path : join(data, relative); }));
    for (const meeting of await readdir(root)) {
      if (!/^[a-f0-9-]{36}$/.test(meeting)) continue;
      const folder = join(root, meeting);
      if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) continue;
      for (const name of await readdir(folder)) {
        if (!/^(?:g[1-9]\d*-)?[a-f0-9-]{36}(?:\.frame|\.raw)?\.f32$/.test(name)) continue;
        const path = join(folder, name);
        if (!referenced.has(path) && (await lstat(path)).isFile()) await rm(path, { force: true });
      }
    }
  }
  /** Removes frame files whose audio is already in a window (a crash between the seal and the cleanup). */
  async removeSealedFrameFiles() {
    // Only when the window's own file exists: otherwise the frame files are the only copy of that audio.
    const sealed = this.db.prepare(`SELECT f.path AS path, c.path AS windowPath, o.path AS originalPath, o.hash AS originalHash
      FROM frames f JOIN chunks c ON c.id = f.windowChunkId LEFT JOIN chunk_originals o ON o.id=c.id`).all() as { path: string; windowPath: string; originalPath: string | null; originalHash: string | null }[];
    const originals = new Map<string, Promise<boolean>>(); // Check each window once, not once per frame.
    await Promise.allSettled(sealed.map(async f => {
      if (!f.path || !f.windowPath) return;
      // Sealed frame rows survive cleanup for admission dedup. Do not hash years of retained
      // originals on every start when their frame files were already reclaimed.
      await access(this.resolvePath(f.path));
      await access(this.resolvePath(f.windowPath));
      if (f.originalPath !== null) {
        if (!f.originalPath) return;
        let intact = originals.get(f.originalPath);
        if (!intact) {
          intact = readFile(this.resolvePath(f.originalPath)).then(pcm => createHash('sha256').update(pcm).digest('hex') === f.originalHash);
          originals.set(f.originalPath, intact);
        }
        if (!await intact) return;
      }
      await rm(this.resolvePath(f.path), { force: true });
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
  /** Non-final chunks split only their own speaker's paragraph in every transcript surface. */
  chunkParagraphBarriers(id: string) {
    const { labelled, roleOf } = this.speakers(id);
    return this.chunks(id).filter(c => c.status !== 'completed').map(c => {
      const role = labelled ? roleOf(c.source, c.startMs, c.startMs + c.seconds * 1000) : null;
      return { startMs: c.startMs, speaker: role ? ROLE_LABEL[role] : null, gap: `[${c.status}: ${c.error ?? 'not transcribed'}]` };
    });
  }
  /** Both exports share entries and paragraph boundaries; only their presentation differs. */
  private transcriptParagraphs(id: string, mode: 'corrected' | 'raw', locale?: string, plain = false) {
    const prefix = (ms: number) => plain ? '' : `[${new Date(ms).toISOString().slice(11, 19)}] `;
    // Exports use the same sentence-aware, per-speaker grouping as both transcript views.
    const { labelled, roleOf } = this.speakers(id);
    const segments = this.segments(id);
    if (labelled) segments.sort(compareSegments);
    const entries = [
      ...this.captureGaps(id).map(g => ({ startMs: g.atMs, all: true, gap: plain ? `[${captureGapText(g, locale, false)}]` : `*${captureGapText(g, locale)}*` })),
      ...this.chunkParagraphBarriers(id),
    ];
    const grouped = paragraphsOf(segments.map(s => {
      const role = labelled ? roleOf(s.source, s.startMs, s.endMs) : null;
      return { ...s, text: mode === 'raw' ? s.originalText : s.text, speaker: role ? ROLE_LABEL[role] : null };
    }), entries);
    const paragraphs = [...grouped.map(p => ({ startMs: p.startMs, all: false,
      text: `${prefix(p.startMs)}${p.speaker ? `${p.speaker}: ` : ''}${p.segments.map(s => s.text).join(' ')}` })),
    ...entries.map(e => ({ startMs: e.startMs, all: 'all' in e && e.all, text: `${prefix(e.startMs)}${e.gap}` }))]
      .sort((a, b) => a.startMs - b.startMs || Number(b.all) - Number(a.all)).map(e => e.text);
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
    const sources = this.db.prepare('SELECT source FROM chunks WHERE meetingId=? UNION SELECT source FROM frames WHERE meetingId=?').all(id, id) as { source: string }[];
    const app = sources.some(s => s.source.startsWith('app:')), tab = sources.some(s => s.source.startsWith('tab:'));
    const call = app ? (tab ? 'meeting tab or app' : 'meeting app') : 'meeting tab';
    const who = labelled ? `Speaker labels are capture channels: "Them" is the ${call} (everyone on the call), "Me" is this microphone during the call.` : 'No speaker labels;';
    return `# ${meeting.title.replace(/[\r\n]/g, ' ')}\n\nTranscript — ${note} ${who}${labelled ? ' Not' : ' not'} verified meeting decisions.\n\n${paragraphs.join('\n\n')}\n`;
  }
  close() { this.transcripts.clear(); this.db.close(); }
}
