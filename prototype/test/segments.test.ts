import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSegments } from '../src/segments.ts';
import { MeetingStore } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';

const words = (...items: [string, number, number][]) => items.map(([text, t0Ms, t1Ms]) => ({ text, t0Ms, t1Ms }));
const recognition = (text: string, w: Recognition['words'] = []): Recognition =>
  ({ text, words: w, backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 20, processRssBytes: 0, timestampKind: 'word' });

test('sentences end at punctuation or pauses; short utterances and the tail are kept', () => {
  const out = buildSegments(20_000, { text: 'x', words: words(
    ['We', 0, 100], ['rinse', 150, 300], ['gravel.', 350, 900],
    ['Wait.', 1500, 1800],
    ['Next', 2000, 2100], ['the', 2150, 2200], ['bucket', 2250, 2500],
    ['drains', 3600, 3900], // 1.1 s pause before this word
  ) });
  assert.deepEqual(out.map(s => s.text), ['We rinse gravel.', 'Wait.', 'Next the bucket', 'drains']);
  assert.deepEqual([out[0].startMs, out[0].endMs, out[0].timing], [0, 900, 'word']);
});

test('without usable word timings, fall back to native segments, then to one coarse segment', () => {
  assert.deepEqual(buildSegments(20_000, { text: 'hello there', words: [] }), [{ startMs: 0, endMs: 20_000, text: 'hello there', timing: 'chunk' }]);
  assert.equal(buildSegments(20_000, { text: 'a b', words: words(['a', NaN, 1], ['b', 2, 3]) })[0].timing, 'chunk');
  const legacy = buildSegments(20_000, { text: 'legacy', segments: [{ text: 'legacy', t0Ms: 500, t1Ms: 20_100 }] });
  assert.deepEqual(legacy, [{ startMs: 500, endMs: 20_000, text: 'legacy', timing: 'segment' }]);
  assert.deepEqual(buildSegments(20_000, { text: '   ', words: [] }), []);
  const badWords = buildSegments(20_000, { text: 'a b', words: words(['a', -5000, -4000], ['b', -3000, -2000]), segments: [{ text: 'a b', t0Ms: 5000, t1Ms: 10_000 }] });
  assert.deepEqual(badWords, [{ startMs: 5000, endMs: 10_000, text: 'a b', timing: 'segment' }], 'wholly invalid word times fall back to native segments');
  assert.equal(buildSegments(20_000, { text: 'x y', words: words(['x', 5000, 6000], ['y', 1000, 2000]) })[0].timing, 'chunk', 'times running backwards are not trusted');
  assert.equal(buildSegments(20_000, { text: 'x y', words: words(['x', 0, 6000], ['y', 1000, 2000]) })[0].timing, 'chunk', 'ends running backwards are not trusted');
});

