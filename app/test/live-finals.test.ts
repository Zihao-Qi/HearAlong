import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-live-finals-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional lantern call');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const add = (id: string, source: string, startMs: number, seconds: number, text: string, status = 'completed') => {
    store.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,text,hash,completedAt)
      VALUES (?,?,?,?, 'fictional',0,?,?,16000,?,?,'fixture',?)`).run(id, meeting.id, source, startMs, startMs, seconds, status, text, status === 'completed' ? 10000 : null);
    if (text) store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
      VALUES (?,?,?,?,0,?,?,?,?, 'chunk')`).run(`${id}:0`, meeting.id, id, source, startMs, startMs + seconds * 1000, text, text);
  };
  const micText = 'The paper lantern is ready';
  add('mic', 'mic:room', 0, 3, micText);
  add('call', 'app:call', 0, 6, '', 'running');
  const display = (now = 10000, sources = ['app:call']) => store.displaySegments(meeting.id, sources, now);
  return { store, meeting, add, display, micText };
}

for (const echo of [false, true]) test(`live mic final is held then ${echo ? 'never shown for echo' : 'shown for genuine/headphones speech'} when call catches up`, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.display().segments, []);
  assert.deepEqual([...f.display().heldChunks], ['mic']);
  assert.equal(f.store.segments(f.meeting.id).length, 1, 'settled readers and exports have no hold');
  assert.match(f.store.plainText(f.meeting.id), /The paper lantern is ready/);
  f.store.db.exec("DELETE FROM chunks WHERE id='call'");
  f.add('call', 'app:call', 0, 6, echo ? f.micText : 'Copper ribbons need glue tomorrow');
  assert.deepEqual([...f.display(11000).heldChunks], []);
  assert.deepEqual(f.display(11000).segments.map(s => s.id), echo ? ['call:0'] : ['mic:0', 'call:0']);
});

test('a short Me line waits for its held neighbour, so no published Me line disappears later', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-live-short-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional lantern call');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const sentence = 'the paper lantern is ready for the garden party under copper trees'.split(' ');
  // Meeting times: one word every 400 ms from `at`, each lasting 300 ms.
  const said = (at: number, list: string[]) => list.map((text, i) => ({ text, startMs: at + i * 400, endMs: at + i * 400 + 300 }));
  const complete = (id: string, startMs: number, list: { text: string; startMs: number; endMs: number }[]) => store.completeChunk(id, {
    text: list.map(w => w.text).join(' '), words: list.map(w => ({ text: w.text, t0Ms: w.startMs - startMs, t1Ms: w.endMs - startMs })),
    backend: 'fixture', computeMs: 1, decodeMs: 0, audioSeconds: 6, processRssBytes: 0, timestampKind: 'word' } as never);
  // The call says "Okay." at 1900, then the sentence from 2600; its first block (0–5.4 s) holds only the first seven words.
  const call = [{ text: 'Okay.', startMs: 1900, endMs: 2200 }, ...said(2600, sentence)];
  const callA = await store.addPcm(meeting.id, 'app:call', 0, 0, 16000, Buffer.alloc(4 * 16000 * 5.4));
  const callB = await store.addPcm(meeting.id, 'app:call', 1, 5400, 16000, Buffer.alloc(4 * 16000 * 6));
  complete(callA.id, 0, call.filter(w => w.startMs < 5400));
  // The mic hears it 100 ms later: "Okay." (2000–2300, a line of its own) and the sentence (2700–7400).
  const mic = await store.addPcm(meeting.id, 'mic:room', 0, 0, 16000, Buffer.alloc(4 * 16000 * 12));
  complete(mic.id, 0, call.map(w => ({ ...w, startMs: w.startMs + 100, endMs: w.endMs + 100 })));
  const shown = () => store.displaySegments(meeting.id, ['app:call'], Date.now()).segments.filter(s => s.source === 'mic:room').map(s => s.text);
  assert.deepEqual(store.segments(meeting.id).filter(s => s.source === 'mic:room').map(s => s.text), ['Okay.', sentence.join(' ')],
    'two lines; neither is an echo yet, since the call has said only seven of the twelve words');
  assert.deepEqual(shown(), [], '"Okay." is held with the sentence, although the call has passed its own end plus three seconds');
  complete(callB.id, 5400, call.filter(w => w.startMs >= 5400));
  assert.deepEqual(store.segments(meeting.id).filter(s => s.source === 'mic:room'), [], 'both are echoes once the call catches up');
  assert.deepEqual(shown(), []);
});

test('live hold expires at exactly eight seconds when call recognition stalls', async t => {
  const f = await fixture(t);
  assert.equal(f.display(17999).segments.length, 0);
  assert.deepEqual(f.display(18000).segments.map(s => s.id), ['mic:0']);
  assert.equal(f.display(20000).heldChunks.size, 0);
});

test('no live call or a call ended mid-hold releases immediately, regardless of recognition backlog', async t => {
  const f = await fixture(t);
  assert.equal(f.display().segments.length, 0);
  assert.deepEqual(f.display(10001, []).segments.map(s => s.id), ['mic:0']);
});

test('no call source leaves in-person finals unchanged', async t => {
  const f = await fixture(t);
  f.store.db.exec("DELETE FROM chunks WHERE id='call'");
  assert.deepEqual(f.display(10000, []).segments.map(s => s.id), ['mic:0']);
});

test('a later completed call block cannot skip an unrecognized gap; completed silence does count', async t => {
  const f = await fixture(t);
  f.store.db.exec("UPDATE chunks SET seconds=2 WHERE id='call'");
  f.add('call-later', 'app:call', 2000, 6, 'Copper ribbons need glue tomorrow');
  assert.equal(f.display().segments.some(s => s.id === 'mic:0'), false);
  f.store.db.exec("UPDATE chunks SET status='completed' WHERE id='call'");
  assert.equal(f.display().segments.some(s => s.id === 'mic:0'), true);
});

test('completed call coverage must reach the inclusive segment end plus three seconds', async t => {
  const f = await fixture(t);
  f.store.db.exec("UPDATE chunks SET status='completed', seconds=5.999 WHERE id='call'");
  assert.equal(f.display().heldChunks.size, 1);
  f.store.db.exec("UPDATE chunks SET seconds=6 WHERE id='call'");
  assert.equal(f.display().heldChunks.size, 0);
});

test('replay bypasses the live-final hold', async t => {
  const f = await fixture(t);
  f.store.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify({ sourceId: 'mic:room', startedAt: 0, baseMs: 0, durationMs: 3000, speed: 1 }), f.meeting.id);
  assert.deepEqual(f.display().segments.map(s => s.id), ['mic:0']);
  assert.equal(f.display().heldChunks.size, 0);
});

test('old chunks without publication time are never delayed on reopen', async t => {
  const f = await fixture(t);
  f.store.db.exec("UPDATE chunks SET completedAt=NULL WHERE id='mic'");
  assert.equal(f.display().heldChunks.size, 0);
});
