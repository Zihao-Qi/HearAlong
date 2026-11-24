import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTitleReply, hasDefaultName, titlePrompt, titleSample, TITLE_SAMPLE_WORDS } from '../src/meeting-title.ts';
import { startServer } from '../src/server.ts';
import type { PiAnswer } from '../src/pi-rpc.ts';
import type { Meeting } from '../src/store.ts';
import { until } from './helpers/setup-pi.ts';
import { AiDeferred } from '../src/ai-deferral.ts';

const answer = (text: string, extra: Partial<PiAnswer> = {}): PiAnswer => ({ text, ms: 1, attempts: 1, aborted: false, stopReason: 'stop', usages: [], ...extra });
const words = (n: number, word = 'lantern') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const stamp = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

test('the sample is the whole transcript when short, else its beginning, middle and end', () => {
  assert.equal(titleSample(['one two', 'three']), 'one two three');
  const long = Array.from({ length: 5000 }, (_, i) => `w${i}`);
  const sample = titleSample([long.join(' ')]);
  const parts = sample.split(' … ');
  assert.equal(parts.length, 3);
  assert.equal(parts.join(' ').split(' ').length, TITLE_SAMPLE_WORDS);
  assert.ok(parts[0].startsWith('w0 ') && parts[2].endsWith(' w4999'), 'beginning and end');
  assert.ok(parts[1].split(' ').includes('w2500'), 'the middle');
  assert.match(titlePrompt('fictional words'), /<<<\nfictional words\n>>>$/);
});

test('a reply becomes one short clean name, or nothing', () => {
  assert.equal(cleanTitleReply('Lantern parade route'), 'Lantern parade route');
  assert.equal(cleanTitleReply('Title: "Kite festival budget."\nSecond line'), 'Kite festival budget');
  assert.equal(cleanTitleReply('\n\n  Lantern parade route  \n'), 'Lantern parade route');
  assert.equal(cleanTitleReply('one two three four five six seven eight nine ten'), 'one two three four five six seven eight', 'at most 8 words');
  for (const empty of ['', '   ', '""', 'Title:']) assert.equal(cleanTitleReply(empty), '', empty);
  // Markdown, labels and lead-in lines, as models often reply.
  assert.equal(cleanTitleReply('**Q3 lantern plan**'), 'Q3 lantern plan');
  assert.equal(cleanTitleReply('# Q3 lantern plan'), 'Q3 lantern plan');
  assert.equal(cleanTitleReply('- Q3 lantern plan'), 'Q3 lantern plan');
  assert.equal(cleanTitleReply('**Title:** Q3 lantern plan'), 'Q3 lantern plan');
  assert.equal(cleanTitleReply("Here's a title:\nQ3 lantern plan"), 'Q3 lantern plan');
  assert.equal(cleanTitleReply('1. Q3 lantern plan\n2. Kite budget'), 'Q3 lantern plan', 'the first of several');
  assert.equal(cleanTitleReply('```text\nQ3 lantern plan\n```'), 'Q3 lantern plan', 'a fenced block with a language tag');
  assert.equal(cleanTitleReply('I/O performance tuning'), 'I/O performance tuning', 'a title may start with I');
  for (const refusal of ['"I cannot name this."', 'N/A.', 'None.', 'Untitled', "I'm sorry, I can't tell.", 'I\u2019m sorry, I can\u2019t tell.', 'I am sorry.', 'Untitled meeting', 'Meeting 22 Nov, 18:21'])
    assert.equal(cleanTitleReply(refusal), '', refusal);
  assert.equal(cleanTitleReply('```Q3 lantern plan```'), 'Q3 lantern plan', 'a one-line fence');
  // A refusal or an explanation is no name.
  for (const refusal of ['I cannot determine the topic of this noisy transcript.', "Sorry, there isn't enough to go on.", 'Unable to tell', 'N/A',
    'The participants talked about many unrelated things and no single topic stands out clearly here']) assert.equal(cleanTitleReply(refusal), '', refusal);
});

