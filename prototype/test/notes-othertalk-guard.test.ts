import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesFile, NotesJobs, validateNotes, type NotesRecord, type NotesRunner, type Snapshot } from '../src/notes.ts';
import { notesDiagnosticsRows } from '../src/notes-diagnostics.ts';
import { DurationHistory } from '../src/progress.ts';
import { MeetingStore } from '../src/store.ts';

const line = (n: number) => `Keep the painted lanterns on workshop shelf number ${n}.`;
const snapshot: Snapshot = {
  meetingId: 'lantern-workshop', title: 'Lantern storage', takenAt: 1, glossaryVersion: null, terms: [], inputHash: 'fictional',
  coverage: { untilMs: 24000, chunks: 24, pendingChunks: 0, gaps: [], uncorrected: 0 },
  segments: Array.from({ length: 24 }, (_, i) => ({ ref: `S${i + 1}`, id: `line-${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000,
    revision: 1, text: line(i + 1), originalText: line(i + 1) })),
};
const item = (n: number) => ({ text: `Keep the lanterns on shelf ${n}.`, cites: [`S${n}`], quote: line(n) });
const range = (from: number, to: number) => ({ from: `S${from}`, to: `S${to}`, label: 'Workshop chat' });
const ignored = (from: number, to: number, count: number) => ({ section: 'otherTalk', text: `S${from}–S${to}`, reason: `contradicted by ${count} verified project items; ignored` });
const nonProject = 'cites non-project talk; it may belong in Other matters';
const project = (count: number) => {
  const items = Array.from({ length: count }, (_, i) => item(i + 1));
  return { summary: items.slice(0, 3), decisions: items.slice(3, 6), actions: items.slice(6, 8), openQuestions: items.slice(8) };
};
const check = (count: number, otherTalk = [range(1, count)]) => validateNotes({ ...project(count), otherTalk }, snapshot);

test('a wrong range over ten verified project items is ignored even below half the meeting', () => {
  const { notes, dropped, otherTalkIgnored } = check(10);
  assert.deepEqual(notes.otherTalk, []);
  assert.deepEqual([notes.summary.length, notes.decisions.length, notes.actions.length, notes.openQuestions.length], [3, 3, 2, 2]);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped, [ignored(1, 10, 10)]);
  assert.equal(otherTalkIgnored, 1);
});

test('a whole-meeting range with at least three verified items is ignored by evidence', () => {
  const { notes, dropped, otherTalkIgnored } = check(3, [range(1, 24)]);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 3);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped, [ignored(1, 24, 3)]);
  assert.equal(otherTalkIgnored, 1);
});

test('a correct range with one stray project item is kept and flags that item', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [item(1), item(2), item(22)], otherTalk: [range(22, 24)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.deepEqual(notes.summary.map(i => i.text), [item(1).text, item(2).text]);
  assert.equal(notes.needsReview.length, 1);
  assert.equal(notes.needsReview[0].text, item(22).text);
  assert.equal(notes.needsReview[0].reviewReason, nonProject);
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('exactly three distinct verified items across project sections ignore a range', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [item(1)], decisions: [item(2)], openQuestions: [item(3)], otherTalk: [range(1, 3)] }, snapshot);
  assert.deepEqual(notes.otherTalk, []);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual([notes.summary.length, notes.decisions.length, notes.openQuestions.length], [1, 1, 1]);
  assert.deepEqual(dropped, [ignored(1, 3, 3)]);
  assert.equal(otherTalkIgnored, 1);
});

test('two verified items keep even a whole-meeting range', () => {
  const { notes, dropped, otherTalkIgnored } = check(2, [range(1, 24)]);
  assert.equal(notes.otherTalk.length, 1);
  assert.equal(notes.summary.length, 0);
  assert.deepEqual(notes.needsReview.map(i => i.reviewReason), [nonProject, nonProject]);
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('items with any failed quote do not count, even when another quote passed', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [item(1), item(2),
    { ...item(3), quotes: [line(3), 'The striped crates should stay in the garden.'] },
    { ...item(4), quote: 'The striped crates should stay in the garden.' }], otherTalk: [range(1, 4)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.equal(notes.summary.length, 0);
  assert.equal(notes.needsReview.length, 4);
  assert.deepEqual(notes.needsReview.map(i => i.reviewReason), Array(4).fill(nonProject));
  assert.equal(notes.needsReview[2].quotes![0].quoteIn, 'corrected');
  assert.equal(notes.needsReview[2].quotes![1].quoteIn, null);
  assert.equal(notes.needsReview[3].quoteIn, null);
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('non-quote model cites do not count as evidence but still receive the non-project flag', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [1, 2, 3].map(n => ({ ...item(n), cites: ['S20', `S${n}`] })), otherTalk: [range(20, 20)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.equal(notes.summary.length, 0);
  assert.deepEqual(notes.needsReview.map(i => i.reviewReason), Array(3).fill(nonProject));
  assert.deepEqual(notes.needsReview.map(i => i.quotes![0].cites), [['line-1'], ['line-2'], ['line-3']]);
  assert.ok(notes.needsReview.every(i => i.cites.includes('line-20')));
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('located quote evidence counts even when the model cites are outside the range', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [1, 2, 3].map(n => ({ ...item(n), cites: ['S20'] })), otherTalk: [range(1, 3)] }, snapshot);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 3);
  assert.ok(notes.summary.every(i => i.quoteCheck === 'located'));
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped, [ignored(1, 3, 3)]);
  assert.equal(otherTalkIgnored, 1);
});

test('duplicates count once by normalized text, including copies in other project sections', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [item(1), { ...item(1), text: item(1).text.toUpperCase() }, item(2)],
    decisions: [item(1)], actions: [item(2)], otherTalk: [range(1, 2)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.deepEqual(notes.needsReview.map(i => i.reviewReason), Array(4).fill(nonProject));
  assert.deepEqual(dropped, [{ section: 'summary', text: item(1).text.toUpperCase(), reason: 'duplicate' }]);
  assert.equal(otherTalkIgnored, 0);
});

test('many passed quote lines from two items still count as only two items', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [
    { ...item(1), cites: ['S1', 'S2', 'S3'], quotes: [line(1), line(2), line(3)] },
    { ...item(4), cites: ['S4', 'S5'], quotes: [line(4), line(5)] }], otherTalk: [range(1, 5)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.deepEqual(notes.needsReview.map(i => i.reviewReason), [nonProject, nonProject]);
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('two ranges are reconciled independently, keeping the uncontradicted one', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ ...project(3), actions: [item(22)], otherTalk: [range(1, 3), range(22, 24)] }, snapshot);
  assert.deepEqual(notes.otherTalk.map(r => [r.fromId, r.toId]), [['line-22', 'line-24']]);
  assert.equal(notes.summary.length, 3);
  assert.equal(notes.actions.length, 0);
  assert.equal(notes.needsReview.length, 1);
  assert.equal(notes.needsReview[0].reviewReason, nonProject);
  assert.deepEqual(dropped, [ignored(1, 3, 3)]);
  assert.equal(otherTalkIgnored, 1);
});

test('otherMatters items never count as verified project evidence', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ summary: [item(1)], otherMatters: [item(2), item(3), item(4)], otherTalk: [range(1, 4)] }, snapshot);
  assert.equal(notes.otherTalk.length, 1);
  assert.equal(notes.otherMatters.length, 3);
  assert.equal(notes.summary.length, 0);
  assert.equal(notes.needsReview.length, 1);
  assert.equal(notes.needsReview[0].reviewReason, nonProject);
  assert.deepEqual(dropped, []);
  assert.equal(otherTalkIgnored, 0);
});

test('invalid ranges are dropped separately and never counted as ignored contradictions', () => {
  const { notes, dropped, otherTalkIgnored } = check(3, [range(1, 3), range(2, 99), range(8, 2)]);
  assert.deepEqual(notes.otherTalk, []);
  assert.deepEqual(notes.needsReview, []);
  assert.deepEqual(dropped.map(d => d.reason), ['invalid range', 'invalid range', ignored(1, 3, 3).reason]);
  assert.equal(otherTalkIgnored, 1);
});

test('legacy offTopic output uses the same evidence rule', () => {
  const { notes, dropped, otherTalkIgnored } = validateNotes({ ...project(3), offTopic: [range(1, 24)] }, snapshot);
  assert.deepEqual(notes.otherTalk, []);
  assert.equal(notes.summary.length, 3);
  assert.deepEqual(dropped, [ignored(1, 24, 3)]);
  assert.equal(otherTalkIgnored, 1);
});

test('three-part jobs wait for otherTalk, reconcile evidence after merging and persist the conflict count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-othertalk-guard-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Fictional lantern workshop');
  let release!: () => void, otherStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { otherStarted = resolve; });
  const runner: NotesRunner = async input => {
    if (input.instructions.includes('notes: otherMatters,')) {
      otherStarted(); await gate;
      return { text: JSON.stringify({ otherTalk: [range(1, 3), range(1, 24), range(24, 24)] }), model: 'scripted' };
    }
    return { text: JSON.stringify({ summary: [item(1)], decisions: [item(2)], actions: [item(3)] }), model: 'scripted' };
  };
  let published!: () => void;
  const saved = new Promise<void>(resolve => { published = resolve; });
  const jobs = new NotesJobs({ store, directory, runner, clock: Date.now, glossaryFor: async () => null, onSaved: published });
  try {
    for (let i = 0; i < 24; i++) {
      const chunk = await store.addPcm(meeting.id, 'mic:fixture', i, i * 1000, 16000, Buffer.alloc(16000 * 4));
      store.completeChunk(chunk.id, { text: line(i + 1), words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
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
    assert.equal(record.notes.actions.length, 1);
    const lastLine = (await jobs.snapshot(meeting.id)).segments[23];
    assert.deepEqual(record.notes.otherTalk.map(r => [r.fromId, r.toId]), [[lastLine.id, lastLine.id]]);
    assert.deepEqual(record.notes.needsReview, []);
    assert.deepEqual(record.dropped, [ignored(1, 3, 3), ignored(1, 24, 3)]);
    const history = JSON.parse(await readFile(join(directory, 'job-durations.json'), 'utf8'));
    assert.equal(history.notesParts.length, 1);
    assert.equal(history.notesParts[0].otherTalkIgnored, 2);
    assert.equal(typeof history.notesParts[0].otherTalkIgnored, 'number');
    await new DurationHistory(directory).record('plans', 1000, 24);
    const reloaded = JSON.parse(await readFile(join(directory, 'job-durations.json'), 'utf8'));
    assert.deepEqual(reloaded.notesParts, history.notesParts, 'Later history writes preserve the conflict count');
  } finally { release(); await jobs.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('diagnostics whitelist keeps only numeric nonnegative integer conflict counts', () => {
  const parts = Object.fromEntries(['project', 'tasks', 'other'].map(name => [name, { wallMs: 1, requests: [] }]));
  for (const value of [0, 2]) assert.equal(notesDiagnosticsRows([{ jobId: 'fictional', parts, otherTalkIgnored: value }])[0].otherTalkIgnored, value);
  for (const value of [undefined, null, '2', -1, 1.5, NaN, Infinity, { text: 'not telemetry' }]) {
    assert.equal(Object.hasOwn(notesDiagnosticsRows([{ jobId: 'fictional', parts, otherTalkIgnored: value }])[0], 'otherTalkIgnored'), false);
  }
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
