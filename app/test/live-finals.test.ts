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
