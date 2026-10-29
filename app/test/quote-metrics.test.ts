import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { Boards, scanWindow, validateItems } from '../src/board.ts';
import { NotesJobs, takeSnapshot, validateNotes } from '../src/notes.ts';
import { ActionJobs, captureContext, checkAnswer, type ActionRunner } from '../src/actions.ts';
import { checkPlans } from '../src/plans/index.ts';
import { startServer } from '../src/server.ts';
import type { PiAnswer } from '../src/pi-rpc.ts';
import type { PiTaskOptions, PiTaskResult } from '../src/pi-task.ts';
import type { Recognition } from '../src/recognizer.ts';
import type { Material } from '../src/materials.ts';
import {
  OUTCOMES, QUOTE_FEATURES, actionOutcomes, boardOutcomes, isoWeek, loadQuoteCounts, notesOutcomes, plansOutcomes, quoteMetricsPath, recordQuoteChecks,
  type Outcome, type QuoteCounts,
} from '../src/quote-metrics.ts';
import { PINS, fetchResult, fixture as planFixture, rawPlan, readResult } from './plans-fixture.ts';
import { until } from './helpers/until.ts';

// Quote-check counters (counts only): every checked claim counts once, as passed or one fixed reason key. Invented content only.
const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
async function meeting(lines: string[], spacingMs = 5_000, source = 'mic:t') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-')));
  const store = new MeetingStore(directory);
  const m = store.createMeeting('Puppet workshop tidy-up');
  for (const [i, line] of lines.entries()) store.completeChunk((await store.addPcm(m.id, source, i, i * spacingMs, 16000, Buffer.alloc(16000 * 4, i + 1))).id, recognition(line));
  return { directory, store, meeting: m, segments: () => store.visibleSegments(m.id, Date.now()), async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
/** Outcome counts as a multiset, in a stable order. */
const tally = (outcomes: Outcome[]) => Object.fromEntries([...new Set(outcomes)].sort().map(o => [o, outcomes.filter(x => x === o).length]));
/** One feature's counts summed over models and weeks. */
function flat(counts: QuoteCounts, feature: keyof QuoteCounts) {
  const sum: Record<string, number> = {};
  for (const weeks of Object.values(counts[feature] ?? {})) for (const outcomes of Object.values(weeks)) for (const [k, n] of Object.entries(outcomes)) sum[k] = (sum[k] ?? 0) + (n ?? 0);
  return Object.fromEntries(Object.entries(sum).sort());
}
/** The file holds only the allowed keys: features, the given model ids, ISO weeks, outcome keys, and positive integers. */
async function assertOnlyCounts(directory: string, models: string[], forbidden: string[]) {
  const raw = await readFile(quoteMetricsPath(directory), 'utf8');
  for (const word of forbidden) assert.ok(!raw.toLowerCase().includes(word.toLowerCase()), `the metrics file must not contain ${JSON.stringify(word)}`);
  const data = JSON.parse(raw);
  assert.deepEqual(Object.keys(data).sort(), ['counts', 'version']);
  assert.equal(data.version, 1);
  for (const [feature, byModel] of Object.entries(data.counts)) {
    assert.ok((QUOTE_FEATURES as readonly string[]).includes(feature), feature);
    for (const [model, byWeek] of Object.entries(byModel as object)) {
      assert.ok(models.includes(model), `unexpected model key ${model}`);
      for (const [week, outcomes] of Object.entries(byWeek as object)) {
        assert.match(week, /^\d{4}-W\d{2}$/);
        for (const [outcome, n] of Object.entries(outcomes as object)) {
          assert.ok(outcome in OUTCOMES, `unexpected outcome key ${outcome}`);
          assert.ok(Number.isSafeInteger(n) && n > 0, `${outcome}: ${n}`);
        }
      }
    }
  }
}

test('board: every item the scan checks counts once, as passed or its fixed reason', async () => {
  const lines = ['Please do', 'not', 'stack the painted miniatures beside the radiator', 'The spare dice are in the orange pouch',
    'Must the club keep unpainted miniatures away from the snack table during game night?'];
  const f = await meeting(lines);
  try {
    const segs = f.segments();
    const window = scanWindow(segs, { [segs[0].id]: segs[0].revision, [segs[1].id]: segs[1].revision })!;
    const r = (i: number) => window.lines.find(l => l.segment.text === lines[i])!.ref;
    const ok = { type: 'claim', text: 'Miniatures stay away from snacks.', cites: [r(4)], quote: 'Must the club keep unpainted miniatures', confidence: 'high', materials: false, nonProject: false };
    const items = [
      ok,
      { ...ok, type: 'musing' },
      { ...ok, text: 'x'.repeat(301) },
      { ...ok, text: '' },
      { ...ok, confidence: 'very' },
      { ...ok, materials: 'yes' },
      { ...ok, cites: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] },
      { ...ok, cites: [] },
      { ...ok, cites: ['S99'] },
      { ...ok, cites: [r(0)] },
      { ...ok, quote: 'two words' },
      { ...ok, quote: 'Must the club keep zebracorn miniatures' },
      { ...ok, cites: [r(0), r(2)], quote: 'Please do stack the painted miniatures' },
      { ...ok, cites: [r(0), r(1), r(2)], quote: 'Please do not' },
    ];
    const outcomes = boardOutcomes(validateItems({ items }, window, segs));
    assert.equal(outcomes.length, items.length, 'one outcome per checked item');
    assert.deepEqual(tally(outcomes), {
      earlier_lines_only: 1, invalid_citation: 1, malformed: 3, no_citation: 1, no_text: 1, passed: 1, quote_in_earlier_lines: 1, quote_length: 1,
      quote_not_consecutive: 1, quote_not_found: 1, text_too_long: 1, too_many_citations: 1,
    });
    // Past six kept items, the rest of a scan is dropped before it is checked.
    assert.deepEqual(tally(boardOutcomes(validateItems({ items: Array(7).fill(ok) }, window, segs))), { over_limit: 1, passed: 6 });
    await recordQuoteChecks(f.directory, 'board', 'openai-codex/gpt-6-luna', outcomes);
    const counts = await loadQuoteCounts(quoteMetricsPath(f.directory));
    assert.deepEqual(counts.board?.['openai-codex/gpt-6-luna']?.[isoWeek(Date.now())], tally(outcomes));
  } finally { await f.close(); }
});