test('only a name HearAlong made up counts as default', () => {
  const at = Date.now();
  const meeting = (title: string, autoTitle: string | null, replay: string | null = null) => ({ id: 'm', title, autoTitle, createdAt: at, replay }) as Meeting;
  assert.equal(hasDefaultName(meeting('Untitled meeting', 'Untitled meeting')), true);
  assert.equal(hasDefaultName(meeting(`Meeting ${stamp(at)}`, `Meeting ${stamp(at)}`)), true);
  assert.equal(hasDefaultName(meeting('kite.m4a (replay)', 'kite.m4a (replay)', '{}')), true);
  assert.equal(hasDefaultName(meeting('kite.m4a (replay)', 'kite.m4a (replay)')), false, 'not a replay meeting');
  assert.equal(hasDefaultName(meeting('Lantern parade route', 'Lantern parade route')), false, 'already named by notes or a title pass');
  assert.equal(hasDefaultName(meeting('Untitled meeting', null)), false, 'the user typed it');
  assert.equal(hasDefaultName(meeting('Meeting 22 Nov, 18:21', 'Meeting 22 Nov, 18:21')), true, 'the page\'s stamp in another locale');
  assert.equal(hasDefaultName(meeting('Meeting with the lantern club', 'Meeting with the lantern club')), false, 'no stamp');
  assert.equal(hasDefaultName(meeting('Meeting 2026 roadmap', 'Meeting 2026 roadmap')), false, 'a notes title with digits but no clock time');
  assert.equal(hasDefaultName(meeting('Meeting 24 nov., 08 h 41', 'Meeting 24 nov., 08 h 41')), true, 'a French Canadian stamp');
  assert.equal(hasDefaultName(meeting('Meeting \u0662\u0664 \u0646\u0648\u0641\u060c \u0660\u0668:\u0664\u0661', 'Meeting \u0662\u0664 \u0646\u0648\u0641\u060c \u0660\u0668:\u0664\u0661')), true, 'Arabic-Indic digits');
});

