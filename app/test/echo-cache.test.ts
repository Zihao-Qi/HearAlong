import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MeetingStore } from '../src/store.ts';

async function fixture(t: TestContext, callStart = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-cache-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional lantern review');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const insert = store.db.prepare(`INSERT INTO chunks (id,meetingId,source,sequence,path,decodeStart,startMs,seconds,sampleRate,status,hash)
    VALUES (?,?,?,0,'',0,?,20,16000,'completed','fictional')`);
  insert.run('mic', meeting.id, 'mic:room', 0); insert.run('call', meeting.id, 'app:call', callStart);
  const segment = store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
    VALUES (?,?,?,?,0,?,?,'The paper lantern is ready','The paper lantern is ready','word')`);
  segment.run('mic:0', meeting.id, 'mic', 'mic:room', 10000, 11000);
  segment.run('call:0', meeting.id, 'call', 'app:call', Math.max(10000, callStart), Math.max(11000, callStart + 1000));
  const ids = () => store.segments(meeting.id).map(s => s.id);
  const cache = () => (store as unknown as { transcripts: Map<string, unknown> }).transcripts.get(meeting.id);
  return { store, meeting, directory, ids, cache };
}

test('repeated readers reuse one echo snapshot; caller mutations and new ordinary live frames cannot corrupt it', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.ids(), ['call:0']); const first = f.cache();
  const changed = f.store.segments(f.meeting.id); changed[0].text = 'Not stored'; changed.length = 0;
  assert.equal(f.store.visibleSegments(f.meeting.id)[0].text, 'The paper lantern is ready');
  assert.deepEqual(f.store.withoutEchoes(f.meeting.id, { 'mic:0': 'hidden', 'call:0': 'shown' }), { 'call:0': 'shown' });
  f.store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash)
    VALUES ('later',?,'mic:room',0,'',20000,16000,'fictional')`).run(f.meeting.id);
  assert.deepEqual(f.ids(), ['call:0']); assert.equal(f.cache(), first, 'no repeated echo evaluation for unchanged roles/segments');
});

test('every local segment INSERT/UPDATE/DELETE invalidates, including direct SQL and metadata-only updates', async t => {
  const f = await fixture(t); f.ids(); let old = f.cache();
  const check = () => { f.ids(); assert.notEqual(f.cache(), old); old = f.cache(); };
  f.store.db.prepare("UPDATE segments SET text=text WHERE id='call:0'").run(); check();
  f.store.markCorrectionChecked(['call:0'], 9); check();
  assert.equal(f.store.segments(f.meeting.id)[0].correctionChecked, 9);
  f.store.applyEdits('mic:0', 0, 'Cobalt ocean harbor reef shell', []); check();
  assert.deepEqual(f.ids(), ['mic:0', 'call:0']);
  f.store.db.prepare("DELETE FROM segments WHERE id='mic:0'").run(); check();
  f.store.db.prepare(`INSERT INTO segments (id,meetingId,chunkId,source,ord,startMs,endMs,text,originalText,timing)
    VALUES ('mic:1',?,'mic','mic:room',1,10000,11000,'The paper lantern is ready','The paper lantern is ready','word')`).run(f.meeting.id);
  check(); assert.deepEqual(f.ids(), ['call:0']);
});

test('rolled-back snapshots are never cached, and epochs do not roll back with SQLite', async t => {
  const f = await fixture(t); assert.deepEqual(f.ids(), ['call:0']); const old = f.cache();
  f.store.db.exec('BEGIN');
  try {
    f.store.db.prepare("UPDATE segments SET text='Cobalt ocean harbor reef shell' WHERE id='mic:0'").run();
    assert.deepEqual(f.ids(), ['mic:0', 'call:0']); assert.equal(f.cache(), old);
  } finally { f.store.db.exec('ROLLBACK'); }
  assert.deepEqual(f.ids(), ['call:0']); assert.notEqual(f.cache(), old);
  f.store.db.prepare("UPDATE segments SET text='Cobalt ocean harbor reef shell' WHERE id='mic:0'").run();
  assert.deepEqual(f.ids(), ['mic:0', 'call:0'], 'no ABA reuse of the rolled-back version');
});

test('external SQLite commits invalidate cached transcript data', async t => {
  const f = await fixture(t); assert.deepEqual(f.ids(), ['call:0']);
  const other = new DatabaseSync(join(f.directory, 'meetings.sqlite'));
  try { other.prepare("UPDATE segments SET text='Cobalt ocean harbor reef shell' WHERE id='mic:0'").run(); }
  finally { other.close(); }
  assert.deepEqual(f.ids(), ['mic:0', 'call:0']);
});

test('late call frames change speaker boundaries even with no segment write; removing them restores the old view', async t => {
  const f = await fixture(t, 12000);
  assert.deepEqual(f.ids(), ['mic:0', 'call:0'], 'room speech before the first share is not Me');
  f.store.db.prepare(`INSERT INTO frames (id,meetingId,source,sequence,path,startMs,samples,hash)
    VALUES ('earlier-call',?,'app:call',0,'',8000,16000,'fictional')`).run(f.meeting.id);
  assert.deepEqual(f.ids(), ['call:0']);
  f.store.db.exec("DELETE FROM frames WHERE id='earlier-call'");
  assert.deepEqual(f.ids(), ['mic:0', 'call:0']);
});

test('transcript snapshots retain at most four meetings', async t => {
  const f = await fixture(t); f.ids();
  for (let i = 0; i < 5; i++) f.store.segments(f.store.createMeeting(`Fictional room ${i}`).id);
  assert.equal((f.store as unknown as { transcripts: Map<string, unknown> }).transcripts.size, 4);
  assert.equal(f.cache(), undefined);
});