test('board: a quote joining two channels of an online meeting is its own reason', async () => {
  const MIC = 'mic:00000000-0000-0000-0000-00000000000a', TAB = 'tab:00000000-0000-0000-0000-00000000000b';
  const directory = await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-'));
  const store = new MeetingStore(directory);
  try {
    const m = store.createMeeting('Online meeting');
    const seq = new Map<string, number>();
    for (const [source, startMs, text] of [[MIC, 0, 'The jellyfish tank needs a mesh cover'], [TAB, 500, 'I found the spare clips'], [MIC, 1000, 'before the night feeder starts'], [TAB, 2000, '']] as const) {
      const n = seq.get(source) ?? 0; seq.set(source, n + 1);
      store.completeChunk((await store.addPcm(m.id, source, n, startMs, 16000, Buffer.alloc(16000 * 4, n + 1))).id, recognition(text));
    }
    const segs = store.visibleSegments(m.id, Date.now());
    const window = scanWindow(segs, {}, store.speakers(m.id))!;
    const refOf = (text: string) => window.lines.find(l => l.segment.text.startsWith(text))!.ref;
    const base = { type: 'claim', text: 'x', confidence: 'high', materials: false, nonProject: false };
    const outcomes = boardOutcomes(validateItems({ items: [
      { ...base, text: 'Cover the tank', cites: [refOf('The jellyfish'), refOf('before')], quote: 'a mesh cover before the night feeder starts' },
      { ...base, text: 'cross', cites: [refOf('The jellyfish'), refOf('I found')], quote: 'mesh cover I found the spare clips' },
    ] }, window, segs));
    assert.deepEqual(tally(outcomes), { passed: 1, quote_joins_speakers: 1 });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('notes: kept, Needs review and dropped items each count once; owner notes, ranges and unread entries do not', async () => {
  const f = await meeting(['Keep the striped waistcoats on rail B until the parade ends.', 'Has the lobby fern been watered today by anyone at all?',
    'Tamsin mentioned the spare buckles are in the red tin.']);
  try {
    const snapshot = takeSnapshot(f.store, f.meeting.id, Date.now(), null);
    const good = { cites: ['S1'], quote: 'Keep the striped waistcoats on rail B' };
    const raw = {
      otherTalk: [{ from: 'S2', to: 'S2', label: 'plants' }, { from: 'S9', to: 'S1', label: 'nonsense' }],
      decisions: [
        { ...good, text: 'Waistcoats stay on rail B.' },
        { ...good, text: 'Waistcoats stay on rail B.' },
        { ...good, text: '' },
        { ...good, text: 'x'.repeat(2001) },
        { ...good, text: 'No real citation.', cites: ['S99'], quote: 'Keep the dotted waistcoats on rail B' },
        { text: 'The fern matters.', cites: ['S2'], quote: 'Has the lobby fern been watered' },
        { ...good, text: 'y'.repeat(301) },
        { ...good, text: 'Too many citations.', cites: ['S1', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8'] },
        { text: 'No quote.', cites: ['S1'] },
        { ...good, text: 'Overlong quote.', quote: Array(26).fill('rail').join(' ') },
        { ...good, text: 'Short quote.', quote: 'Keep the striped' },
        { text: 'Invalid citation removed.', cites: ['S1', 'S99'], quote: 'the zebracorn fern has been watered' },
        { text: 'Wrong quote.', cites: ['S1'], quote: 'Keep the plain waistcoats on rail B' },
      ],
      actions: [{ text: 'Find the spare buckles.', cites: ['S3'], quote: 'spare buckles are in the red tin', owner: 'Tamsin', ownerQuote: 'Tamsin mentioned the spare buckles' }],
      summary: Array.from({ length: 9 }, (_, i) => ({ ...good, text: `Summary point ${i + 1}.` })),
      otherMatters: Array.from({ length: 101 }, () => ({})),
    };
    const result = validateNotes(raw, snapshot);
    assert.ok(result.dropped.some(d => d.reason.startsWith('owner not explicitly assigned')), 'the owner note is in the output, not counted');
    const outcomes = notesOutcomes(result);
    assert.deepEqual(tally(outcomes), {
      duplicate: 1, malformed: 1, no_citation: 1, no_quote: 1, no_text: 101, non_project: 1, over_limit: 1, passed: 10, quote_not_found: 1,
      quote_not_found_after_invalid_citation: 1, quote_too_long: 1, quote_too_short: 1, text_too_long: 1, too_many_citations: 1,
    });
    await recordQuoteChecks(f.directory, 'notes', 'openai-codex/gpt-6.1-sol', outcomes);
    assert.deepEqual(flat(await loadQuoteCounts(quoteMetricsPath(f.directory)), 'notes'), tally(outcomes));
    await assertOnlyCounts(f.directory, ['openai-codex/gpt-6.1-sol'], ['zebracorn', 'waistcoats', f.meeting.id]);
  } finally { await f.close(); }
});

test('plans: every state item checked against a line, a file or a page counts once; quick checks do not', async () => {
  const f = await planFixture();
  try {
    await f.evidence.record(readResult(f.file, 5, 20));
    await f.evidence.record(fetchResult('https://example.org/kiln'));
    const t = (ref: string, quote: string) => ({ type: 'transcript', ref, quote });
    const file = (path: string, line: number | null, quote: string) => ({ type: 'file', path, line, quote });
    const web = (url: string, quote: string) => ({ type: 'web', url, quote });
    const lineQuote = 'reopen the kiln room at quarter past two after the latch inspection';
    const state = [
      { id: 'k2', text: 't', source: t('S1', 'is the kiln room reopening before the afternoon') },
      { id: 'k3', text: 't', source: t('S9', 'is the kiln room reopening before the afternoon') },
      { id: 'k4', text: 't', source: t('S1', 'kiln room') },
      { id: 'k5', text: 't', source: t('S1', '') },
      { id: 'k6', text: 't', source: t('S1', Array(26).fill('kiln').join(' ')) },
      { id: 'k7', text: 't', source: t('S1', 'the zebracorn room stays closed all afternoon') },
      { id: 'k8', text: 't', source: file('', 12, lineQuote) },
      { id: 'k9', text: 't', source: file('R9/notes/plan.md', 12, lineQuote) },
      { id: 'k10', text: 't', source: file('R1/notes/plan.md', null, lineQuote) },
      { id: 'k11', text: 't', source: file('R1/notes/other.md', 3, lineQuote) },
      { id: 'k12', text: 't', source: file('R1/notes/plan.md', 12, 'the caretaker collects the used access cards') },
      { id: 'k13', text: 't', source: web('', 'the kiln room door must remain locked') },
      { id: 'k14', text: 't', source: web('https://example.org/unfetched', 'the kiln room door must remain locked') },
      { id: 'k15', text: 't', source: web('https://example.org/kiln', 'the kiln room door must remain locked until') },
      { id: 'k16', text: 't', source: web('https://example.org/kiln', 'the kiln room door may stay open all night') },
      { id: 'k17', text: 't' },
      { id: 'k18', text: 't', source: { type: 'book', quote: lineQuote } },
      { id: 'k19', text: '', source: t('S1', 'is the kiln room reopening before the afternoon') },
      { id: 'kd', text: 't', source: t('S1', 'is the kiln room reopening before the afternoon') },
      { id: 'kd', text: 't', source: t('S1', 'is the kiln room reopening before the afternoon') },
    ];
    const plan = rawPlan();
    const checked = checkPlans({ plans: [{ ...plan, stateNow: [...plan.stateNow, ...state], checks: [{ id: 'c1', run: 1, showed: 'a sum' }] }] },
      { run: 'run1', refs: f.input.refs, evidence: await f.evidence.read(), pins: PINS });
    assert.equal(checked.evidence['run1:c1'].kind, 'check');
    const outcomes = plansOutcomes(checked);
    assert.deepEqual(tally(outcomes), {
      duplicate_id: 1, invalid_citation: 4, no_citation: 3, no_quote: 1, no_text: 1, passed: 3, quote_not_found: 3, quote_too_long: 1, quote_too_short: 1, source_not_read: 2,
    });
    await recordQuoteChecks(f.folder, 'plans', 'openai-codex/gpt-6.1-sol', outcomes);
    assert.deepEqual(flat(await loadQuoteCounts(quoteMetricsPath(f.folder)), 'plans'), tally(outcomes));
  } finally { await f.close(); }
});

test('plans: reasons that need a PDF or several roots map to fixed keys without their details', () => {
  const entry = (reason: string) => ({ evidence: { 'r:k1': { kind: 'state', result: { ok: false, reason } } } }) as never;
  const cases: [string, Outcome][] = [
    ['no page lines were recorded for this PDF\'s text, so its quotes are not counted', 'pdf_lines_missing'],
    ['quote not found within 5 lines of line 3 in what was read (the saved text was cut)', 'quote_not_found'],
    ['quote not found in the fetched page (the saved text was cut)', 'quote_not_found'],
    ['the path is in R2, not R1', 'invalid_citation'], ['the citation names both R1 and R2', 'invalid_citation'], ['unknown material root', 'invalid_citation'],
    ['k7 is defined more than once', 'duplicate_id'], ['a reason nobody has written yet', 'other'],
  ];
  for (const [reason, key] of cases) assert.deepEqual(plansOutcomes(entry(reason)), [key], reason);
});

test('actions: every cited source of an answer counts once, by its check status and detail', async () => {
  const f = await meeting(['How many brass buttons are in the costume cupboard?', 'Count the jackets on rail C before lunch.'], 60_000);
  try {
    const materials = join(f.directory, 'materials');
    await mkdir(join(materials, 'inventory'), { recursive: true });
    await writeFile(join(materials, 'inventory', 'stock.txt'), ['Costume cupboard stock sheet', 'Rail C holds the blue parade jackets.',
      'Brass buttons: 7 packets of 8 = 56 buttons, counted on Thursday.', 'Spare thread is stored in the green tin.'].join('\n'));
    await writeFile(join(f.directory, 'outside.txt'), 'words outside the materials root');
    const roots: Material[] = [{ id: 'R1', scope: `meeting:${f.meeting.id}`, path: materials, kind: 'folder', label: 'materials' }];
    const [s0, s1] = f.store.segments(f.meeting.id);
    const lines = captureContext(f.store, f.meeting.id, { text: 'rail C', segmentIds: [s1.id] }, Date.now(), null, roots).lines;
    assert.ok(lines.some(l => l.id === s0.id));
    const evidence = { pages: {
      'https://example.org/fetched': { text: 'The wardrobe lists fifty six brass buttons in seven packets.' },
      'https://example.org/failed': { failed: true },
      'https://example.org/snippet': { snippets: 'Search result: seven packets of eight brass buttons were counted' },
      'https://example.org/search-only': { snippets: 'An unrelated snippet about lobby ferns' },
    } };
    const fileSource = (id: number, path: string, lines: string, quote: string) => ({ id, type: 'file', rootId: 'R1', path, lines, quote });
    const webSource = (id: number, url: string, quote: string) => ({ id, type: 'web', url, quote });
    const sources = [
      fileSource(1, 'inventory/stock.txt', '3', '7 packets of 8 = 56 buttons'),
      fileSource(2, 'inventory/stock.txt', '3', 'nine zebracorn packets of brass buttons were counted'),
      fileSource(3, 'inventory/stock.txt', '3', 'ab cd'),
      fileSource(4, '../outside.txt', '1', 'words outside the materials root'),
      fileSource(5, 'inventory/missing.txt', '1', 'words that are nowhere at all'),
      fileSource(6, 'inventory', '1', 'words that are nowhere at all'),
      fileSource(7, 'inventory/stock.txt', 'abc', '7 packets of 8 = 56 buttons'),
      fileSource(8, 'inventory/stock.txt', '99', '7 packets of 8 = 56 buttons'),
      fileSource(9, 'inventory/stock.txt', '1,1,1,1,1,1,1,1,1', '7 packets of 8 = 56 buttons'),
      webSource(10, 'not a web address', 'seven packets of eight'),
      webSource(11, 'https://example.org/unseen', 'seven packets of eight'),
      webSource(12, 'https://example.org/fetched', 'fifty six brass buttons in seven packets'),
      webSource(13, 'https://example.org/fetched', 'eighty brass buttons in nine packets'),
      webSource(14, 'https://example.org/failed', 'seven packets of eight'),
      webSource(15, 'https://example.org/snippet', 'seven packets of eight brass buttons'),
      webSource(16, 'https://example.org/search-only', 'seven packets of eight brass buttons'),
      { id: 17, type: 'transcript', time: '01:00', quote: 'Count the jackets on rail C' },
      { id: 18, type: 'transcript', time: '01:00', quote: 'Count the zebracorn coats on rail D' },
      { id: 19, type: 'transcript', time: '01:00', quote: 'ab' },
      fileSource(20, 'inventory/stock.txt', '3', ''),
      { id: 21, type: 'book', quote: 'seven packets of eight' },
      webSource(30, 'https://example.org/fetched', 'fifty six brass buttons'),
      webSource(30, 'https://example.org/fetched', 'fifty six brass buttons'),
      'not an object',
    ];
    const answer = `There are 56 buttons [1].\n<<<META\n${JSON.stringify({ sources, assumptions: [], openPoints: [] })}\nMETA>>>`;
    const checked = await checkAnswer(answer, roots, evidence, lines);
    const directory = checked.checks.find(c => c.id === 6)!;
    assert.deepEqual({ status: directory.status, detail: directory.detail }, { status: 'invalid', detail: 'not a file' }, 'a stable directory citation is not a changed-file race');
    const outcomes = actionOutcomes(checked.checks);
    assert.equal(outcomes.length, sources.length);
    assert.deepEqual(tally(outcomes), {
      invalid_citation: 5, malformed: 4, no_quote: 1, passed: 3, quote_in_search_snippet: 1, quote_not_found: 3, quote_too_short: 2, source_not_found: 2,
      source_not_read: 2, source_unreadable: 1,
    });
    assert.deepEqual(actionOutcomes((await checkAnswer('No metadata at all.', roots, evidence, lines)).checks), [], 'an answer without sources checks nothing');
  } finally { await f.close(); }
});

test('actions: file problems that need special set-ups map to fixed keys', () => {
  const check = (status: string, detail?: string) => ({ id: 1, type: 'file', label: 'x', status, detail }) as never;
  const cases: [string, string | undefined, Outcome][] = [
    ['invalid', 'unknown material root', 'invalid_citation'],
    ['invalid', 'live project-memory files are not a source; the memory snapshot is', 'invalid_citation'],
    ['invalid', 'range too broad (512 lines; cite at most 400)', 'invalid_citation'],
    ['invalid', 'no text from this PDF: it has no text layer', 'source_unreadable'],
    ['invalid', 'file not readable', 'source_unreadable'],
    ['invalid', 'malformed source: no quote', 'no_quote'],
    ['invalid', 'malformed source: duplicate id 4', 'malformed'],
    ['quote found', 'matched the text as originally heard', 'passed'],
    ['quote not found', 'not in the transcript lines given to the action', 'quote_not_found'],
    ['fetch failed', undefined, 'source_unreadable'],
    ['invalid', 'something new', 'other'],
  ];
  for (const [status, detail, key] of cases) assert.deepEqual(actionOutcomes([check(status, detail)]), [key], `${status}: ${detail}`);
});

test('the board, notes and actions record after their checks, under the answering model, with counts only', async () => {
  const lines = ['Must the club keep unpainted miniatures away from the snack table during game night?', 'Put the wooden tokens in the blue cabinet and leave the card sleeves on the trolley.'];
  const f = await meeting(lines, 30_000);
  try {
    // Board: one card kept, one dropped; a failed scan counts nothing.
    const window = scanWindow(f.segments(), {})!;
    const item = { type: 'claim', text: 'Miniatures stay away from snacks.', cites: [window.lines[0].ref], quote: 'Must the club keep unpainted miniatures', confidence: 'medium', materials: false, nonProject: false };
    const replies: PiAnswer[] = [
      { text: JSON.stringify({ items: [item, { ...item, text: 'Zebracorn tokens.', quote: 'Must the club keep zebracorn tokens' }] }), ms: 1, attempts: 1, stopReason: 'stop', aborted: false, usages: [], provider: 'openai-codex', model: 'gpt-6-luna' },
    ];
    const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, actions: null, glossaryFor: async () => null, hasMaterials: () => false, ask: async () => replies.shift()! });
    await boards.requestScan(f.meeting.id);
    assert.equal((await boards.status(f.meeting.id)).cards.length, 1);
    await boards.close();

    // Notes: the three parts' merged answer, checked once.
    const notesAnswer = JSON.stringify({ title: 'Tidy-up', summary: [{ text: 'Snacks stay apart.', cites: ['S1'], quote: 'Must the club keep unpainted miniatures away' },
      { text: 'Zebracorn cabinet.', cites: ['S2'], quote: 'Put the zebracorn tokens in the red cabinet' }], openQuestions: [], decisions: [], actions: [], otherMatters: [], otherTalk: [] });
    const notes = new NotesJobs({ store: f.store, directory: f.directory, clock: Date.now, glossaryFor: async () => null,
      runner: async () => ({ text: notesAnswer, provider: 'openai-codex', model: 'gpt-6.1-sol' }) });
    await notes.start(f.meeting.id);
    await until(() => !notes.busy(f.meeting.id));
    assert.equal((await notes.status(f.meeting.id)).notes?.notes.needsReview.length, 1);

    // Actions: one source found, one never seen.
    const segs = f.store.segments(f.meeting.id);
    const actionText = `Keep them apart [1] [2].\n<<<META\n${JSON.stringify({ sources: [{ id: 1, type: 'transcript', time: '00:00', quote: 'Must the club keep unpainted miniatures' },
      { id: 2, type: 'web', url: 'https://example.org/zebracorn', quote: 'zebracorn tokens belong in the red cabinet' }] })}\nMETA>>>`;
    const runner: ActionRunner = async () => ({ text: actionText, ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [], provider: 'openai-codex', model: 'gpt-6.1-sol' });
    const actions = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [] });
    const { job } = await actions.submit(f.meeting.id, { action: 'explain', selection: { text: 'miniatures', segmentIds: [segs[0].id] } });
    await until(() => actions.get(job.id)!.state === 'done');
    await actions.close();

    const counts = await loadQuoteCounts(quoteMetricsPath(f.directory));
    assert.deepEqual(Object.keys(counts.board ?? {}), ['openai-codex/gpt-6-luna']);
    assert.deepEqual(flat(counts, 'board'), { passed: 1, quote_not_found: 1 });
    assert.deepEqual(Object.keys(counts.notes ?? {}), ['openai-codex/gpt-6.1-sol']);
    assert.deepEqual(flat(counts, 'notes'), { passed: 1, quote_not_found: 1 });
    assert.deepEqual(flat(counts, 'actions'), { passed: 1, source_not_read: 1 });
    await assertOnlyCounts(f.directory, ['openai-codex/gpt-6-luna', 'openai-codex/gpt-6.1-sol'], ['zebracorn', 'miniatures', 'cabinet', f.meeting.id, f.directory]);
  } finally { await f.close(); }
});

test('plans record their checks under the plan model when a run is checked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-plans-'));
  const materials = await realpath(await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-mat-')));
  const LINES = ['The carpet cleaners arrive at noon, so where can the library robot dock?', 'Oriel will bag the worn caster and leave it on the repair bench.'];
  const MATERIAL = Array.from({ length: 30 }, (_, i) => `Maintenance ledger entry ${i + 1}: a cupboard was checked and its key returned.`);
  MATERIAL[11] = 'Park the library robot in the tiled returns alcove until the carpet is dry.';
  await writeFile(join(materials, 'plan.md'), MATERIAL.join('\n'));
  let id: string;
  {
    const store = new MeetingStore(directory);
    const m = store.createMeeting('Library robot service window');
    id = m.id;
    for (const [i, line] of LINES.entries()) store.completeChunk((await store.addPcm(m.id, 'mic:t', i, i * 30_000, 16000, Buffer.alloc(16000 * 4, i + 1))).id, recognition(line));
    store.close();
  }
  const NOTES = JSON.stringify({ title: 'Robot', summary: [], decisions: [], actions: [], otherMatters: [], otherTalk: [],
    openQuestions: [{ text: 'Where should the robot dock during carpet cleaning?', cites: ['S1'], quote: 'where can the library robot dock' }] });
  const answer = { plans: [{ label: 'Robot dock', answerLine: 'The tiled alcove', stepLine: 'Mark a square', question: 'Where should the robot dock?', from: ['N1'],
    stateNow: [
      { id: 'k1', text: 'The ledger names the alcove', source: { type: 'file', path: 'R1/plan.md', line: 12, quote: 'park the library robot in the tiled returns alcove until the carpet is dry' } },
      { id: 'k2', text: 'Zebracorn', source: { type: 'transcript', ref: 'S1', quote: 'the zebracorn cleaners arrive at dawn today' } },
    ],
    answer: { text: 'In the tiled alcove', complete: true, open: null, basis: ['k1'] }, next: { text: 'Mark a docking square', basis: ['k1'] },
    followOn: [], changeIf: null, checks: [], waitingOn: [], decideAfter: [], further: null }], deferred: [] };
  const plans = async (_prompt: string, options: PiTaskOptions): Promise<PiTaskResult> => {
    const file = join(materials, 'plan.md');
    options.onEvent?.({ type: 'tool_execution_start', toolCallId: 'c-1', toolName: 'read', args: { path: file, offset: 1, limit: 30 } });
    options.onEvent?.({ type: 'tool_execution_end', toolCallId: 'c-1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: MATERIAL.join('\n') }] } });
    const result: PiTaskResult = { text: JSON.stringify(answer), ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 2, toolResults: [] };
    await mkdir(options.sessionDir!, { recursive: true });
    await writeFile(join(options.sessionDir!, 'fake.jsonl'), JSON.stringify(result));
    return result;
  };
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'cloud', cloudConsent: { providers: ['example'], time: 1 } }));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null,
    ai: { env: { ...process.env, MEETING_HEAVY_MODEL: 'example/main' } }, notes: async () => ({ text: NOTES, model: 'scripted' }), plans });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json() as any };
    };
    assert.ok((await call('/api/projects', 'POST', { name: 'Library robot', repoPath: null, fromMeetingId: id })).status < 300);
    assert.equal((await call(`/api/meetings/${id}/materials`, 'POST', { path: materials, scope: 'project' })).status, 201);
    assert.equal((await call(`/api/meetings/${id}/notes`, 'POST', {})).status, 202);
    await until(async () => Boolean((await call(`/api/meetings/${id}/notes`)).body.notes));
    const started = await call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: `op-quote-metrics-${Date.now()}` });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(() => app.explorations.get(started.body.run.id)?.state === 'done');
    const counts = await loadQuoteCounts(quoteMetricsPath(directory));
    assert.deepEqual(Object.keys(counts.plans ?? {}), ['example/main']);
    assert.deepEqual(flat(counts, 'plans'), { passed: 1, quote_not_found: 1 });
    assert.deepEqual(Object.keys(counts.notes ?? {}), ['scripted']);
    assert.deepEqual(flat(counts, 'notes'), { passed: 1 });
    await assertOnlyCounts(directory, ['example/main', 'scripted'], ['zebracorn', 'alcove', id, materials]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); await rm(materials, { recursive: true, force: true }); }
});