async function server(t: any, ask: (message: string) => Promise<PiAnswer>) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-title-auto-'));
  const asked: string[] = [];
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, notes: null, board: null, actions: null, plans: null,
    titles: message => { asked.push(message); return ask(message); }, titleTickMs: 20 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  /** A meeting with `n` transcript words whose recording has just ended. */
  const recorded = async (title: string, n: number, madeUp = true, word = 'lantern', replay?: object) => {
    const meeting = app.store.createMeeting(title, madeUp);
    const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
    app.store.completeChunk(chunk.id, { text: words(n, word), words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    // A replay meeting takes no new audio: it becomes one after its transcript is in, before its end is recorded.
    if (replay) app.store.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify(replay), meeting.id);
    app.store.recordingEnded(meeting.id, Date.now());
    return meeting.id;
  };
  const title = (id: string) => app.store.meeting(id).title;
  /** Enough ticks for every waiting meeting to be looked at. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));
  return { app, asked, recorded, title, settle };
}

test('after a recording ends, a meeting with a made-up name is named from its transcript', async t => {
  const s = await server(t, async () => answer('"Lantern parade route."'));
  const id = await s.recorded(`Meeting ${stamp(Date.now())}`, 200);
  await until(() => s.title(id) === 'Lantern parade route', 5000, 'the meeting to be named');
  assert.equal(s.app.store.meeting(id).autoTitle, 'Lantern parade route', 'still the app\'s name: notes may improve it, a rename protects it');
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /lantern0 lantern1/);
});

test('no call for a name the user gave, a short recording, or one that ended before the app started', async t => {
  const s = await server(t, async () => answer('Kite festival'));
  const old = s.app.store.createMeeting('Untitled meeting', true);
  const chunk = await s.app.store.addPcm(old.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
  s.app.store.completeChunk(chunk.id, { text: words(300), words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  s.app.store.recordingEnded(old.id, Date.now() - 3_600_000);
  const typed = await s.recorded('Untitled meeting', 300, false);
  const short = await s.recorded('Untitled meeting', 100);
  await s.settle();
  assert.deepEqual(s.asked, []);
  assert.deepEqual([s.title(old.id), s.title(typed), s.title(short)], ['Untitled meeting', 'Untitled meeting', 'Untitled meeting']);
});

test('a failed or unusable answer leaves the name and is not retried', async t => {
  let mode: 'throw' | 'empty' | 'cut' = 'throw';
  const s = await server(t, async () => {
    if (mode === 'throw') throw new Error('fictional model failure');
    return mode === 'empty' ? answer('  ') : answer('Kite festival', { stopReason: 'length' });
  });
  const failed = await s.recorded('Untitled meeting', 200);
  await until(() => s.asked.length === 1, 5000, 'the first call');
  mode = 'empty';
  const empty = await s.recorded('Untitled meeting', 200, true, 'kite');
  await until(() => s.asked.length === 2, 5000, 'the second call');
  mode = 'cut';
  const cut = await s.recorded('Untitled meeting', 200, true, 'ribbon');
  await until(() => s.asked.length === 3, 5000, 'the third call');
  await s.settle();
  assert.equal(s.asked.length, 3, 'one attempt each');
  assert.deepEqual([s.title(failed), s.title(empty), s.title(cut)], ['Untitled meeting', 'Untitled meeting', 'Untitled meeting']);
});

test('notes or the user naming the meeting during the call win', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const s = await server(t, async () => { await held; return answer('Kite festival'); });
  const id = await s.recorded('Untitled meeting', 200);
  await until(() => s.asked.length === 1, 5000, 'the call');
  assert.equal(s.app.store.titleFromNotes(id, 'Lantern parade route'), true);
  release();
  await s.settle();
  assert.equal(s.title(id), 'Lantern parade route');
});

test('a later recording in a meeting that still has its made-up name gets one more try', async t => {
  let reply = '';
  const s = await server(t, async () => answer(reply));
  const id = await s.recorded('Untitled meeting', 200);
  await until(() => s.asked.length === 1, 5000, 'the first call');
  await s.settle();
  assert.equal(s.title(id), 'Untitled meeting');
  reply = 'Lantern parade route';
  s.app.store.recordingEnded(id, Date.now() + 1);
  await until(() => s.title(id) === 'Lantern parade route', 5000, 'the second try');
  assert.equal(s.asked.length, 2);
});

test('replays are named when the replay has played to its end', async t => {
  const s = await server(t, async () => answer('Kite festival'));
  // Still playing for a moment: still coming in, so it waits; then it has played to its end.
  const id = await s.recorded('kite.m4a (replay)', 200, true, 'kite', { sourceId: 'r', startedAt: Date.now(), speed: 1, baseMs: 0, durationMs: 400 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(s.asked, [], 'not while the replay plays');
  await until(() => s.title(id) === 'Kite festival', 5000, 'the replay to be named');
});

test('a call the model lane postpones is not an attempt: a later tick names the meeting', async t => {
  let postpone = true;
  const s = await server(t, async () => {
    if (postpone) { postpone = false; throw new AiDeferred(); }
    return answer('Lantern parade route');
  });
  const id = await s.recorded('Untitled meeting', 200);
  await until(() => s.title(id) === 'Lantern parade route', 5000, 'the retry');
  assert.equal(s.asked.length, 2);
});

test('a meeting that is not ready yet is checked again: a replay marked just after its upload, words added by a retry', async t => {
  const s = await server(t, async () => answer('Kite festival'));
  // Its end is recorded before it is marked as a replay (as /upload then /replay do).
  const replay = await s.recorded('kite.m4a (replay)', 200);
  // 100 words came through; the second piece failed, and the user retries it later.
  const short = s.app.store.createMeeting('Untitled meeting', true).id;
  const done = await s.app.store.addPcm(short, 'mic:fixture', 0, 0, 16000, Buffer.alloc(64000));
  s.app.store.completeChunk(done.id, { text: words(100, 'ribbon'), words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const failed = await s.app.store.addPcm(short, 'mic:fixture', 1, 1000, 16000, Buffer.alloc(64000));
  s.app.store.failChunk(failed.id, 'fictional recognizer failure', null);
  s.app.store.recordingEnded(short, Date.now());
  await s.settle();
  assert.deepEqual(s.asked, []);
  s.app.store.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify({ sourceId: 'r', startedAt: Date.now() - 60_000, speed: 1, baseMs: 0, durationMs: 1000 }), replay);
  s.app.store.retryChunk(failed.id);
  s.app.store.completeChunk(failed.id, { text: words(100, 'kite'), words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  await until(() => s.title(replay) === 'Kite festival' && s.title(short) === 'Kite festival', 5000, 'both to be named');
});

test('a meeting named by notes is looked at once, not on every tick', async t => {
  const s = await server(t, async () => answer('Kite festival'));
  const id = await s.recorded('Untitled meeting', 200);
  // Notes name it before the first tick sees it.
  assert.equal(s.app.store.titleFromNotes(id, 'Lantern parade route'), true);
  let looks = 0;
  const meeting = s.app.store.meeting.bind(s.app.store);
  t.mock.method(s.app.store, 'meeting', (meetingId: string) => { if (meetingId === id) looks++; return meeting(meetingId); });
  await s.settle(); await s.settle();
  assert.ok(looks <= 1, `looked at ${looks} times`);
  assert.deepEqual(s.asked, []);
  assert.equal(s.title(id), 'Lantern parade route');
});

test('a short meeting is counted again only when its transcript changes, not on every tick', async t => {
  const s = await server(t, async () => answer('Kite festival'));
  const id = await s.recorded('Untitled meeting', 100);
  let counts = 0;
  const segments = s.app.store.segments.bind(s.app.store);
  t.mock.method(s.app.store, 'segments', (meetingId: string) => { if (meetingId === id) counts++; return segments(meetingId); });
  await s.settle(); await s.settle();
  assert.ok(counts <= 1, `counted ${counts} times over about 20 ticks`);
  assert.deepEqual(s.asked, []);
});
