// Compare microphone takes in one meeting (step 4): how each capture setting did on the same room.
// Usage: node --experimental-strip-types scripts/room-compare.ts <meeting title or id> [dataDir=data]
// Read-only: opens the database without writing and reads the saved window audio.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRecordingPath } from '../src/store.ts';

const [which, dataDir = 'data'] = process.argv.slice(2);
if (!which) throw new Error('Usage: room-compare.ts <meeting title or id> [dataDir]');
const directory = resolve(dataDir);
const db = new DatabaseSync(join(directory, 'meetings.sqlite'), { readOnly: true });
const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? OR title = ? ORDER BY createdAt DESC LIMIT 1').get(which, which) as { id: string; title: string; audioRemovedAt?: number | null } | undefined;
if (!meeting) throw new Error(`No meeting called or with id ${which}.`);
// Older databases (before step 4) have no settings table: those takes simply have no recorded settings.
const hasSettings = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_settings'").get());
const settings = hasSettings ? Object.fromEntries((db.prepare('SELECT source, settings FROM source_settings WHERE meetingId=?').all(meeting.id) as { source: string; settings: string }[]).map(r => [r.source, JSON.parse(r.settings)])) : {};
const sources = (db.prepare("SELECT DISTINCT source FROM chunks WHERE meetingId=? AND source LIKE 'mic:%'").all(meeting.id) as { source: string }[]).map(r => r.source);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const dbfs = (pcm: Float32Array) => 20 * Math.log10(Math.sqrt(pcm.reduce((n, x) => n + x * x, 0) / Math.max(1, pcm.length)) + 1e-9);

const takes = sources.map(source => {
  const chunks = db.prepare('SELECT path, startMs, seconds, status, text, metrics FROM chunks WHERE meetingId=? AND source=? ORDER BY startMs').all(meeting.id, source) as { path: string; startMs: number; seconds: number; status: string; text: string; metrics: string | null }[];
  const seconds = chunks.reduce((n, c) => n + c.seconds, 0);
  const words = chunks.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
  const metrics = chunks.map(c => (c.metrics ? JSON.parse(c.metrics) : {}) as { retries?: number; recoveredBy?: string | null });
  // Per second of audio: the loudness spread (speech vs. silence), from the saved windows.
  const perSecond: number[] = [];
  const unavailableAudio: number[] = [];
  for (const c of chunks) {
    const path = resolveRecordingPath(directory, c.path);
    if (!path || !existsSync(path)) { unavailableAudio.push(c.startMs); continue; }
    let b: Buffer;
    try { b = readFileSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      unavailableAudio.push(c.startMs); continue;
    }
    const pcm = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    for (let i = 0; i + 16000 <= pcm.length; i += 16000) perSecond.push(dbfs(pcm.subarray(i, i + 16000)));
  }
  return {
    source: source.slice(0, 12), settings: settings[source] ?? '(not recorded: before step 4)',
    minutes: +(seconds / 60).toFixed(1), words, wordsPerMinute: seconds ? Math.round(words / (seconds / 60)) : 0,
    windows: chunks.length,
    emptyWindows: chunks.filter(c => c.status === 'completed' && !c.text.trim()).length,
    emptyButLoud: metrics.filter((m, i) => m.retries && !chunks[i].text.trim()).length,
    recovered: metrics.filter(m => m.recoveredBy).length,
    failed: chunks.filter(c => c.status === 'failed').length,
    unavailableAudio, // window start times: levels unavailable for these parts, transcript metrics above remain valid
    levelDbfs: { quiet10: pct(perSecond, 0.1), median: pct(perSecond, 0.5), loud90: pct(perSecond, 0.9) },
    sample: chunks.map(c => c.text).join(' ').slice(0, 240),
  };
});
db.close();
console.log(JSON.stringify({ meeting: meeting.title, takes, audio: meeting.audioRemovedAt != null ? 'Audio removed; levels are unavailable.' : takes.some(t => t.unavailableAudio.length) ? 'Audio levels unavailable for some windows.' : 'Available', note: 'Compare takes of the same room and talk. Words per minute and empty windows are completeness signals, not accuracy; read the samples too.' }, null, 2));
