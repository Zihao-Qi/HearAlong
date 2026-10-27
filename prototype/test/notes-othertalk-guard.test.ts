import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesFile, NotesJobs, validateNotes, type NotesRecord, type NotesRunner, type Snapshot } from '../src/notes.ts';
import { MeetingStore } from '../src/store.ts';

const line = 'Keep the painted lanterns on the upper shelf.';
const snapshot: Snapshot = {
  meetingId: 'lantern-workshop', title: 'Lantern storage', takenAt: 1, glossaryVersion: null, terms: [], inputHash: 'fictional',
  coverage: { untilMs: 8000, chunks: 8, pendingChunks: 0, gaps: [], uncorrected: 0 },
  segments: Array.from({ length: 8 }, (_, i) => ({ ref: `S${i + 1}`, id: `line-${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000,
    revision: 1, text: line, originalText: line })),
};
const item = { text: 'Keep the lanterns on the upper shelf.', cites: ['S1'], quote: line };
const range = (from: number, to: number) => ({ from: `S${from}`, to: `S${to}`, label: 'Workshop chat' });
const reason = 'marked more than half the meeting as non-project talk; ignored';
const check = (otherTalk: unknown[]) => validateNotes({ summary: [item], otherTalk }, snapshot);

test('a whole-meeting range is ignored without flagging project items', () => {
  const { notes, dropped } = check([range(1, 8)]);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 1);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped, [{ section: 'otherTalk', text: 'S1–S8', reason }]);
});

test('overlapping ranges whose distinct union exceeds half are all ignored', () => {
  const { notes, dropped } = check([range(1, 3), range(3, 5)]);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 1);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped, [{ section: 'otherTalk', text: 'S1–S3, S3–S5', reason }]);
});

test('disjoint ranges covering exactly half are kept', () => {
  const { notes, dropped } = check([range(1, 2), range(7, 8)]);
  assert.equal(notes.otherTalk.length, 2);
  assert.equal(notes.summary.length, 0);
  assert.match(notes.needsReview[0].reviewReason!, /cites non-project talk/);
  assert.deepEqual(dropped, []);
});

test('overlaps count only once even when their summed lengths exceed half', () => {
  const { notes, dropped } = check([range(1, 3), range(2, 4), range(1, 3)]);
  assert.equal(notes.otherTalk.length, 3);
  assert.match(notes.needsReview[0].reviewReason!, /cites non-project talk/);
  assert.deepEqual(dropped, []);
});

test('a genuine small range still flags a citing project item', () => {
  const { notes, dropped } = check([range(1, 1)]);
  assert.equal(notes.otherTalk.length, 1);
  assert.equal(notes.summary.length, 0);
  assert.match(notes.needsReview[0].reviewReason!, /cites non-project talk/);
  assert.deepEqual(dropped, []);
});

test('invalid ranges do not count towards coverage', () => {
  const { notes, dropped } = check([range(1, 1), range(2, 99), range(8, 2)]);
  assert.equal(notes.otherTalk.length, 1);
  assert.match(notes.needsReview[0].reviewReason!, /cites non-project talk/);
  assert.deepEqual(dropped.map(d => d.reason), ['invalid range', 'invalid range']);
});

test('ignored-range diagnostics contain only valid ranges and are capped at 200 characters', () => {
  const ranges = Array.from({ length: 40 }, () => range(1, 8));
  const { notes, dropped } = check([range(9, 99), ...ranges]);
  assert.deepEqual(notes.otherTalk, []);
  assert.deepEqual(dropped.map(d => d.reason), ['invalid range', reason]);
  assert.equal(dropped[1].text, ranges.map(() => 'S1–S8').join(', ').slice(0, 200));
});

test('legacy offTopic output uses the same guard', () => {
  const { notes, dropped } = validateNotes({ summary: [item], offTopic: [range(1, 8)] }, snapshot);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 1);
  assert.deepEqual(dropped, [{ section: 'otherTalk', text: 'S1–S8', reason }]);
});

test('three-part jobs wait for otherTalk and validate its whole-meeting union after merging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-othertalk-guard-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Fictional lantern workshop');
  let release!: () => void, otherStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { otherStarted = resolve; });
  const runner: NotesRunner = async input => {
    if (input.instructions.includes('notes: otherMatters,')) {
      otherStarted(); await gate;
      return { text: JSON.stringify({ otherTalk: [range(1, 3), range(3, 5)] }), model: 'scripted' };
    }
    return { text: JSON.stringify({ summary: [item], decisions: [{ ...item, text: 'Use the upper shelf.' }] }), model: 'scripted' };
  };
  let published!: () => void;
  const saved = new Promise<void>(resolve => { published = resolve; });
  const jobs = new NotesJobs({ store, directory, runner, clock: Date.now, glossaryFor: async () => null, onSaved: published });
  try {
    for (let i = 0; i < 8; i++) {
      const chunk = await store.addPcm(meeting.id, 'mic:fixture', i, i * 1000, 16000, Buffer.alloc(16000 * 4));
      store.completeChunk(chunk.id, { text: line, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    await jobs.start(meeting.id); await started;
    const partial = await jobs.status(meeting.id);
    assert.equal(partial.notes, null);
    assert.equal(partial.job?.progress?.parts.project.done, true);
    assert.equal(partial.job?.progress?.parts.tasks.done, true);
    assert.equal(partial.job?.progress?.parts.other.done, false);
    release(); await saved; await jobs.close();
    const record = (await jobs.status(meeting.id)).notes!;
    assert.equal(record.notes.summary.length, 1);
    assert.equal(record.notes.decisions.length, 1);
    assert.deepEqual(record.notes.otherTalk, []);
    assert.deepEqual(record.notes.needsReview, []);
    assert.deepEqual(record.dropped, [{ section: 'otherTalk', text: 'S1–S3, S3–S5', reason }]);
  } finally { release(); await jobs.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('loading stored records preserves ranges, including legacy upgrade()', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-othertalk-stored-'));
  const file = new NotesFile(join(directory, 'notes.json'));
  const otherTalk = [{ fromId: 'line-1', toId: 'line-8', startMs: 0, endMs: 8000, label: 'Workshop chat', smallTalk: false }];
  const record: NotesRecord = { version: 1, createdAt: 1, model: 'scripted', meetingId: snapshot.meetingId, title: snapshot.title,
    input: { inputHash: snapshot.inputHash, coverage: snapshot.coverage, glossaryVersion: null, segments: 8, takenAt: 1 },
    notes: { ...validateNotes({}, snapshot).notes, otherTalk }, sources: {}, dropped: [] };
  try {
    await writeFile(file.path, JSON.stringify(record));
    assert.deepEqual(await file.load(), record);
    const { otherTalk: _ranges, otherMatters: _items, ...old } = record.notes;
    const { smallTalk: _small, ...legacyRange } = otherTalk[0];
    await writeFile(file.path, JSON.stringify({ ...record, notes: { ...old, offTopic: [legacyRange] } }));
    assert.deepEqual(await file.load(), record);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
