import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capPass, capWordEnd, wordCapMs, MAX_WORD_MS, MIN_WORD_MS } from '../src/word-ends.ts';
import { buildSegments, wordSegments } from '../src/segments.ts';
import { transcribeRecovering, type Word } from '../src/recovery.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { MeetingStore, type Chunk } from '../src/store.ts';

const words = (...items: [string, number, number][]): Word[] => items.map(([text, t0Ms, t1Ms]) => ({ text, t0Ms, t1Ms }));
const lines = (parts: { text: string; startMs: number; endMs: number }[]) => parts.map(p => [p.text, p.startMs, p.endMs]);
const recognition = (text: string, list: Word[], extra: object = {}) => ({ text, words: list, backend: 'fixture', computeMs: 1, decodeMs: 0,
  audioSeconds: 20, processRssBytes: 0, timestampKind: 'word', ...extra });

test('a word ends at most 90 ms per character after its start, within 400–1200 ms', () => {
  assert.equal(wordCapMs('ox'), MIN_WORD_MS, 'short words get the floor');
  assert.equal(wordCapMs('  marsh '), 450, 'trimmed characters count');
  assert.equal(wordCapMs('onward.'), 630, 'punctuation counts as characters');
  assert.equal(wordCapMs('counterbalancing'), MAX_WORD_MS, 'long words get the ceiling');
  assert.equal(wordCapMs(''), MIN_WORD_MS);
  assert.deepEqual(capWordEnd({ text: 'ox', t0Ms: 1000, t1Ms: 3000 }), { text: 'ox', t0Ms: 1000, t1Ms: 1400 });
  assert.deepEqual(capWordEnd({ text: 'counterbalancing', t0Ms: 1000, t1Ms: 9000 }), { text: 'counterbalancing', t0Ms: 1000, t1Ms: 2200 });
  assert.deepEqual(capWordEnd({ text: 'onward.', t0Ms: 5480, t1Ms: 20000 }), { text: 'onward.', t0Ms: 5480, t1Ms: 6110 }, 'a stretched last word at the window end');
  const short = { text: 'marsh', t0Ms: 560, t1Ms: 900 };
  assert.equal(capWordEnd(short), short, 'a word already shorter than its cap is unchanged');
  for (const word of [{ text: 'ox', t0Ms: 700, t1Ms: 650 }, { text: 'ox', t0Ms: NaN, t1Ms: 900 }, { text: 'ox', t0Ms: 0, t1Ms: Infinity }]) {
    assert.equal(capWordEnd(word), word, 'the start never moves and broken times are left for the publication checks');
  }
});

test('a native segment ends at the latest capped end of the words starting inside it', () => {
  const pass = capPass({ text: 'Quill hums. Marsh.', words: words(['Quill', 0, 300], ['hums.', 400, 3000], ['Marsh.', 9000, 20000]),
    segments: words(['Quill hums.', 0, 8900], ['Marsh.', 9000, 20000], ['Fen', 21000, 21500], ['Reed', 22000, 22100]) });
  assert.deepEqual(pass.words.map(w => w.t1Ms), [300, 850, 9540]);
  assert.deepEqual(pass.segments!.map(s => [s.t0Ms, s.t1Ms]), [[0, 850], [9000, 9540], [21000, 21500], [22000, 22100]],
    'segments without words keep their ends; ends are never extended');
  assert.deepEqual(capPass({ text: 'x', words: [] }), { text: 'x', words: [] });
});

test('a pause after an unpunctuated word now splits the line; punctuated sentence ends split as before', () => {
  const stretched = words(['maple', 0, 300], ['drift', 350, 2600], ['onward', 2700, 3000]);
  const text = 'maple drift onward';
  assert.deepEqual(lines(buildSegments(20_000, { text, words: stretched })), [['maple drift onward', 0, 3000]], 'the pause was hidden in a word');
  assert.deepEqual(lines(buildSegments(20_000, { text, words: capPass({ text, words: stretched }).words })),
    [['maple drift', 0, 800], ['onward', 2700, 3000]]);
  const sentence = words(['Maple', 0, 300], ['drifts', 350, 600], ['north.', 650, 3500], ['Fern', 3600, 3900]);
  const said = 'Maple drifts north. Fern';
  assert.deepEqual(buildSegments(20_000, { text: said, words: sentence }).map(p => p.text), ['Maple drifts north.', 'Fern']);
  assert.deepEqual(lines(buildSegments(20_000, { text: said, words: capPass({ text: said, words: sentence }).words })),
    [['Maple drifts north.', 0, 1190], ['Fern', 3600, 3900]]);
});

