import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesFile, notesMarkdown, sourcesFor, validateNotes, type Snapshot } from '../src/notes.ts';
import { loadQuoteCounts, notesOutcomes, quoteMetricsPath, recordQuoteChecks, summarize } from '../src/quote-metrics.ts';

const first = 'Thirty-eight percent of them never finished onboarding.';
const last = 'Mostly at the availability step.';
const quote = `${first} ${last}`;
const safe = 'The fictional workshop has another empty shelf.';
function snapshot(texts: string[], sources?: string[]): Snapshot {
  return { meetingId: 'fictional', title: 'Lantern workshop', takenAt: 0, glossaryVersion: null, terms: [], inputHash: 'fictional',
    coverage: { untilMs: texts.length * 1000, chunks: texts.length, pendingChunks: 0, gaps: [], uncorrected: 0 },
    segments: texts.map((text, i) => ({ ref: `S${i + 1}`, id: `id${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000,
      revision: 1, text, originalText: text, ...(sources ? { source: sources[i] } : {}) })) };
}
const check = (s: Snapshot, cites = ['S1'], q = quote) => validateNotes({ summary: [{ text: 'Onboarding was left unfinished.', cites, quote: q }] }, s);
const joined = (result: ReturnType<typeof check>, expected: string) => {
  assert.equal(result.notes.summary.length, 1); assert.deepEqual(result.notes.needsReview, []);
  assert.equal(result.notes.summary[0].quoteCheck, 'joined'); assert.equal(result.notes.summary[0].quote, expected);
  assert.deepEqual(notesOutcomes(result), ['passed_joined']); return result.notes.summary[0];
};
const rejected = (result: ReturnType<typeof check>) => {
  assert.deepEqual(result.notes.summary, []); assert.equal(result.notes.needsReview.length, 1);
};

test('joined whole sentences locate S9/S11 and visibly mark the skipped S10', () => {
  const s = snapshot([...Array(8).fill(safe), first, safe, last]);
  const item = joined(check(s, ['S9', 'S11']), `${first} … ${last}`);
  assert.deepEqual(item.cites, ['id9', 'id10', 'id11']); assert.equal(item.quoteIn, 'corrected');
  assert.deepEqual(joined(check(s, ['S1']), `${first} … ${last}`).cites, ['id9', 'id10', 'id11', 'id1']);
  assert.deepEqual(joined(check(s, ['S99']), `${first} … ${last}`).cites, ['id9', 'id10', 'id11']);
});

test('adjacent sentences retain the existing span tier without an ellipsis', () => {
  const result = check(snapshot([first, last]), ['S1', 'S2']);
  assert.equal(result.notes.summary[0].quoteCheck, 'spans_lines'); assert.equal(result.notes.summary[0].quote, quote);
  assert.deepEqual(notesOutcomes(result), ['passed_spans_lines']);
});

test('joined fallback inserts ellipses only at non-empty gaps, including adjacent S9/S10', () => {
  const third = 'The painted lanterns stay upstairs.';
  const s = snapshot([...Array(8).fill(safe), first, last, `${safe} ${third}`]);
  joined(check(s, ['S9', 'S10', 'S11'], `${quote} ${third}`), `${quote} … ${third}`);
  joined(check(snapshot([`${first} ${safe} ${last} ${third}`]), ['S1'], `${quote} ${third}`), `${first} … ${last} ${third}`);
});

for (const gap of ['not', 'no', 'if', 'not,really', 'no.longer', 'if,necessary', "can't,actually"]) {
  test(`joined sentences cannot skip ${gap}`, () => {
    const s = snapshot([first, gap, last, safe]);
    rejected(check(s, ['S1', 'S3'])); rejected(check(s, ['S4']));
  });
}

test('joined sentences require ordered same-source runs of at most three lines', () => {
  rejected(check(snapshot([last, safe, first]), ['S1', 'S3']));
  rejected(check(snapshot([first, safe, last], ['mic:x', 'tab:x', 'mic:x']), ['S1', 'S3']));
  rejected(check(snapshot([first, safe, safe, last]), ['S1', 'S4']));
  rejected(check(snapshot([first, Array(26).fill('carefully').join(' '), last]), ['S1', 'S3']));
  joined(check(snapshot([first, Array(25).fill('carefully').join(' '), last])), `${first} … ${last}`);
});

test('joined sentences must each contain two words and ten characters', () => {
  for (const short of ['It is.', 'Onboarding.']) {
    rejected(check(snapshot([first, safe, short]), ['S1', 'S3'], `${first} ${short}`));
  }
});

test('decimal numbers are not split; question and exclamation sentence ends are supported', () => {
  const decimal = 'We measured 7.25 percent.';
  joined(check(snapshot([decimal, safe, last]), ['S1', 'S3'], `${decimal} ${last}`), `${decimal} … ${last}`);
  for (const mark of ['?', '!']) {
    const sentence = `Are the painted lanterns upstairs${mark}`;
    joined(check(snapshot([sentence, safe, last]), ['S1', 'S3'], `${sentence} ${last}`), `${sentence} … ${last}`);
  }
});

test('explicit elisions never enter the joined tier', () => {
  for (const mark of ['…', '...']) {
    const q = `${first} ${mark} ${last}`, result = check(snapshot([first, safe, last]), ['S1', 'S3'], q);
    assert.equal(result.notes.summary[0].quoteCheck, 'elided'); assert.equal(result.notes.summary[0].quote, q);
    assert.deepEqual(notesOutcomes(result), ['passed_elided']);
  }
});

test('joined fallback uses original readings without mixing corrected and original', () => {
  const s = snapshot([first, safe, safe]); s.segments[2].originalText = last;
  assert.equal(joined(check(s), `${first} … ${last}`).quoteIn, 'original');
  s.segments[0].originalText = safe;
  rejected(check(s));
});

test('joined fallback retains ambiguity and cited-overlap rules', () => {
  const s = snapshot([first, safe, last, safe, first, safe, last, safe]);
  const result = check(s, ['S8']);
  rejected(result); assert.deepEqual(notesOutcomes(result), ['quote_ambiguous']);
  assert.deepEqual(joined(check(s, ['S7']), `${first} … ${last}`).cites, ['id5', 'id6', 'id7']);
  const uncited = check(s, []);
  assert.deepEqual(uncited.notes.needsReview, []); assert.deepEqual(notesOutcomes(uncited), ['no_citation']);
});

test('joined rendering can follow a later safe occurrence rather than an unsafe first path', () => {
  const s = snapshot([`${first} not ${last} ${first} after polishing ${last}`]);
  joined(check(s), `${first} … ${last}`);
});

test('joined outcomes persist as passed and the stored/exported quote exposes skipped text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-joined-'));
  try {
    const s = snapshot([first, safe, last]), result = check(s);
    joined(result, `${first} … ${last}`);
    await recordQuoteChecks(directory, 'notes', 'fictional/model', notesOutcomes(result));
    const summary = summarize(await loadQuoteCounts(quoteMetricsPath(directory)));
    assert.equal(summary.total.passed, 1); assert.equal(summary.total.failed, 0);
    assert.deepEqual(summary.rows[0].reasons, { passed_joined: 1 });
    const file = new NotesFile(join(directory, 'notes.json'));
    await file.save({ createdAt: 0, model: 'fictional/model', meetingId: s.meetingId, title: s.title,
      input: { inputHash: s.inputHash, coverage: s.coverage, glossaryVersion: null, segments: 3, takenAt: 0 },
      notes: result.notes, sources: sourcesFor(result.notes, s), dropped: [] });
    const loaded = (await file.load())!;
    assert.equal(loaded.notes.summary[0].quoteCheck, 'joined');
    assert.ok(notesMarkdown(loaded, false).includes(`${first} … ${last}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
