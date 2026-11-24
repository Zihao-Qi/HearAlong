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
