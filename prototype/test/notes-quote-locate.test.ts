import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NotesFile, notesMarkdown, sourcesFor, validateNotes, type NotesRecord, type Snapshot } from '../src/notes.ts';
import { loadQuoteCounts, notesOutcomes, quoteMetricsPath, recordQuoteChecks, summarize } from '../src/quote-metrics.ts';

const quote = 'Keep the painted lanterns on the rack';
const filler = 'The fictional workshop has another empty shelf.';
function snapshot(texts: string[], sources?: string[]): Snapshot {
  return { meetingId: 'fictional', title: 'Lantern workshop', takenAt: 0, glossaryVersion: null, terms: [], inputHash: 'fictional',
    coverage: { untilMs: texts.length * 1000, chunks: texts.length, pendingChunks: 0, gaps: [], uncorrected: 0 },
    segments: texts.map((text, i) => ({ ref: `S${i + 1}`, id: `id${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000,
      revision: 1, text, originalText: text, ...(sources ? { source: sources[i] } : {}) })) };
}
const check = (s: Snapshot, cites = ['S1'], q = quote) => validateNotes({ summary: [{ text: 'Keep the lanterns on the rack.', cites, quote: q }] }, s);
const kept = (result: ReturnType<typeof check>, tier: 'located' | 'spans_lines' | 'elided' | undefined) => {
  assert.equal(result.notes.summary.length, 1); assert.equal(result.notes.needsReview.length, 0);
  assert.equal(result.notes.summary[0].quoteCheck, tier); return result.notes.summary[0];
};
const reviewed = (result: ReturnType<typeof check>, reason = 'quote not found in the cited lines') => {
  assert.equal(result.notes.summary.length, 0); assert.equal(result.notes.needsReview.length, 1);
  assert.equal(result.notes.needsReview[0].reviewReason, reason);
};

test('off-by-two citation locates the quote first, with the earliest cited time', () => {
  const item = kept(check(snapshot([filler, filler, quote])), 'located');
  assert.deepEqual(item.cites, ['id3', 'id1']); assert.equal(item.startMs, 0); assert.equal(item.quoteIn, 'corrected');
});

test('a far-away recap citation locates the original statement', () => {
  const s = snapshot([quote, ...Array(15).fill(filler), 'Recap: the lantern storage decision is settled.']);
  assert.deepEqual(kept(check(s, ['S17']), 'located').cites, ['id1', 'id17']);
});

for (const cites of [['S27-S28'], [], ['S99']]) test(`unique quote survives no valid citation: ${JSON.stringify(cites)}`, () => {
  const result = check(snapshot([filler, quote]), cites);
  assert.deepEqual(kept(result, 'located').cites, ['id2']); assert.deepEqual(result.dropped, []);
});

test('single cited line wins without a tier, even when repeated elsewhere', () => {
  assert.deepEqual(kept(check(snapshot([quote, filler, quote]), ['S3']), undefined).cites, ['id3']);
});

for (const texts of [['Keep the painted lanterns', 'on the rack'], ['Keep the painted', 'lanterns on', 'the rack']]) {
  test(`${texts.length} consecutive cited lines are a span, regardless of cite order`, () => {
    const cites = texts.map((_, i) => `S${i + 1}`).reverse();
    const result = check(snapshot(texts), cites);
    assert.deepEqual(kept(result, 'spans_lines').cites, texts.map((_, i) => `id${texts.length - i}`));
    assert.deepEqual(notesOutcomes(result), ['passed_spans_lines']);
  });
}

test('a located span keeps every located line first and drops only excess model cites', () => {
  const s = snapshot(['Keep the painted', 'lanterns on', 'the rack', ...Array(12).fill(filler)]);
  const item = kept(check(s, Array.from({ length: 12 }, (_, i) => `S${i + 4}`)), 'located');
  assert.deepEqual(item.cites, ['id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7', 'id8']);
});

test('non-consecutive, four-line and cross-source stitching are never accepted', () => {
  reviewed(check(snapshot(['Keep the painted lanterns', filler, 'on the rack']), ['S1', 'S3']));
  reviewed(check(snapshot(['Keep the', 'painted lanterns', 'on the', 'rack']), ['S1', 'S2', 'S3', 'S4']));
  reviewed(check(snapshot(['Keep the painted lanterns', 'on the rack'], ['mic:fictional', 'tab:fictional']), ['S1', 'S2']));
});

test('corrected and original text never mix within a span; an all-original span can locate', () => {
  const s = snapshot(['Keep the painted lanterns', filler]);
  s.segments[0].originalText = filler; s.segments[1].originalText = 'on the rack';
  reviewed(check(s, ['S1', 'S2']));
  s.segments[0].originalText = 'Keep the painted lanterns'; s.segments[0].text = filler;
  assert.equal(kept(check(s, ['S99']), 'located').quoteIn, 'original');
});

test('duplicate locations without a cited occurrence are ambiguous, not duplicated surrounding runs', () => {
  const result = check(snapshot([quote, filler, quote, filler]), ['S4']);
  reviewed(result, 'quote found in several places'); assert.deepEqual(notesOutcomes(result), ['quote_ambiguous']);
  const uncited = check(snapshot([quote, filler, quote]), []);
  assert.deepEqual(uncited.notes.needsReview, []);
  assert.deepEqual(uncited.dropped.map(d => d.reason), ['no valid citation']);
  assert.deepEqual(notesOutcomes(uncited), ['no_citation']);
});

test('exactly one overlapping span disambiguates, but two overlapping spans do not', () => {
  const s = snapshot(['Keep the painted lanterns', 'on the rack', filler, 'Keep the painted lanterns', 'on the rack']);
  assert.deepEqual(kept(check(s, ['S5']), 'located').cites, ['id4', 'id5']);
  reviewed(check(s, ['S2', 'S5']), 'quote found in several places');
});

test('one matching line is one location even when both readings and surrounding runs match', () => {
  assert.deepEqual(kept(check(snapshot([filler, quote, filler])), 'located').cites, ['id2', 'id1']);
});

const elision = 'Keep the painted lanterns … on the wooden rack';
for (const mark of ['…', '...']) test(`ordered elision ${mark} accepts a safe gap in a cited line`, () => {
  const result = check(snapshot(['Keep the painted lanterns after polishing on the wooden rack.']), ['S1'], elision.replace('…', mark));
  kept(result, 'elided'); assert.deepEqual(notesOutcomes(result), ['passed_elided']);
});

test('elisions locate spans and use the same ambiguity and cited-overlap rules', () => {
  const s = snapshot(['Keep the painted lanterns after polishing', 'on the wooden rack', filler,
    'Keep the painted lanterns after drying', 'on the wooden rack', filler]);
  reviewed(check(s, ['S6'], elision), 'quote found in several places');
  assert.deepEqual(kept(check(s, ['S5'], elision), 'elided').cites, ['id4', 'id5']);
  assert.deepEqual(kept(check(snapshot(s.segments.slice(0, 3).map(s => s.text)), ['S99'], elision), 'elided').cites, ['id1', 'id2']);
  reviewed(check(snapshot(s.segments.slice(0, 2).map(s => s.text), ['mic:x', 'tab:x']), ['S1', 'S2'], elision));
});

for (const gap of ['not', 'if', 'never', 'no longer', "can't", 'unless', 'in case', 'provided', 'assuming', 'nobody', 'neither', 'nor', 'without', 'no']) {
  test(`elision cannot hide ${gap}`, () => reviewed(check(snapshot([`Keep the painted lanterns ${gap} on the wooden rack.`]), ['S1'], elision)));
}

for (const gap of ['not,really', 'if,necessary', 'not.really', "can't,actually", 'really.not', 'necessary.if', 'in,case', 'no.longer']) {
  test(`elision cannot hide punctuation-adjacent ${gap}`, () => {
    const s = snapshot([`Keep the painted lanterns ${gap}`, 'on the wooden rack', filler]);
    reviewed(check(s, ['S1', 'S2'], elision));
    reviewed(check(s, ['S3'], elision));
  });
}

for (const cites of [[], ['S27-S28'], ['S99']]) test(`ambiguous quotes without valid cites are dropped: ${JSON.stringify(cites)}`, () => {
  for (const [q, line] of [[quote, quote], [elision, 'Keep the painted lanterns after polishing on the wooden rack']]) {
    const result = check(snapshot([line, filler, line]), cites, q);
    assert.deepEqual(result.notes.summary, []); assert.deepEqual(result.notes.needsReview, []);
    assert.deepEqual(result.dropped.map(d => d.reason), ['no valid citation']);
    assert.deepEqual(notesOutcomes(result), ['no_citation']);
  }
});

test('elision safety uses word boundaries, not negation substrings inside harmless words', () => {
  kept(check(snapshot(['Keep the painted lanterns noteworthy,gift on the wooden rack']), ['S1'], elision), 'elided');
});

test('cited single-line, spanning and elided tiers never scan whole-snapshot runs', () => {
  for (const [texts, cites, q, tier] of [
    [[quote], ['S1'], quote, undefined],
    [['Keep the painted lanterns', 'on the rack'], ['S2', 'S1'], quote, 'spans_lines'],
    [['Keep the painted lanterns after polishing on the wooden rack'], ['S1'], elision, 'elided'],
  ] as const) {
    const s = snapshot([...texts, ...Array(30).fill(filler)]), slice = Array.prototype.slice;
    let scans = 0;
    try {
      Array.prototype.slice = function(start?: number, end?: number) {
        if (this.length === s.segments.length && this[0]?.index === 0) scans++;
        return slice.call(this, start, end);
      };
      kept(check(s, [...cites], q), tier);
    } finally { Array.prototype.slice = slice; }
    assert.equal(scans, 0, 'cited tiers must return before the whole-snapshot search');
  }
});

test('whole-snapshot fallback joins each line reading once, not again per item or run', () => {
  const s = snapshot(Array.from({ length: 30 }, (_, i) => `Fictionalmarker lantern workshop number ${i} has painted wooden shelves`));
  const raw = { summary: Array.from({ length: 10 }, (_, i) => ({ text: `Absent note ${i}.`, cites: ['S1'], quote: 'unseen imaginary zebracorn carries golden globes' })) };
  const join = Array.prototype.join;
  let joins = 0;
  try {
    Array.prototype.join = function(separator?: string) {
      if (this[0] === 'fictionalmarker') joins++;
      return join.call(this, separator);
    };
    assert.equal(validateNotes(raw, s).notes.needsReview.length, 10);
  } finally { Array.prototype.join = join; }
  assert.equal(joins, s.segments.length * 2, 'one cached token string for each corrected/original line');
});

test('elided pieces must be ordered, substantial and within 25 skipped words', () => {
  reviewed(check(snapshot(['On the wooden rack after polishing keep the painted lanterns.']), ['S1'], elision));
  reviewed(check(snapshot(['Keep the painted lanterns on the rack']), ['S1'], 'Keep the painted lanterns … the rack'));
  reviewed(check(snapshot(['Keep the painted lanterns on the wooden rack']), ['S1'], '… Keep the painted lanterns … on the wooden rack'));
  reviewed(check(snapshot([`Keep the painted lanterns ${Array(26).fill('carefully').join(' ')} on the wooden rack`]), ['S1'], elision));
  kept(check(snapshot([`Keep the painted lanterns ${Array(25).fill('carefully').join(' ')} on the wooden rack`]), ['S1'], elision), 'elided');
  reviewed(check(snapshot(['Lanterns shine after polishing wooden racks']), ['S1'], 'Lanterns shine … wooden racks'), 'quote too short to support the item');
  reviewed(check(snapshot([Array(26).fill('painted').join(' ')]), ['S1'], `${Array(13).fill('painted').join(' ')} … ${Array(13).fill('painted').join(' ')}`), 'quote too long');
});

test('ellipsis matching can use a later occurrence when the first ordered path fails', () => {
  const s = snapshot(['Keep the painted lanterns not on the wooden rack. Keep the painted lanterns after polishing on the wooden rack.']);
  kept(check(s, ['S1'], elision), 'elided');
});

test('located owner evidence cannot confirm an owner; original valid cites still can', () => {
  const statement = 'Vela will paint the wooden lanterns tomorrow.';
  const s = snapshot([filler, filler, statement]);
  const run = (cites: string[]) => validateNotes({ actions: [{ text: 'Paint the lanterns.', cites, quote: statement, owner: 'Vela', ownerQuote: statement }] }, s);
  const result = run(['S1']);
  assert.equal(result.notes.actions[0].quoteCheck, 'located'); assert.equal(result.notes.actions[0].owner, null);
  assert.equal(result.notes.actions[0].ownerProposed, 'Vela'); assert.equal(result.dropped.length, 1);
  assert.equal(run(['S3']).notes.actions[0].owner, 'Vela');
});

test('non-project checks use final located cites, including removal of excess model cites', () => {
  const s = snapshot([filler, quote, ...Array(10).fill(filler)]);
  const run = (cites: string[], ref: string) => validateNotes({ summary: [{ text: 'Lantern storage.', cites, quote }], otherTalk: [{ from: ref, to: ref, label: 'admin' }] }, s);
  reviewed(run(['S1'], 'S2'), 'cites non-project talk; it may belong in Other matters');
  kept(run(Array.from({ length: 10 }, (_, i) => `S${i + 3}`), 'S12'), 'located');
});

test('new outcomes persist as passed or ambiguous; old nearby counts and records still load and export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notes-locate-'));
  try {
    const outcomes = [
      ...notesOutcomes(check(snapshot(['Keep the painted lanterns', 'on the rack']), ['S1', 'S2'])),
      ...notesOutcomes(check(snapshot([filler, quote]))),
      ...notesOutcomes(check(snapshot(['Keep the painted lanterns after polishing on the wooden rack']), ['S1'], elision)),
      ...notesOutcomes(check(snapshot([quote, filler, quote]), ['S2'])),
    ];
    assert.deepEqual(outcomes, ['passed_spans_lines', 'passed_quote_located', 'passed_elided', 'quote_ambiguous']);
    await recordQuoteChecks(directory, 'notes', 'fictional/model', [...outcomes, 'passed_after_nearby_line']);
    const summary = summarize(await loadQuoteCounts(quoteMetricsPath(directory)));
    assert.equal(summary.total.passed, 4); assert.equal(summary.total.failed, 1); assert.equal(summary.total.quoteFailed, 1);
    assert.deepEqual(summary.rows[0].reasons, { passed_after_nearby_line: 1, passed_elided: 1, passed_quote_located: 1, passed_spans_lines: 1, quote_ambiguous: 1 });
    const output = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/quote-metrics.ts', directory], { encoding: 'utf8' });
    for (const outcome of outcomes.filter(o => o.startsWith('passed_'))) assert.match(output, new RegExp(outcome));
    const json = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/quote-metrics.ts', directory, '--json'], { encoding: 'utf8' }));
    assert.equal(json.rows[0].reasons.quote_ambiguous, 1);
    const s = snapshot([quote]), result = check(s);
    result.notes.summary[0].quoteCheck = 'passed_after_nearby_line';
    const record: NotesRecord = { version: 1, createdAt: 0, model: 'fictional/model', meetingId: s.meetingId, title: s.title,
      input: { inputHash: s.inputHash, coverage: s.coverage, glossaryVersion: null, segments: 1, takenAt: 0 },
      notes: result.notes, sources: sourcesFor(result.notes, s), dropped: [] };
    const path = join(directory, 'old-notes.json'); await writeFile(path, JSON.stringify(record));
    const loaded = (await new NotesFile(path).load())!;
    assert.equal(loaded.notes.summary[0].quoteCheck, 'passed_after_nearby_line');
    assert.deepEqual(notesOutcomes({ notes: loaded.notes, dropped: loaded.dropped }), ['passed_after_nearby_line']);
    assert.match(notesMarkdown(loaded, false), /Keep the painted lanterns on the rack/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