test('the counter file: missing or corrupt starts fresh, foreign keys are dropped, updates are serialized, failures never throw', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-file-'));
  const path = quoteMetricsPath(directory);
  try {
    assert.deepEqual(await loadQuoteCounts(path), {}, 'missing');
    await recordQuoteChecks(directory, 'board', 'm/one', ['passed', 'quote_not_found'], Date.UTC(2026, 9, 26));
    assert.deepEqual(await loadQuoteCounts(path), { board: { 'm/one': { '2026-W44': { passed: 1, quote_not_found: 1 } } } });
    assert.equal(((await stat(path)).mode & 0o777).toString(8), '600');

    await writeFile(path, '{"version":1,"counts":{"board":');
    assert.deepEqual(await loadQuoteCounts(path), {}, 'corrupt');
    await recordQuoteChecks(directory, 'board', 'm/one', ['passed'], Date.UTC(2026, 9, 26));
    assert.deepEqual(await loadQuoteCounts(path), { board: { 'm/one': { '2026-W44': { passed: 1 } } } });

    await writeFile(path, JSON.stringify({ version: 1, counts: {
      board: { 'm/one': { '2026-W44': { passed: 2, 'Keep the zebracorn on rail B': 5, quote_not_found: -1, no_text: 1.5 }, 'Tuesday': { passed: 1 } }, 'not a model id!': { '2026-W44': { passed: 1 } } },
      'meeting-123': { 'm/one': { '2026-W44': { passed: 1 } } },
    }, extra: 'secret' }));
    assert.deepEqual(await loadQuoteCounts(path), { board: { 'm/one': { '2026-W44': { passed: 2 } } } });
    await recordQuoteChecks(directory, 'notes', 'm/one', [], Date.UTC(2026, 9, 26));
    assert.ok(!(await readFile(path, 'utf8')).includes('zebracorn'), 'a rewrite keeps only the allowed keys');

    // Concurrent records: no lost increments.
    await rm(path);
    await Promise.all(Array.from({ length: 40 }, (_, i) => recordQuoteChecks(directory, i % 2 ? 'notes' : 'plans', 'm/one', ['passed', 'no_quote'], Date.UTC(2026, 9, 26))));
    const counts = await loadQuoteCounts(path);
    assert.deepEqual([counts.notes?.['m/one']?.['2026-W44'], counts.plans?.['m/one']?.['2026-W44']], [{ no_quote: 20, passed: 20 }, { no_quote: 20, passed: 20 }]);

    // Unknown or odd model ids are not stored as given; models and weeks are bounded.
    await recordQuoteChecks(directory, 'board', 'Notes about Tamsin', ['passed'], Date.UTC(2026, 9, 26));
    await recordQuoteChecks(directory, 'board', null, ['passed'], Date.UTC(2026, 9, 26));
    assert.equal((await loadQuoteCounts(path)).board?.unknown?.['2026-W44']?.passed, 2);
    for (let i = 0; i < 30; i++) await recordQuoteChecks(directory, 'actions', `p/model-${i}`, ['passed'], Date.UTC(2026, 9, 26));
    const models = Object.keys((await loadQuoteCounts(path)).actions ?? {});
    assert.equal(models.length, 21);
    assert.equal((await loadQuoteCounts(path)).actions?.other?.['2026-W44']?.passed, 10, 'models past the limit count together');
    for (let w = 0; w < 170; w++) await recordQuoteChecks(directory, 'plans', 'm/weeks', ['passed'], Date.UTC(2020, 0, 6) + w * 7 * 86_400_000);
    const weeks = Object.keys((await loadQuoteCounts(path)).plans?.['m/weeks'] ?? {}).sort();
    assert.equal(weeks.length, 160);
    assert.equal(weeks.at(-1), isoWeek(Date.UTC(2020, 0, 6) + 169 * 7 * 86_400_000), 'the newest weeks are kept');

    // A data folder that cannot hold the file: the feature is never affected.
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, 'a file, not a folder');
    await recordQuoteChecks(blocked, 'board', 'm/one', ['passed']);
    await recordQuoteChecks(directory, 'board', 'm/one', ['not a key' as Outcome]);
    assert.equal(isoWeek(Date.UTC(2021, 0, 3)), '2020-W53');
    assert.equal(isoWeek(Date.UTC(2026, 0, 1)), '2026-W01');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the report script prints a table per feature and model, or JSON, and never writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-quote-metrics-script-'));
  try {
    const at = Date.UTC(2026, 9, 26);
    await recordQuoteChecks(directory, 'board', 'openai-codex/gpt-6-luna', [...Array(6).fill('passed'), 'quote_not_found', 'quote_not_found', 'malformed', 'over_limit'], at);
    await recordQuoteChecks(directory, 'notes', 'openai-codex/gpt-6.1-sol', [...Array(3).fill('passed'), 'quote_too_short'], at);
    await recordQuoteChecks(directory, 'notes', 'openai-codex/gpt-6.1-sol', ['passed'], at - 7 * 86_400_000);
    const path = quoteMetricsPath(directory);
    const before = await readFile(path, 'utf8'), mtime = (await stat(path)).mtimeMs;
    const run = (...args: string[]) => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/quote-metrics.ts', ...args], { encoding: 'utf8', env: { ...process.env, MEETING_DATA_DIR: directory } });
    const table = run();
    assert.match(table, /^board\s+openai-codex\/gpt-6-luna\s+10\s+40\.0%\s+20\.0%\s+quote_not_found 2, malformed 1, over_limit 1$/m);
    assert.match(table, /^notes\s+openai-codex\/gpt-6\.1-sol\s+5\s+20\.0%\s+20\.0%\s+quote_too_short 1$/m);
    assert.match(table, /^all\s+all models\s+15\s+33\.3%\s+20\.0%/m);
    assert.equal(run(path), table, 'a file path argument');
    assert.equal(run(directory), table, 'a data folder argument');
    const json = JSON.parse(run('--json'));
    assert.deepEqual(json.rows.map((r: any) => [r.feature, r.model, r.checked, r.passed, r.failed]), [['board', 'openai-codex/gpt-6-luna', 10, 6, 4], ['notes', 'openai-codex/gpt-6.1-sol', 5, 4, 1]]);
    assert.deepEqual(json.rows[0].reasons, { malformed: 1, over_limit: 1, quote_not_found: 2 });
    assert.deepEqual(json.total, { feature: 'all', model: 'all models', checked: 15, passed: 10, failed: 5, quoteFailed: 3, reasons: { malformed: 1, over_limit: 1, quote_not_found: 2, quote_too_short: 1 } });
    assert.deepEqual(Object.keys(json.weeks), ['2026-W43', '2026-W44']);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal((await stat(path)).mtimeMs, mtime);
    assert.match(run(join(directory, 'nowhere')), /No quote checks recorded yet/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
