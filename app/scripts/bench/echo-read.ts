// Fictional two-hour call; no model, audio, user data or network. Times MeetingStore.segments() after each new live frame.
// node --experimental-strip-types scripts/bench/echo-read.ts [result.json]
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { MeetingStore } from '../../src/store.ts';
import { buildSegments } from '../../src/segments.ts';
import { echoesFor } from '../../src/speakers.ts';

const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-read-'));
const store = new MeetingStore(directory);
try {
  const meeting = store.createMeeting('Fictional lantern and reef call');
  const chunk = store.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
    VALUES (?,?,?,?,'',0,?,20,16000,'completed','fictional')`);
  const segment = store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
    VALUES (?,?,?,?,?,?,?,?,?,'word')`);
  const remote = 'paper lantern cedar frame copper ribbon folded shade glue spool amber workshop'.split(' ');
  const different = 'cobalt ocean harbor reef shell kelp pebble tide coral sand drift current'.split(' ');
  let rawCount = 0;
  store.db.exec('BEGIN');
  try {
    for (let block = 0; block < 360; block++) for (const source of ['app:call', 'mic:room']) {
      const id = `${source}-${block}`, offset = block * 20000 + (source === 'mic:room' ? 500 : 0);
      chunk.run(id, meeting.id, source, block, offset);
      const count = 1 + block % 5, slot = 20000 / count;
      const vocabulary = source === 'mic:room' && block % 3 !== 0 ? different : remote;
      const words = Array.from({ length: count }, (_, ord) => {
        const length = 8 + (block + ord) % 7, step = (slot - 800) / length;
        return Array.from({ length }, (_, w) => ({ text: `${vocabulary[(block + ord + w) % vocabulary.length]}${w === length - 1 ? '.' : ''}`,
          t0Ms: ord * slot + w * step, t1Ms: ord * slot + (w + 0.9) * step }));
      }).flat();
      const parts = buildSegments(20000, { text: words.map(w => w.text).join(' '), words });
      for (const [ord, s] of parts.entries()) {
        segment.run(`${id}:${ord}`, meeting.id, id, source, ord, offset + s.startMs, offset + s.endMs, s.text, s.text);
        rawCount++;
      }
    }
    // Live capture keeps its sealed frame metadata: two sources × 7,200 one-second frames.
    const historic = store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash,windowChunkId)
      VALUES (?,?,?,?,'',?,16000,'fictional',?)`);
    for (const source of ['app:call', 'mic:room']) for (let second = 0; second < 7200; second++) {
      historic.run(`${source}-frame-${second}`, meeting.id, source, second, second * 1000 + (source === 'mic:room' ? 500 : 0), `${source}-${Math.floor(second / 20)}`);
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  const frame = store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash)
    VALUES (?,?,'mic:room',? + 7200,'',?,16000,'fictional')`);
  let sequence = 0, visibleCount = 0;
  const read = () => {
    // Saving a frame is outside the timed read, but must not make role/echo caching stale.
    frame.run(`frame-${sequence}`, meeting.id, sequence, 7200500 + sequence * 1000); sequence++;
    const start = performance.now();
    const lines = store.segments(meeting.id);
    const ms = performance.now() - start;
    if (visibleCount) assert.equal(lines.length, visibleCount);
    visibleCount = lines.length;
    return ms;
  };
  const firstReadMs = read();
  for (let i = 0; i < 3; i++) { await yieldTurn(); read(); }
  const samplesMs: number[] = [];
  for (let i = 0; i < 15; i++) { await yieldTurn(); samplesMs.push(read()); }
  assert.equal(rawCount, 2160);
  assert.ok(visibleCount < rawCount && visibleCount > rawCount / 2);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  store.db.prepare("UPDATE segments SET text=text WHERE id='mic:room-0:0'").run();
  const afterSegmentWriteMs = read();
  const queryStart = performance.now();
  const raw = store.db.prepare('SELECT * FROM segments WHERE meetingId=? ORDER BY startMs, ord').all(meeting.id) as import('../../src/store.ts').Segment[];
  const queryMs = performance.now() - queryStart;
  const rolesStart = performance.now(), roles = store.speakers(meeting.id), rolesMs = performance.now() - rolesStart;
  const echoStart = performance.now(); echoesFor(raw, roles); const echoMs = performance.now() - echoStart;
  const result = { historicFrames: 14400, diagnostic: { queryMs, rolesMs, echoMs }, blocksPerSource: 360, segmentsPerBlock: '1–5 (mean 3), through buildSegments with word timings', rawCount, visibleCount,
    firstReadMs, afterSegmentWriteMs, medianReadMs: sorted[7], minReadMs: sorted[0], maxReadMs: sorted.at(-1), samplesMs };
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); await rm(directory, { recursive: true, force: true }); }
