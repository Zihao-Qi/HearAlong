import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedWords, composePreview, newestWords, miniPreviewWords, miniPendingRows } from '../public/preview-composition.js';
import { transcriptRows } from '../public/transcript-view.js';
import { handoffCases, words, source, active, pending } from './fixtures/m9a-handoff.ts';

for (const scenario of handoffCases()) test(`M9a composition: ${scenario.name}`, () => {
  for (const [i, snapshot] of scenario.steps.entries()) {
    const visible = transcriptRows(snapshot).flatMap(row => [
      ...row.segments.flatMap(s => s.text.split(/\s+/)), ...(row.preview?.words.map(w => w.text) ?? []),
    ]);
    assert.deepEqual(visible, words.map(w => w.text), `render ${i}: no omissions, repetitions or time-order inversions`);
    assert.equal(newestWords(source, snapshot.segments, snapshot.drafts, snapshot.pending), words.map(w => w.text).join(' '));
    const log = [...snapshot.segments, ...miniPendingRows(snapshot.segments, snapshot.drafts, snapshot.pending)].sort((a, b) => a.startMs - b.startMs);
    const mini = [...log.map(s => s.text), miniPreviewWords(source, snapshot.segments, snapshot.drafts, snapshot.pending)].filter(Boolean).join(' ');
    assert.equal(mini, words.map(w => w.text).join(' '), 'the mini log and preview slots show each word once too');
  }
});
test('M9a tokens: join subwords, preserve punctuation, add window clock once, and assign a boundary-straddling word once', () => {
  const result = timedWords([
    { text: ' Be', t0Ms: 560, t1Ms: 640 }, { text: 'fore', t0Ms: 560, t1Ms: 640 },
    { text: ' you', t0Ms: 800, t1Ms: 880 }, { text: ',', t0Ms: 880, t1Ms: 960 },
  ], 20_000);
  assert.deepEqual(result, [{ text: 'Before', startMs: 20_560, endMs: 20_640 }, { text: 'you,', startMs: 20_800, endMs: 20_960 }]);
  const p = pending('c', 0, 3, [{ text: 'across', startMs: 2900, endMs: 3100 }]);
  assert.equal(composePreview([active(3, 4)], [p]).flatMap(r => r.words).filter(w => w.text === 'across').length, 0, 'midpoint belongs to the new interval, not both');
});
test('M9a composition: sources do not mask each other and mini keeps exactly the latest 20 words', () => {
  const d = active(0, 6), other = { ...d, source: 'tab:other', words: words.map(w => ({ ...w, text: `them-${w.text}` })) };
  assert.equal(composePreview([other], [pending('c', 0, 3)]).flatMap(p => p.words).length, 12);
  const final = [{ source, startMs: -1, text: Array.from({ length: 25 }, (_, i) => `old${i}`).join(' ') }];
  const text = newestWords(source, final, [d], []);
  assert.equal(text.split(' ').length, 20);
  assert.ok(text.endsWith('one two three four five six'));
});