test('recovered halves are each capped before the right half is offset', async () => {
  const pcm = new Float32Array(20 * 16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin(i / 10);
  let calls = 0, cutMs = 0;
  const result = await transcribeRecovering(pcm, async part => {
    calls++;
    if (calls === 2) cutMs = part.length / 16;
    const pass = calls === 1 ? { text: '', words: [] }
      : { text: calls === 2 ? 'Quill' : 'marsh', words: words([calls === 2 ? 'Quill' : 'marsh', 100, 9000]), segments: words(['x', 100, 9000]) };
    return capPass(pass);
  });
  assert.equal(result.recoveredBy, 'halves');
  assert.deepEqual(result.words.map(w => [w.t0Ms, w.t1Ms]), [[100, 550], [cutMs + 100, cutMs + 550]]);
  assert.deepEqual(result.segments!.map(s => [s.t0Ms, s.t1Ms]), [[100, 550], [cutMs + 100, cutMs + 550]]);
});

test('the speech worker returns capped words and the published lines end at them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-worker-'));
  const recognizer = new LocalRecognizer('/fictional/model', new URL('./fixtures/stretched-worker.ts', import.meta.url));
  const store = new MeetingStore(directory);
  t.after(async () => { await recognizer.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'fictional.f32');
  await writeFile(path, Buffer.alloc(4 * 16000 * 20));
  const result = await recognizer.transcribe({ id: 'fictional', path, decodeStart: 0, seconds: 20, sampleRate: 16000 } as Chunk);
  assert.deepEqual(result.words.map(w => [w.text.trim(), w.t0Ms, w.t1Ms]),
    [['Quill', 200, 500], ['marsh', 560, 900], ['hums', 960, 1360], ['gently', 5000, 5400], ['onward.', 5480, 6110]]);
  assert.deepEqual(result.segments!.map(s => [s.t0Ms, s.t1Ms]), [[200, 6110]]);
  const meeting = store.createMeeting('Fictional marsh');
  const chunk = await store.addPcm(meeting.id, 'mic:test', 0, 10_000, 16000, Buffer.alloc(4 * 16000 * 20));
  store.completeChunk(chunk.id, result);
  assert.deepEqual(store.segments(meeting.id).map(s => [s.text, s.startMs - 10_000, s.endMs - 10_000]),
    [['Quill marsh hums', 200, 1360], ['gently onward.', 5000, 6110]]);
  assert.deepEqual(store.recentCallWords(meeting.id, new Set(['mic:test']), 0).map(w => [w.text, w.startMs - 10_000, w.endMs - 10_000]),
    [['Quill', 200, 500], ['marsh', 560, 900], ['hums', 960, 1360], ['gently', 5000, 5400], ['onward.', 5480, 6110]], 'reconstruction matches publication');
});

test('an old chunk with stretched words keeps its saved lines and still reconstructs its word times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-old-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional old meeting');
    const chunk = await store.addPcm(meeting.id, 'tab:call', 0, 0, 16000, Buffer.alloc(4 * 16000 * 20));
    const old = words(['Brindle', 100, 400], ['ferns', 450, 3800], ['wobble', 3900, 4200], ['softly.', 4300, 20000]);
    store.completeChunk(chunk.id, recognition('Brindle ferns wobble softly.', old));
    assert.deepEqual(lines(store.segments(meeting.id)), [['Brindle ferns wobble softly.', 100, 20000]], 'saved as the old code saved it');
    assert.deepEqual(lines(wordSegments(20_000, old)), lines(store.segments(meeting.id)));
    assert.deepEqual(store.recentCallWords(meeting.id, new Set(['tab:call']), 0), old.map(w => ({ text: w.text, startMs: w.t0Ms, endMs: w.t1Ms })));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the echo rule still hides a doubled Me line when both channels have capped word times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-ends-echo-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Fictional lantern call');
    const text = 'copper lanterns glow amber tonight.';
    const said = (shift: number, end: number) => words(['copper', shift, shift + 300], ['lanterns', shift + 400, shift + 700],
      ['glow', shift + 800, shift + 1100], ['amber', shift + 1200, shift + 1500], ['tonight.', shift + 1600, end]);
    const call = await store.addPcm(meeting.id, 'app:call', 0, 4500, 16000, Buffer.alloc(4 * 16000 * 6));
    store.completeChunk(call.id, recognition(text, capPass({ text, words: said(0, 6000) }).words));
    const mic = await store.addPcm(meeting.id, 'mic:room', 0, 4000, 16000, Buffer.alloc(4 * 16000 * 8));
    store.completeChunk(mic.id, recognition(text, capPass({ text, words: said(600, 8000) }).words));
    const all = store.db.prepare('SELECT source, startMs, endMs FROM segments WHERE meetingId=? ORDER BY source').all(meeting.id);
    assert.deepEqual(all.map(s => ({ ...s })), [{ source: 'app:call', startMs: 4500, endMs: 6820 }, { source: 'mic:room', startMs: 4600, endMs: 6920 }]);
    assert.deepEqual(store.segments(meeting.id).map(s => s.source), ['app:call'], 'the Me echo is hidden');
    assert.equal(store.recentCallWords(meeting.id, new Set(['app:call']), 0).at(-1)!.endMs, 6820);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