test('segments publish with their chunk, stay frozen, backfill once, and support CAS edits and both exports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-segments-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Seg test');
    const chunk = await store.addPcm(meeting.id, 'mic:test', 0, 1000, 16000, Buffer.alloc(16000 * 4));
    store.completeChunk(chunk.id, recognition('Clean pro teen skimmer.', words(['Clean', 0, 100], ['pro', 150, 300], ['teen', 350, 500], ['skimmer.', 550, 900])));
    store.completeChunk(chunk.id, recognition('Different text entirely.'));
    const [segment] = store.segments(meeting.id);
    assert.equal(store.segments(meeting.id).length, 1, 'a second completion does not re-split published segments');
    assert.deepEqual([segment.id, segment.startMs, segment.endMs], [`${chunk.id}:0`, 1000, 1900]);

    assert.equal(store.applyEdits(segment.id, 0, 'Clean protein skimmer.', [{ start: 6, end: 21, from: 'pro teen skimmer', to: 'protein skimmer' }]), true);
    assert.equal(store.applyEdits(segment.id, 0, 'stale edit', []), false, 'stale revision refused');
    assert.equal(store.segment(segment.id)!.text.slice(6, 21), 'protein skimmer', 'edit offsets cover the replacement');
    assert.match(store.markdown(meeting.id), /Clean protein skimmer\./);
    assert.match(store.markdown(meeting.id, 'raw'), /Clean pro teen skimmer\./);

    // A legacy chunk (completed before segments existed) is backfilled exactly once on reopen.
    const legacy = await store.addPcm(meeting.id, 'mic:test', 1, 30_000, 16000, Buffer.alloc(16000 * 4));
    store.setStatus(legacy.id, 'completed', 'Old text.', null, { segments: [{ text: 'Old text.', t0Ms: 100, t1Ms: 800 }] });
    store.close();
    store = new MeetingStore(directory);
    store.close();
    store = new MeetingStore(directory);
    const old = store.segments(meeting.id).filter(s => s.chunkId === legacy.id);
    assert.deepEqual(old.map(s => [s.text, s.timing, s.startMs]), [['Old text.', 'segment', 30_100]]);
    assert.equal(store.segment(segment.id)?.text, 'Clean protein skimmer.', 'corrections survive reopen');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('replay reveals one source from its own start as the clock advances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-replay-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Replay');
    const source = store.addMedia(meeting.id, '/test/file.m4a', 60);
    const chunks = store.chunks(meeting.id);
    // Complete the second window before the first: late STT must still surface in time order.
    store.completeChunk(chunks[1].id, recognition('Second window.', words(['Second', 0, 500], ['window.', 600, 1000])));
    store.completeChunk(chunks[0].id, recognition('First window.', words(['First', 0, 500], ['window.', 600, 1000])));
    const replay = store.startReplay(meeting.id, source, 4, 0);
    assert.equal(replay.durationMs, 60_000);
    assert.deepEqual(store.visibleSegments(meeting.id, 0).map(s => s.text), []);
    assert.deepEqual(store.visibleSegments(meeting.id, 250).map(s => s.text), ['First window.'], '1 s of audio at 4x after 250 ms');
    assert.deepEqual(store.visibleSegments(meeting.id, 5_250).map(s => s.text), ['First window.', 'Second window.']);
    assert.equal(store.replayPositionMs(replay, 10 ** 9), 60_000, 'clamped to the source duration');
    assert.throws(() => store.startReplay(meeting.id, source, 1), /already been replayed/);
    await assert.rejects(store.addPcm(meeting.id, 'mic:x', 0, 0, 16000, Buffer.alloc(64)), /is a replay/);
    assert.throws(() => store.addMedia(meeting.id, '/test/other.m4a', 10), /is a replay/);
    // A microphone chunk whose disk write is in flight when the replay starts is refused at insert time.
    const racing = store.createMeeting('Race');
    const file = store.addMedia(racing.id, '/test/race.m4a', 20);
    const pending = store.addPcm(racing.id, 'mic:race', 0, 0, 16000, Buffer.alloc(64));
    store.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify({ sourceId: file, startedAt: 0, speed: 1, baseMs: 0, durationMs: 20_000 }), racing.id);
    await assert.rejects(pending, /is a replay/);
    assert.equal(store.chunks(racing.id).filter(c => c.source === 'mic:race').length, 0);
    const mixed = store.createMeeting('Mixed');
    store.addMedia(mixed.id, '/test/a.m4a', 20);
    const second = store.addMedia(mixed.id, '/test/b.m4a', 20);
    assert.throws(() => store.startReplay(mixed.id, second, 1), /only that source/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('upgrading a database keeps already corrected segments checked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-upgrade-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    for (let i = 0; i < 3; i++) {
      const chunk = await store.addPcm(meeting.id, 'mic:u', i, i * 10_000, 16000, Buffer.alloc(64, i + 1));
      store.completeChunk(chunk.id, recognition(`Segment ${i}.`));
    }
    const [a, b, c] = store.segments(meeting.id);
    store.applyEdits(c.id, 0, 'Segment two.', []);
    // Simulate the pre-upgrade schema: no column, an old time cursor at the second segment.
    store.db.exec('ALTER TABLE segments DROP COLUMN correctionChecked');
    store.db.exec('PRAGMA user_version = 0');
    store.setCorrectionState(meeting.id, { cursorMs: b.startMs, cursorId: b.id, glossaryVersion: 2, lastCallAt: 0, stats: {} });
    store.close();
    store = new MeetingStore(directory);
    const checked = Object.fromEntries(store.segments(meeting.id).map(s => [s.id, s.correctionChecked]));
    assert.deepEqual([checked[a.id], checked[b.id], checked[c.id]], [2, 2, 1]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a database that gained the column before the repair existed is repaired once on the next open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-upgrade2-'));
  let store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting();
    const chunk = await store.addPcm(meeting.id, 'mic:u', 0, 0, 16000, Buffer.alloc(64, 1));
    store.completeChunk(chunk.id, recognition('Corrected earlier.'));
    const [segment] = store.segments(meeting.id);
    store.applyEdits(segment.id, 0, 'Corrected earlier.', []);
    // Intermediate state: column present, all zeros, repair never run.
    store.db.exec('UPDATE segments SET correctionChecked=0');
    store.db.exec('PRAGMA user_version = 0');
    store.close();
    store = new MeetingStore(directory);
    assert.equal(store.segment(segment.id)?.correctionChecked, 1);
    store.db.exec('UPDATE segments SET correctionChecked=0'); // after the repair, opening again changes nothing
    store.close();
    store = new MeetingStore(directory);
    assert.equal(store.segment(segment.id)?.correctionChecked, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
