import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateNotes, type Snapshot } from '../src/notes.ts';
import { notesOutcomes, recordQuoteChecks, loadQuoteCounts, quoteMetricsPath, summarize } from '../src/quote-metrics.ts';

const quote = 'Keep the painted lanterns on the rack';
function snapshot(matches = [5], original = false): Snapshot {
  return { meetingId: 'fictional', title: 'Lantern workshop', takenAt: 0, glossaryVersion: null, terms: [], inputHash: 'fictional',
    coverage: { untilMs: 20_000, chunks: 20, pendingChunks: 0, gaps: [], uncorrected: 0 },
    segments: Array.from({ length: 20 }, (_, i) => ({ ref: `S${i + 1}`, id: `id${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000, revision: 1,
      text: matches.includes(i + 1) && !original ? quote : `Unrelated fictional line number ${i + 1}.`, originalText: matches.includes(i + 1) ? quote : 'Unrelated original line.' })) };
}
const check = (cites: string[], s = snapshot()) => validateNotes({ summary: [{ text: 'Keep the lanterns on the rack.', cites, quote }] }, s);

for (const offset of [-3, -2, -1, 1, 2, 3]) for (const original of [false, true]) test(`nearby notes: ${offset} lines away, ${original ? 'original' : 'corrected'}, accepted and counted separately`, () => {
  const result = check([`S${5 + offset}`], snapshot([5], original));
  assert.equal(result.notes.summary.length, 1);
  assert.deepEqual(result.notes.summary[0].cites, [`id${5 + offset}`, 'id5']);
  assert.equal(result.notes.summary[0].quoteIn, original ? 'original' : 'corrected');
  assert.deepEqual(notesOutcomes(result), ['passed_after_nearby_line']);
});

test('nearby notes: ambiguous matches, four lines away, and full cite list keep today’s review outcome', () => {
  for (const result of [check(['S6'], snapshot([5, 7])), check(['S9']), check(['S6', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16'])]) {
    assert.equal(result.notes.summary.length, 0); assert.equal(result.notes.needsReview.length, 1);
    assert.equal(result.notes.needsReview[0].reviewReason, 'quote not found in the cited lines');
    assert.deepEqual(notesOutcomes(result), ['quote_not_found']);
  }
});

test('nearby notes: one line counts once even when original and corrected text both match or windows overlap', () => {
  const result = check(['S4', 'S6']);
  assert.equal(result.notes.summary.length, 1);
  assert.deepEqual(result.notes.summary[0].cites, ['id4', 'id6', 'id5']);
});

test('nearby notes: does not join lines, bypass length checks, or turn non-project talk into project notes', () => {
  const s = snapshot([]);
  s.segments[4].text = 'Keep the painted lanterns'; s.segments[5].text = 'on the rack';
  assert.equal(check(['S4'], s).notes.needsReview.length, 1);
  const result = validateNotes({ summary: [{ text: 'Lanterns.', cites: ['S4'], quote: 'Keep the painted' }] }, snapshot());
  assert.equal(result.notes.needsReview[0].reviewReason, 'quote too short to support the item');
  const nonProject = validateNotes({ summary: [{ text: 'Lanterns.', cites: ['S4'], quote }], otherTalk: [{ from: 'S5', to: 'S5', label: 'Small talk' }] }, snapshot());
  assert.equal(nonProject.notes.needsReview[0].reviewReason, 'cites non-project talk; it may belong in Other matters');
});

test('nearby notes: metrics persist as passed and the CLI exposes the nearby outcome per model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nearby-metrics-'));
  try {
    await recordQuoteChecks(directory, 'notes', 'ollama/fictional:4b', notesOutcomes(check(['S4'])));
    const totals = summarize(await loadQuoteCounts(quoteMetricsPath(directory)));
    assert.equal(totals.total.passed, 1); assert.equal(totals.total.failed, 0);
    assert.equal(totals.rows[0].reasons.passed_after_nearby_line, 1);
    const output = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/quote-metrics.ts', directory], { encoding: 'utf8' });
    assert.match(output, /ollama\/fictional:4b/); assert.match(output, /passed_after_nearby_line/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
