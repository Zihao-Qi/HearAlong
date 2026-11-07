import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSegments, wordSegments } from '../src/segments.ts';
import { MeetingStore } from '../src/store.ts';

type W = { text: string; t0Ms: number; t1Ms: number };
const words = (...items: [string, number, number][]): W[] => items.map(([text, t0Ms, t1Ms]) => ({ text, t0Ms, t1Ms }));
const base = words(
  ['Brindle', 0, 300], ['ferns', 350, 700], ['wobble.', 750, 1200],
  ['Quorra', 1500, 1800], ['tilts', 1850, 2200], ['the', 2250, 2400], ['lantern', 2480, 2900],
  ['softly', 3800, 4200], // 900 ms pause before this word
);
const text = base.map(w => w.text).join(' ');
const expected = buildSegments(20_000, { text, words: base });
const lines = (parts: ReturnType<typeof buildSegments>) => parts.map(p => [p.text, p.startMs, p.endMs, p.timing]);

test('an empty or whitespace-only word anywhere keeps word timings and the same sentence cut', () => {
  assert.deepEqual(expected.map(p => p.text), ['Brindle ferns wobble.', 'Quorra tilts the lantern', 'softly']);
  for (const blank of ['', '   ', '\t']) {
    for (const [where, at, t0Ms, t1Ms] of [['start', 0, 0, 0], ['middle', 6, 2480, 2560], ['end', base.length, 4200, 4300]] as const) {
      const input = [...base.slice(0, at), { text: blank, t0Ms, t1Ms }, ...base.slice(at)];
      const out = buildSegments(20_000, { text, words: input });
      assert.deepEqual(lines(out), lines(expected), `${JSON.stringify(blank)} at the ${where}`);
      assert.deepEqual(lines(wordSegments(20_000, input)), lines(out), `reconstruction matches publication (${where})`);
      assert.deepEqual(wordSegments(20_000, input).map(p => p.words), wordSegments(20_000, base).map(p => p.words));
    }
  }
});

test('an empty word with broken times is dropped rather than rejecting the list', () => {
  const input = [...base.slice(0, 3), { text: '', t0Ms: NaN, t1Ms: -9000 }, ...base.slice(3)];
  assert.deepEqual(lines(buildSegments(20_000, { text, words: input })), lines(expected));
});

test('when every word is empty, fall back as before', () => {
  const blank = words(['', 0, 100], [' ', 200, 300]);
  assert.deepEqual(buildSegments(20_000, { text: 'glim vorn', words: blank }), [{ startMs: 0, endMs: 20_000, text: 'glim vorn', timing: 'chunk' }]);
  assert.deepEqual(buildSegments(20_000, { text: 'glim vorn', words: blank, segments: [{ text: 'glim vorn', t0Ms: 100, t1Ms: 900 }] }),
    [{ startMs: 100, endMs: 900, text: 'glim vorn', timing: 'segment' }]);
  assert.deepEqual(wordSegments(20_000, blank), []);
});

test('an empty native segment is skipped the same way', () => {
  const segments = [{ text: 'Glim vorn.', t0Ms: 100, t1Ms: 900 }, { text: '', t0Ms: 950, t1Ms: 1000 }, { text: 'Pell.', t0Ms: 1100, t1Ms: 1500 }];
  assert.deepEqual(buildSegments(20_000, { text: 'Glim vorn. Pell.', segments }).map(s => [s.text, s.timing]), [['Glim vorn.', 'segment'], ['Pell.', 'segment']]);
  assert.equal(buildSegments(20_000, { text: 'Glim', segments: [{ text: ' ', t0Ms: 0, t1Ms: 10 }] })[0].timing, 'chunk');
});

test('the store publishes sentence lines for a chunk with one empty word', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-empty-word-'));
  const store = new MeetingStore(directory);
  try {
    const meeting = store.createMeeting('Empty word');
    const chunk = await store.addPcm(meeting.id, 'mic:test', 0, 10_000, 16000, Buffer.alloc(4 * 16000 * 6));
    const input = [...base.slice(0, 2), { text: '', t0Ms: 720, t1Ms: 740 }, ...base.slice(2)];
    store.completeChunk(chunk.id, { text, words: input, backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 20, processRssBytes: 0, timestampKind: 'word' });
    assert.deepEqual(store.segments(meeting.id).map(s => [s.text, s.startMs - 10_000, s.endMs - 10_000, s.timing]), lines(expected));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
