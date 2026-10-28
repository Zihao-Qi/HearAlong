import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptRows } from '../public/transcript-view.js';
import { gapPreviewKeyCases, keyGap } from './fixtures/gap-preview-keys.ts';
import { handoffCases, words, active, pending, final } from './fixtures/m9a-handoff.ts';

const earlierGap = { ...keyGap, atMs: 0 };

test('unrelated earlier gap preserves every M9a row key and grouping in all handoff snapshots', () => {
  for (const scenario of handoffCases()) for (const snapshot of scenario.steps) {
    assert.deepEqual(transcriptRows({ ...snapshot, captureGaps: [earlierGap] }).filter(r => !r.gap), transcriptRows(snapshot), scenario.name);
  }
});

test('unrelated earlier gap preserves the before-cut chunk key shared with the first final paragraph', () => {
  const waiting = transcriptRows({ segments: [], pending: [pending('handoff', 0, 3)], captureGaps: [earlierGap] });
  const completed = transcriptRows({ segments: [final('handoff', 0, 3)], captureGaps: [earlierGap] });
  assert.equal(waiting.find(r => r.preview?.part === 'before')?.key, 'chunk:handoff');
  assert.equal(completed.find(r => !r.gap)?.key, 'chunk:handoff');
});

test('unrelated earlier gap does not rekey post-cut rows when the first word time is revised', () => {
  const draft = active(0, 6);
  const revised = { ...draft, words: draft.words.map((w, i) => i ? w : { ...w, startMs: w.startMs + 50 }) };
  const first = transcriptRows({ segments: [], drafts: [draft], captureGaps: [earlierGap] }).find(r => r.preview)!;
  const next = transcriptRows({ segments: [], drafts: [revised], captureGaps: [earlierGap] }).find(r => r.preview)!;
  const baseline = transcriptRows({ segments: [], drafts: [draft] }).find(r => r.preview)!;
  assert.equal(first.key, baseline.key);
  assert.equal(next.key, baseline.key);
});

for (const scenario of gapPreviewKeyCases()) test(`gap keys: ${scenario.name}`, () => {
  const rows = transcriptRows(scenario.snapshot);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'every row must have a unique key before keyed rendering');
  assert.deepEqual(rows.map(r => r.gap ? 'GAP' : r.preview?.text ?? r.segments.map(s => s.text).join(' ')), scenario.text);
  const shown = rows.flatMap(r => r.preview?.words ?? []);
  const owned = [...scenario.snapshot.drafts, ...scenario.snapshot.pending].flatMap(p => p.words);
  assert.equal(shown.length, owned.length);
  for (const word of owned) assert.equal(shown.filter(w => w === word).length, 1, 'each owned word exactly once');
  assert.deepEqual(rows.map(r => r.startMs), rows.map(r => r.startMs).sort((a, b) => a - b), 'rows stay in audio-clock order');
  for (const row of rows.filter(r => r.preview)) assert.deepEqual(row.preview!.words.map(w => w.startMs),
    row.preview!.words.map(w => w.startMs).sort((a, b) => a - b), 'owned words stay ordered inside each run');
  // Keeping an unaffected M9a run intact is deliberate, even beside another source's interleaved words.
  const baseline = transcriptRows({ ...scenario.snapshot, captureGaps: [] });
  for (const original of baseline.filter(r => r.preview?.words.every(w => w.startMs >= keyGap.atMs))) {
    assert.deepEqual(rows.find(r => r.preview?.words[0] === original.preview!.words[0]), original,
      'a run wholly after the gap retains exactly its M9a identity and grouping');
  }
  // Repeated polling and suffix growth must keep keys while the first word of a run is unchanged.
  const grown = { ...scenario.snapshot, drafts: scenario.snapshot.drafts.map(p => ({ ...p,
    words: [...p.words, { text: `new-${p.source}`, startMs: 1800, endMs: 1900 }] })) };
  const after = transcriptRows(grown);
  for (const row of rows.filter(r => r.preview)) {
    const sameFirstWord = after.find(r => r.preview?.words[0] === row.preview!.words[0]);
    assert.equal(sameFirstWord?.key, row.key);
  }
  assert.equal(new Set(after.map(r => r.key)).size, after.length);
});

test('gap keys stay stable when an earlier same-slot run disappears but a separating source remains', () => {
  const snapshot = gapPreviewKeyCases().find(c => c.name === 'another source between same-slot runs prevents coalescing')!.snapshot;
  const before = transcriptRows(snapshot);
  const after = transcriptRows({ ...snapshot, drafts: snapshot.drafts.map(p => p.source === 'mic:test' ? { ...p, words: p.words.slice(1) } : p) });
  assert.equal(before.find(r => r.preview?.text === 'two')?.key, after.find(r => r.preview?.text === 'two')?.key);
});

test('unique keys and every word across all M9a handoffs, with and without gap barriers', () => {
  for (const scenario of handoffCases()) for (const snapshot of scenario.steps) {
    for (const captureGaps of [[], ...[-100, 100, 200, 1000, 2000, 3100, 5000, 7000].map(atMs => [{ ...keyGap, atMs }]),
      [1000, 3000, 5000].map((atMs, i) => ({ ...keyGap, atMs, fromWallMs: 1000000 * (i + 1), toWallMs: 1000000 * (i + 1) + 497000 }))]) {
      const rows = transcriptRows({ ...snapshot, captureGaps });
      assert.equal(new Set(rows.map(r => r.key)).size, rows.length, scenario.name);
      const shown = rows.flatMap(r => r.gap ? [] : r.preview?.words.map(w => w.text) ?? r.segments.flatMap(s => s.text.split(/\s+/)));
      assert.deepEqual(shown, words.map(w => w.text), scenario.name);
    }
  }
});
