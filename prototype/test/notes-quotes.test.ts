import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesFile, notesInstructions, notesMarkdown, sourcesFor, validateNotes, type NotesRecord, type Snapshot } from '../src/notes.ts';
import { loadQuoteCounts, notesOutcomes, OUTCOMES, quoteMetricsPath, recordQuoteChecks, summarize } from '../src/quote-metrics.ts';

const quotes = ['Keep the painted lanterns on the rack.', 'Pack the wooden crates before the parade.', 'Leave the striped banners in the cupboard.'];
const filler = 'The fictional workshop has another empty shelf.';
function snapshot(texts: string[]): Snapshot {
  return { meetingId: 'fictional', title: 'Parade workshop', takenAt: 0, glossaryVersion: null, terms: [], inputHash: 'fictional',
    coverage: { untilMs: texts.length * 1000, chunks: texts.length, pendingChunks: 0, gaps: [], uncorrected: 0 },
    segments: texts.map((text, i) => ({ ref: `S${i + 1}`, id: `id${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000,
      revision: 1, text, originalText: text })) };
}
const distant = () => snapshot(Array.from({ length: 14 }, (_, i) => i === 8 ? quotes[0] : i === 10 ? quotes[1] : i === 13 ? quotes[2] : filler));
const check = (item: Record<string, unknown>, s = distant()) => validateNotes({ summary: [{ text: 'Prepare the parade supplies.', cites: ['S9', 'S11', 'S14'], ...item }] }, s);
function record(s: Snapshot, result: ReturnType<typeof check>): NotesRecord {
  return { version: 1, createdAt: 0, model: 'fictional/model', meetingId: s.meetingId, title: s.title,
    input: { inputHash: s.inputHash, coverage: s.coverage, glossaryVersion: null, segments: s.segments.length, takenAt: 0 },
    notes: result.notes, sources: sourcesFor(result.notes, s), dropped: result.dropped };
}

test('all models are instructed to give quote arrays, with ownerQuote unchanged', () => {
  for (const labelled of [false, true]) {
    const prompt = notesInstructions(labelled);
    assert.match(prompt, /1–3 quotes.*each 5–25 words/);
    assert.match(prompt, /Use more than one quote only when the support is in different places/);
    const schema = JSON.parse(prompt.split('Answer with JSON only:\n')[1]);
    for (const section of ['summary', 'decisions', 'actions', 'openQuestions', 'otherMatters']) {
      assert.deepEqual(schema[section][0].quotes, ['exact words']);
      assert.equal(Object.hasOwn(schema[section][0], 'quote'), false);
    }
    assert.equal(schema.actions[0].ownerQuote, null);
  }
});

test('S9/S11/S14 support passes as separate quotes, never as a distant collage', () => {
  const result = check({ quotes, cites: ['S14', 'S1', 'S11', 'S9'] });
  assert.equal(result.notes.summary.length, 1); assert.deepEqual(result.notes.needsReview, []);
  const item = result.notes.summary[0];
  assert.deepEqual(item.cites, ['id9', 'id11', 'id14', 'id1']); assert.equal(item.startMs, 0);
  assert.equal(item.quote, quotes.join(' … ')); assert.equal(item.quoteCheck, undefined);
  assert.deepEqual(item.quotes, quotes.map((text, i) => ({ text, quoteIn: 'corrected', cites: [`id${[9, 11, 14][i]}`] })));
  assert.deepEqual(notesOutcomes(result), ['passed']);
  assert.equal(check({ quote: quotes.join(' ') }).notes.needsReview.length, 1);
});

test('one missing quote reviews the entire item and names its position', () => {
  const result = check({ quotes: [quotes[0], 'These imaginary glass bowls are entirely absent.', quotes[2]] });
  assert.deepEqual(result.notes.summary, []);
  assert.equal(result.notes.needsReview[0].reviewReason, 'quote 2 of 3 not found in the cited lines');
  assert.deepEqual(result.notes.needsReview[0].quotes![1].cites, []);
  assert.deepEqual(notesOutcomes(result), ['quote_not_found']);
});

test('legacy quote and one-element quotes produce identical records and reasons', () => {
  for (const quote of [quotes[0], '', 'too short', 'This imaginary quotation is entirely absent.']) {
    assert.deepEqual(check({ quote }), check({ quotes: [quote] }));
  }
  const legacy = check({ quote: quotes[0] }).notes.summary[0];
  assert.equal(legacy.quote, quotes[0]); assert.equal(legacy.quoteIn, 'corrected');
  assert.deepEqual(legacy.cites, ['id9', 'id11', 'id14']);
});

test('quotes wins over quote; non-strings are ignored and empty lists still need a quote', () => {
  assert.deepEqual(check({ quotes, quote: 'wrong legacy quote' }), check({ quotes }));
  assert.deepEqual(check({ quotes: [null, 42, `  ${quotes[0]}  `, {}, false] }), check({ quotes: [quotes[0]] }));
  for (const empty of [[], [null, 42], ['  ']]) {
    const result = check({ quotes: empty, quote: quotes[0] });
    assert.equal(result.notes.needsReview[0].reviewReason, 'no quote');
    assert.deepEqual(notesOutcomes(result), ['no_quote']);
  }
});

test('four quotes need review with one quote-kind metric outcome', () => {
  const result = check({ quotes: [...quotes, quotes[0]] });
  assert.equal(result.notes.needsReview[0].reviewReason, 'more than 3 quotes');
  assert.deepEqual(notesOutcomes(result), ['too_many_quotes']); assert.equal(OUTCOMES.too_many_quotes, 'quote');
});

test('a located quote among cited quotes sets the item tier and keeps each quote own cites', () => {
  const item = check({ quotes, cites: ['S9', 'S1', 'S11'] }).notes.summary[0];
  assert.equal(item.quoteCheck, 'located'); assert.equal(item.startMs, 0);
  assert.deepEqual(item.cites, ['id9', 'id11', 'id14', 'id1']);
  assert.deepEqual(item.quotes!.map(q => q.cites), [['id9'], ['id11'], ['id14']]);
  assert.deepEqual(item.quotes!.map(q => q.quoteCheck), [undefined, undefined, 'located']);
});

test('cite cap removes only other model cites, never any of nine quote lines', () => {
  const s = snapshot([
    'Keep the painted', 'lanterns on', 'the rack.',
    'Pack the wooden', 'crates before', 'the parade.',
    'Leave the striped', 'banners in', 'the cupboard.', ...Array(10).fill(filler),
  ]);
  const result = check({ quotes, cites: Array.from({ length: 10 }, (_, i) => `S${i + 10}`) }, s);
  const item = result.notes.summary[0];
  assert.deepEqual(result.notes.needsReview, []);
  assert.deepEqual(item.cites, Array.from({ length: 9 }, (_, i) => `id${i + 1}`));
  assert.deepEqual(item.quotes!.map(q => q.cites), [['id1', 'id2', 'id3'], ['id4', 'id5', 'id6'], ['id7', 'id8', 'id9']]);
  const capped = check({ quotes, cites: Array.from({ length: 10 }, (_, i) => `S${i + 1}`) });
  assert.deepEqual(capped.notes.summary[0].cites, ['id9', 'id11', 'id14', 'id1', 'id2', 'id3', 'id4', 'id5']);
});

test('duplicate quote lines are de-duplicated without losing per-quote evidence', () => {
  const item = check({ quotes: [quotes[2], quotes[0], quotes[2]] }).notes.summary[0];
  assert.deepEqual(item.cites, ['id14', 'id9', 'id11']);
  assert.deepEqual(item.quotes!.map(q => q.cites), [['id14'], ['id9'], ['id14']]);
});

test('each quote has its own word limits and failure metrics retain their single-quote meaning', () => {
  for (const [bad, reason, outcome] of [
    ['', 'has no quote', 'no_quote'],
    ['painted lanterns', 'too short to support the item', 'quote_too_short'],
    [Array(26).fill('lanterns').join(' '), 'too long', 'quote_too_long'],
  ]) {
    const result = check({ quotes: [quotes[0], bad, quotes[2]] });
    assert.equal(result.notes.needsReview[0].reviewReason, `quote 2 of 3 ${reason}`);
    assert.deepEqual(notesOutcomes(result), [outcome]);
  }
  const invalid = check({ quotes: [quotes[0], 'These imaginary bowls are entirely absent.'], cites: ['S9', 'S99'] });
  assert.equal(invalid.notes.needsReview[0].reviewReason, 'quote 2 of 2 not found after an invalid citation was removed');
  assert.deepEqual(notesOutcomes(invalid), ['quote_not_found_after_invalid_citation']);
});

test('ambiguity and no-valid-cite rules apply independently to every quote', () => {
  const s = snapshot([quotes[0], quotes[1], filler, quotes[1]]);
  const reviewed = check({ quotes: quotes.slice(0, 2), cites: ['S1'] }, s);
  assert.equal(reviewed.notes.needsReview[0].reviewReason, 'quote 2 of 2 found in several places');
  assert.deepEqual(notesOutcomes(reviewed), ['quote_ambiguous']);
  const dropped = check({ quotes: quotes.slice(0, 2), cites: [] }, s);
  assert.deepEqual(dropped.notes.summary, []); assert.deepEqual(dropped.notes.needsReview, []);
  assert.deepEqual(dropped.dropped.map(d => d.reason), ['no valid citation']);
  assert.deepEqual(notesOutcomes(dropped), ['no_citation']);
  assert.equal(check({ quotes, cites: [] }).notes.summary[0].quoteCheck, 'located');
});

test('item tier is the least direct tier; joined text retains inserted ellipses', () => {
  const span = 'Keep the painted lanterns on the rack.';
  const elided = 'Pack the wooden crates … before the parade.';
  const joined = 'Leave the striped banners. Store them in the cupboard.';
  const s = snapshot(['Keep the painted', 'lanterns on the rack.', 'Pack the wooden crates after polishing before the parade.',
    'Leave the striped banners. Carefully fold the cloth. Store them in the cupboard.', quotes[1]]);
  const input = [span, elided, joined];
  const result = check({ quotes: input, cites: ['S1', 'S2', 'S3', 'S4'] }, s);
  const item = result.notes.summary[0];
  assert.deepEqual(item.quotes!.map(q => q.quoteCheck), ['spans_lines', 'elided', 'joined']);
  assert.equal(item.quoteCheck, 'joined');
  assert.equal(item.quotes![2].text, 'Leave the striped banners. … Store them in the cupboard.');
  assert.equal(item.quote, item.quotes!.map(q => q.text).join(' … '));
  assert.deepEqual(notesOutcomes(result), ['passed_joined']);
  const located = check({ quotes: [span, elided, quotes[1]], cites: ['S1', 'S2', 'S3'] }, s);
  assert.equal(located.notes.summary[0].quoteCheck, 'located');
  assert.deepEqual(notesOutcomes(located), ['passed_quote_located']);
});

test('non-project check uses final cites while owner check uses only model cites', () => {
  const s = distant();
  const statement = 'Vela will paint the wooden lanterns tomorrow.';
  s.segments[13].text = statement; s.segments[13].originalText = statement;
  const raw = { actions: [{ text: 'Prepare the supplies.', quotes: [quotes[0], statement], cites: ['S9'], owner: 'Vela', ownerQuote: statement }] };
  const action = validateNotes(raw, s).notes.actions[0];
  assert.equal(action.owner, null); assert.equal(action.ownerProposed, 'Vela');
  const result = validateNotes({ ...raw, otherTalk: [{ from: 'S14', to: 'S14', label: 'admin' }] }, s);
  assert.equal(result.notes.needsReview[0].reviewReason, 'cites non-project talk; it may belong in Other matters');
});

test('Markdown keeps one-quote output unchanged and exports three separate blockquote lines', () => {
  const s = distant();
  const single = notesMarkdown(record(s, check({ quote: quotes[0] })), false);
  assert.match(single, /- Prepare the parade supplies\. \[00:08\] \[00:10\] \[00:13\]\n  > Keep the painted lanterns on the rack\.\n/);
  assert.equal(single.split('\n').filter(line => line.startsWith('  > ')).length, 1);
  s.segments[10].text = filler;
  const multi = notesMarkdown(record(s, check({ quotes }, s)), false);
  assert.deepEqual(multi.split('\n').filter(line => line.startsWith('  > ')),
    quotes.map((q, i) => `  > ${q}${i === 1 ? ' (as originally heard)' : ''}`));
});

test('old stored records gain one quote on load without rewriting their file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-quotes-old-'));
  try {
    const s = distant(), old = record(s, check({ quote: quotes[0] }));
    delete old.notes.summary[0].quotes;
    const path = join(directory, 'notes.json'), json = JSON.stringify(old);
    await writeFile(path, json);
    const loaded = (await new NotesFile(path).load())!;
    assert.deepEqual(loaded.notes.summary[0].quotes, [{ text: quotes[0], quoteIn: 'corrected', cites: ['id9', 'id11', 'id14'] }]);
    assert.equal(loaded.notes.summary[0].quote, old.notes.summary[0].quote);
    assert.equal(await readFile(path, 'utf8'), json);
    assert.equal(notesMarkdown(loaded, false), notesMarkdown(old, false));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('metrics persist one outcome per item, including too_many_quotes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-quotes-metrics-'));
  try {
    const outcomes = [...notesOutcomes(check({ quotes })), ...notesOutcomes(check({ quotes: [...quotes, quotes[0]] }))];
    assert.deepEqual(outcomes, ['passed', 'too_many_quotes']);
    await recordQuoteChecks(directory, 'notes', 'fictional/model', outcomes);
    const summary = summarize(await loadQuoteCounts(quoteMetricsPath(directory)));
    assert.equal(summary.total.checked, 2); assert.equal(summary.total.passed, 1);
    assert.equal(summary.total.failed, 1); assert.equal(summary.total.quoteFailed, 1);
    assert.equal(summary.rows[0].reasons.too_many_quotes, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
