import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { rolesFor } from '../src/speakers.ts';
import { scanInput, scanInstructions, scanWindow, validateItems } from '../src/board.ts';
import { inputHash, notesInput, notesInstructions, sourcesFor, takeSnapshot } from '../src/notes.ts';
import { actionInput, captureContext, checkTranscriptSource } from '../src/actions.ts';
import type { Recognition } from '../src/recognizer.ts';

const MIC = 'mic:00000000-0000-0000-0000-00000000000a';
const TAB = 'tab:00000000-0000-0000-0000-00000000000b';
const ROOM = 'mic:00000000-0000-0000-0000-00000000000c';
const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
async function fixture(lines: [string, number, string][]) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-speakers-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Online meeting');
  const sequence = new Map<string, number>();
  for (const [source, startMs, text] of lines) {
    const n = sequence.get(source) ?? 0; sequence.set(source, n + 1);
    const chunk = await store.addPcm(meeting.id, source, n, startMs, 16000, Buffer.alloc(16000 * 4, n + 1)); // 1 s each
    store.completeChunk(chunk.id, recognition(text));
  }
  return { directory, store, meeting, segments: () => store.visibleSegments(meeting.id, Date.now()), async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('roles per line: the tab is Them; the microphone is Me from the first share until Stop (pauses included); room speech before it and imports are unlabelled', () => {
  // One microphone source recording the room from 0 s; the meeting tab is added at 120 s and stops sharing at 220 s.
  const r = rolesFor([
    { source: ROOM, startMs: 0, endMs: 60_000 },
    { source: MIC, startMs: 0, endMs: 300_000 },
    { source: TAB, startMs: 120_000, endMs: 220_000 },
    { source: 'file:x', startMs: 300_000, endMs: 400_000 },
  ]);
  assert.equal(r.labelled, true);
  assert.equal(r.roleOf(TAB, 150_000, 152_000), 'them');
  assert.equal(r.roleOf(MIC, 50_000, 52_000), undefined, 'room speech before the tab, same microphone source');
  assert.equal(r.roleOf(MIC, 150_000, 152_000), 'me');
  assert.equal(r.roleOf(MIC, 250_000, 252_000), 'me', 'after the share ended, same recording: still the call');
  assert.equal(r.roleOf(ROOM, 10_000, 12_000), undefined);
  assert.equal(r.roleOf('file:x', 310_000, 312_000), undefined);
  assert.equal(rolesFor([{ source: MIC, startMs: 0, endMs: 1000 }]).labelled, false);
});

test('export paragraphs: a speaker change does not carry the previous speaker\'s end into the next paragraph', async () => {
  // Me [0, 20 s] long; Them at 10 s and again at 14 s after a 3 s gap: two Them paragraphs, as in the app.
  const directory = await mkdtemp(join(tmpdir(), 'meeting-speakers-md-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('x');
    const add = async (source: string, n: number, startMs: number, seconds: number, text: string) => {
      const chunk = await store.addPcm(meeting.id, source, n, startMs, 16000, Buffer.alloc(16000 * 4 * seconds, n + 1));
      store.completeChunk(chunk.id, recognition(text));
    };
    await add(MIC, 0, 0, 20, 'a long sentence from the microphone');
    await add(TAB, 0, 10_000, 1, 'first remote line');
    await add(TAB, 1, 14_000, 1, 'second remote line');
    const md = store.markdown(meeting.id);
    assert.match(md, /\] Them: first remote line\n\n\[[^\]]+\] Them: second remote line/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an online meeting labels lines, joins quotes only within one speaker, and exports Me/Them; an in-person one is unchanged', async () => {
  // Me says one sentence over two lines while Them answers in between.
  const f = await fixture([
    [MIC, 0, 'The jellyfish tank needs a mesh cover'],
    [TAB, 500, 'I found the spare clips'],
    [MIC, 1000, 'before the night feeder starts'],
    [TAB, 2000, ''], // the tab is captured throughout (silence here), as in a real call
  ]);
  try {
    const speakers = f.store.speakers(f.meeting.id);
    const window = scanWindow(f.segments(), {}, speakers)!;
    assert.equal(window.labelled, true);
    const input = scanInput(window, [], [], 'Online meeting');
    assert.match(input, /S1 \[00:00\] NEW Me: The jellyfish tank/);
    assert.match(input, /S2 \[00:00\] NEW Them: I found the spare clips/);
    assert.match(scanInstructions('discussion', true), /recording channels/);
    const refOf = (text: string) => window.lines.find(l => l.segment.text.startsWith(text))!.ref;
    const base = { type: 'claim', text: 'x', confidence: 'high', materials: false, nonProject: false };
    const { kept, dropped } = validateItems({ items: [
      // One channel's sentence, across the other channel's line in between: accepted.
      { ...base, text: 'Cover the jellyfish tank before feeding', cites: [refOf('The jellyfish'), refOf('before')], quote: 'a mesh cover before the night feeder starts' },
      // Words joined across the two channels never occurred as one phrase: refused.
      { ...base, text: 'cross', cites: [refOf('The jellyfish'), refOf('I found')], quote: 'mesh cover I found the spare clips' },
    ] }, window, f.segments());
    assert.deepEqual(kept.map(k => k.text), ['Cover the jellyfish tank before feeding']);
    assert.deepEqual(dropped.map(d => d.reason), ['quote joins lines of different speakers']);

    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    assert.equal(snapshot.labelled, true);
    assert.deepEqual(snapshot.segments.map(s => s.speaker), ['Me', 'Them', 'Me']);
    assert.match(notesInput(snapshot), /S2 \[00:00\] Them: I found/);
    assert.match(notesInstructions(true), /"Them" is not one person/);
    assert.equal(snapshot.coverage.untilMs, 2000, 'coverage is the latest end, not the last line');

    const context = captureContext(f.store, f.meeting.id, { text: 'night feeder', segmentIds: [snapshot.segments[2].id] }, Date.now(), null, []);
    assert.deepEqual(context.lines.map(l => l.speaker), ['Me', 'Them', 'Me']);
    assert.match(actionInput({ action: 'explain', prompt: null, context } as never), />> \[00:01\] Me: before the night feeder/);
    assert.equal(checkTranscriptSource({ id: 1, time: '00:00', quote: 'mesh cover before the night feeder' }, context.lines).status, 'quote found');
    assert.equal(checkTranscriptSource({ id: 2, time: '00:00', quote: 'mesh cover I found the spare' }, context.lines).status, 'quote not found');

    // Labels are kept with the saved evidence: board occurrences and note citations.
    assert.deepEqual(kept[0].occurrence.lines.map(l => l.speaker), ['Me', 'Me']);
    const notes = { summary: [{ text: 'x', cites: [snapshot.segments[1].id], quote: 'I found the spare clips' }], decisions: [], actions: [], openQuestions: [], otherMatters: [], needsReview: [], otherTalk: [] };
    assert.equal(sourcesFor(notes as never, snapshot)[snapshot.segments[1].id].speaker, 'Them');

    const md = f.store.markdown(f.meeting.id);
    assert.match(md, /\] Me: The jellyfish tank needs a mesh cover\n\n\[[^\]]+\] Them: I found the spare clips\n\n\[[^\]]+\] Me: before/);
  } finally { await f.close(); }

  // In person (no tab): exactly the old lines, instructions and hash.
  const g = await fixture([[MIC, 0, 'The jellyfish tank needs a mesh cover'], [MIC, 1000, 'before the night feeder starts']]);
  try {
    const snapshot = takeSnapshot(g.store, g.meeting.id, Date.now(), null);
    assert.equal(snapshot.labelled, undefined);
    assert.ok(snapshot.segments.every(s => !('speaker' in s) && !('source' in s)));
    assert.doesNotMatch(notesInput(snapshot), /Me:|Them:/);
    assert.equal(notesInstructions(false), notesInstructions());
    assert.match(notesInstructions(), /no speaker\nlabels/);
    const legacy = createHash('sha256').update(JSON.stringify({ glossaryVersion: snapshot.glossaryVersion, coverage: snapshot.coverage,
      segments: snapshot.segments.map(s => [s.id, s.revision, s.startMs, s.endMs, s.text, s.originalText]) })).digest('hex');
    assert.equal(snapshot.inputHash, legacy, 'unlabelled notes hash exactly as before');
    assert.equal(inputHash(snapshot.segments, snapshot.glossaryVersion, snapshot.coverage), legacy);
    const window = scanWindow(g.segments(), {}, g.store.speakers(g.meeting.id))!;
    assert.equal(window.labelled, false);
    assert.doesNotMatch(scanInput(window, [], [], 'x'), /Me:|Them:/);
    assert.match(scanInstructions('discussion'), /no speaker labels/);
    assert.match(g.store.markdown(g.meeting.id), /No speaker labels;/);
  } finally { await g.close(); }
});

test('the same words at the same time on both channels are reported as such, not pinned to one speaker', () => {
  const line = (id: string, source: string, speaker: string) => ({ id, revision: 0, startMs: 5000, endMs: 6000, text: 'Keep the blue hose dry', originalText: 'Keep the blue hose dry', selected: false, source, speaker });
  const check = checkTranscriptSource({ id: 1, time: '00:05', quote: 'the blue hose dry' }, [line('a', MIC, 'Me'), line('b', TAB, 'Them')]);
  assert.equal(check.status, 'quote found');
  assert.match(check.detail ?? '', /both channels \(Me, Them\)/);
  const single = checkTranscriptSource({ id: 2, time: '00:05', quote: 'the blue hose dry' }, [line('b', TAB, 'Them')]);
  assert.equal(single.label, 'Transcript [00:05] · Them');
});
