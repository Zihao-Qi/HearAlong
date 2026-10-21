import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatText } from '../src/pdf-text.ts';
import type { Item } from '../src/memory.ts';
import {
  EvidenceRecorder, INPUT_LIMIT, PLAN_PROMPT, TOO_LONG, buildPlanInput, checkPlans, loadRunPlans, materialLocator, planRoots, planRows, plansDocument, saveRunPlans, type CheckContext, type PublishedVersion,
} from '../src/plans/index.ts';
import { LINES, LINE_TEXT, PAGE_TEXT, PINS, fetchResult, fixture, note, notes, pythonResult, rawPlan, readResult, tool, type Fixture } from './plans-fixture.ts';

// The plan domain (M7b §2b): the frozen prompt, the input, the evidence a run keeps, and the checks on its answer. No model.
const check = async (f: Fixture, raw: unknown, extra: Partial<CheckContext> = {}) =>
  checkPlans(raw, { run: 'run1', refs: f.input.refs, evidence: await f.evidence.read(), pins: PINS, ...extra });
const withRead = async (f: Fixture, offset = 5, limit = 20) => { await f.evidence.record(readResult(f.file, offset, limit)); return f; };

test('the prompt is v1.7 byte for byte, and public plan jobs use the shared prompt and input builder', async () => {
  assert.equal(createHash('sha256').update(PLAN_PROMPT).digest('hex'), 'b4baf906a8235dcc1cd64ff4b9809dc247d775701b2758aac350e34dae3e4931');
  assert.equal(Buffer.byteLength(PLAN_PROMPT), 7441);
  const jobs = await readFile(new URL('../src/plans/jobs.ts', import.meta.url), 'utf8');
  assert.match(jobs, /import \{ EXPLORE_PROMPT, PLAN_PROMPT \} from '\.\/prompt\.ts';/);
  assert.match(jobs, /ctx\.pi\(kind === 'plan' \? PLAN_PROMPT : EXPLORE_PROMPT,/);
  assert.match(jobs, /buildPlanInput\(\{ notes, title: o\.store\.meeting\(meetingId\)\.title, roots, pdfs,/);
  assert.doesNotMatch(jobs, /'You help a researcher/, 'jobs must import rather than copy the frozen prompt');
});

test('the input numbers the notes and their cited lines, gives roots short ids, and names only verified owners', async () => {
  const record = notes({ actions: [note('actions', 'Photograph the cracked shelf before the caretaker arrives', ['seg3'], 'Vesper'), { ...note('actions', 'Label the coat hooks', ['seg1']), ownerProposed: 'Oriel' }] });
  const roots = planRoots([{ id: 'uuid-1', scope: 'project:p', path: '/m/a', kind: 'folder', label: 'a' }, { id: 'uuid-2', scope: 'meeting:m', path: '/m/b.md', kind: 'file', label: 'b.md' }]);
  const input = buildPlanInput({ notes: record, roots });
  assert.ok(!('refused' in input));
  assert.deepEqual(input.refs.notes.map(n => [n.ref, n.section, n.owner]), [['N1', 'openQuestions', null], ['N2', 'actions', 'Vesper'], ['N3', 'actions', null], ['N4', 'summary', null]]);
  assert.deepEqual(input.refs.lines.map(l => [l.ref, l.segmentId]), [['S1', 'seg2'], ['S2', 'seg3'], ['S3', 'seg1']], 'lines in time order');
  assert.match(input.text, /^N2 Photograph the cracked shelf before the caretaker arrives \(owner: Vesper\) \[cites S2\]$/m);
  assert.match(input.text, /^N3 Label the coat hooks \[cites S3\]$/m, 'a proposed, unconfirmed owner is not given');
  assert.match(input.text, /^R1: \/m\/a \(folder\)$/m);
  assert.match(input.text, /^R2: \/m\/b\.md \(file\)$/m);
  assert.match(input.text, /^S1 \[00:10\] is the kiln room reopening/m);
  assert.doesNotMatch(input.text, /# Project memory/, 'no memory section without a project');
});

test('the input leaves out the least recently changed memory items first, then the brief, and then refuses', () => {
  const item = (n: number, updatedAt: number): Item => ({ project: 'p', id: `T-${n}`, type: 'todo', status: 'open', text: `To-do number ${n} ${'x'.repeat(80)}`, owner: null, fields: {},
    confirmed: true, mergedInto: null, version: 1, createdAt: 1, updatedAt });
  const items = [item(1, 50), item(2, 10), item(3, 30), { ...item(4, 1), status: 'done' as const }];
  const memory = { brief: 'Where the project stands: '.padEnd(400, 'y'), items };
  const full = buildPlanInput({ notes: notes(), roots: [], memory });
  assert.ok(!('refused' in full));
  assert.match(full.text, /- T-1 \(to-do\)/); assert.doesNotMatch(full.text, /T-4/, 'only open items');
  const room = full.bytes - 50;
  const fitted = buildPlanInput({ notes: notes(), roots: [], memory, limit: room });
  assert.ok(!('refused' in fitted));
  assert.doesNotMatch(fitted.text, /T-2 /, 'the least recently changed goes first');
  assert.match(fitted.text, /T-1 /); assert.match(fitted.text, /T-3 /);
  assert.deepEqual(fitted.omitted, { items: 1, brief: false });
  assert.match(fitted.warnings[0], /1 older project-memory item was left out/);
  const bare = buildPlanInput({ notes: notes(), roots: [], memory: null });
  assert.ok(!('refused' in bare));
  const noBrief = buildPlanInput({ notes: notes(), roots: [], memory, limit: bare.bytes + 60 });
  assert.ok(!('refused' in noBrief));
  assert.equal(noBrief.omitted.items, 3); assert.equal(noBrief.omitted.brief, true);
  assert.doesNotMatch(noBrief.text, /Where the project stands/);
  const refused = buildPlanInput({ notes: notes(), roots: [], memory, limit: bare.bytes - 10 });
  assert.deepEqual('refused' in refused && refused.refused, TOO_LONG);
  assert.equal(INPUT_LIMIT, 200_000);
});

test('evidence keeps what reads and greps returned, at their lines, without Pi\'s notices; outside the materials nothing', async () => {
  const f = await fixture();
  try {
    await f.evidence.record(readResult(f.file, 5, 20));
    await f.evidence.record(tool('grep', { pattern: 'latch', path: f.materials, context: 1 }, 'notes/plan.md-11- ' + LINES[10] + '\nnotes/plan.md:12: ' + LINES[11] + '\nnotes/plan.md-13- ' + LINES[12] + '\n\n[1 matches limit reached]'));
    await f.evidence.record(readResult(join(f.folder, 'scratch', 'input.md'), 1, 5));
    await f.evidence.record(tool('ls', { path: f.materials }, 'notes/'));
    const saved = await EvidenceRecorder.read(f.run);
    assert.ok(saved);
    assert.equal(saved.items.length, 2, 'the input file and ls are not evidence');
    const [read, grep] = saved.items;
    assert.ok(read.tool === 'read' && grep.tool === 'grep');
    assert.deepEqual([read.root, read.path, read.blocks[0].from, read.blocks[0].lines.length, read.cut], ['R1', 'notes/plan.md', 5, 20, false]);
    assert.equal(read.blocks[0].lines.at(-1), LINES[23], 'the notice is not a line of the file');
    assert.deepEqual(read.requested, { offset: 5, limit: 20 });
    assert.equal(read.hash.length, 64);
    assert.deepEqual(grep.blocks, [{ from: 11, lines: [LINES[10], LINES[11], LINES[12]] }]);
    assert.ok(f.evidence.complete);
  } finally { await f.close(); }
});

test('a result over its cap is saved cut and marked; a quote past the cut fails; a run over its cap cannot complete', async () => {
  const f = await fixture({ limits: { resultBytes: 800, runBytes: 3_000 } });
  try {
    await f.evidence.record(readResult(f.file, 1, 40));
    const [read] = (await f.evidence.read()).items;
    assert.ok(read.tool === 'read' && read.cut);
    assert.ok(read.blocks[0].lines.length < 12, 'cut before line 12');
    const checked = await check(f, { plans: [rawPlan()] });
    assert.match(checked.evidence['run1:k1'].result.reason!, /the saved text was cut/);
    assert.equal(checked.plans[0].answer!.check, 'unchecked');
    assert.ok(f.evidence.complete, 'a cut result still lets the run complete');
    for (let i = 0; i < 10; i++) await f.evidence.record(fetchResult(`https://example.org/${i}`));
    assert.equal(f.evidence.state.full, true);
    assert.ok(f.evidence.state.dropped > 0);
    assert.equal(f.evidence.complete, false);
  } finally { await f.close(); }
});

test('a fetched page is capped per page; python calls keep their run number, script, output and status', async () => {
  const f = await fixture({ limits: { pageBytes: 40 } });
  try {
    await f.evidence.record(fetchResult('https://example.org/kiln-access?utm_source=x#top'));
    await f.evidence.record(pythonResult(1));
    await f.evidence.record(pythonResult(2, false));
    const [page, ok, failed] = (await f.evidence.read()).items;
    assert.ok(page.tool === 'fetch' && page.cut && page.url === 'https://example.org/kiln-access' && Buffer.byteLength(page.text) <= 40);
    assert.ok(ok.tool === 'python' && ok.run === 1 && ok.ok && ok.script === 'print(1)' && ok.output === '1\n');
    assert.ok(failed.tool === 'python' && failed.run === 2 && !failed.ok && failed.status === 'exit 1');
  } finally { await f.close(); }
});

test('if the evidence cannot be saved, the run cannot become complete', async () => {
  const f = await fixture();
  try {
    await rm(f.run, { recursive: true });
    await f.evidence.record(readResult(f.file, 1, 10));
    assert.match(f.evidence.state.error!, /Could not save the evidence/);
    assert.equal(f.evidence.complete, false);
  } finally { await f.close(); }
});

test('Pi\'s streamed events reach the evidence through piEvent, paired with their arguments', async () => {
  const f = await fixture();
  try {
    f.evidence.piEvent({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: f.file, offset: 10, limit: 5 } });
    f.evidence.piEvent({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: LINES.slice(9, 14).join('\n') }] } });
    const [read] = (await f.evidence.read()).items;
    assert.ok(read.tool === 'read' && read.blocks[0].from === 10 && read.blocks[0].lines[2] === LINES[11]);
  } finally { await f.close(); }
});

test('material quotes count within 5 lines of the cited line, against the saved evidence only; the shown line is the quote\'s start', async () => {
  const f = await withRead(await fixture());
  try {
    const at = async (line: number, path = 'R1/notes/plan.md') => (await check(f, { plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path, line, quote: 'reopen the kiln room at quarter past two after the latch inspection' } }] })] })).evidence['run1:k1'];
    assert.deepEqual([(await at(12)).result.ok, (await at(12)).result.line], [true, 12]);
    assert.deepEqual([(await at(17)).result.ok, (await at(17)).result.line], [true, 12], 'five lines off still counts; the line shown is 12');
    assert.equal((await at(7)).result.ok, true);
    assert.equal((await at(18)).result.ok, false, 'six lines off does not');
    assert.equal((await at(12, 'notes/plan.md')).result.ok, true, 'one root: a plain path');
    assert.equal((await at(12, f.file)).result.ok, true, 'an absolute path inside the root');
    assert.match((await at(12, 'R1/notes/other.md')).result.reason!, /not read in this run/);
    assert.match((await at(12, 'R9/notes/plan.md')).result.reason!, /unknown material root R9/);
    // An explicit root is never replaced by the one root there is; two roots that disagree are a problem.
    const given = async (source: Record<string, unknown>) => (await check(f, { plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', line: 12, quote: 'reopen the kiln room at quarter past two after the latch inspection', ...source } }] })] })).evidence['run1:k1'].result;
    assert.match((await given({ root: 'R9', path: 'notes/plan.md' })).reason!, /unknown material root R9/);
    assert.match((await given({ root: 'R2', path: 'R1/notes/plan.md' })).reason!, /unknown material root R2/);
    assert.equal((await given({ root: 'R1', path: 'notes/plan.md' })).ok, true);
    assert.equal((await given({ root: 'R1', path: 'R1/notes/plan.md' })).ok, true);
    // The live file changed after the read: the quote is checked against what was read, and marked.
    await writeFile(f.file, 'gone');
    const changed = (await check(f, { plans: [rawPlan()] }, { changed: new Set(['R1/notes/plan.md']) })).evidence['run1:k1'];
    assert.deepEqual([changed.result.ok, changed.result.changed], [true, true]);
    // A quote past what the read returned fails, though the file has it.
    const late = (await check(f, { plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/notes/plan.md', line: 30, quote: 'the caretaker collects the used access cards in a brass tray' } }] })] })).evidence['run1:k1'];
    assert.equal(late.result.ok, false);
  } finally { await f.close(); }
});

test('transcript quotes are checked against the pinned line, as heard or corrected; web quotes against the fetched page', async () => {
  const f = await fixture();
  try {
    await f.evidence.record(fetchResult('https://example.org/kiln-access'));
    const source = (s: unknown) => ({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: s }] })] });
    const one = async (s: unknown) => (await check(f, source(s))).evidence['run1:k1'].result;
    assert.equal((await one({ type: 'transcript', ref: 'S1', quote: 'is the kiln room reopening before the afternoon pottery class' })).ok, true);
    assert.equal((await one({ type: 'transcript', ref: 'S2', quote: 'ves per will photograph the cracked shelf' })).ok, true, 'as heard');
    assert.match((await one({ type: 'transcript', ref: 'S2', quote: 'is the kiln room reopening before the afternoon pottery class' })).reason!, /not found in that line/);
    assert.match((await one({ type: 'transcript', ref: 'S9', quote: 'is the kiln room reopening before the afternoon pottery class' })).reason!, /no transcript line S9/);
    assert.match((await one({ type: 'transcript', ref: 'S1', quote: 'the kiln room' })).reason!, /too short/);
    assert.equal((await one({ type: 'web', url: 'https://example.org/kiln-access/', quote: 'remain locked until the caretaker has inspected the latch' })).ok, true);
    assert.match((await one({ type: 'web', url: 'https://example.org/other', quote: 'remain locked until the caretaker has inspected the latch' })).reason!, /not fetched in this run/);
    assert.match((await one({ type: 'web', url: 'https://example.org/kiln-access', quote: 'remain unlocked until the caretaker has inspected the latch' })).reason!, /not found in the fetched page/);
    assert.match((await one({ type: 'email', quote: 'x' })).reason!, /unknown source type/);
    assert.ok(PAGE_TEXT && LINE_TEXT);
  } finally { await f.close(); }
});

test('PDF evidence keeps its page lines: a citation gets its page, never cites the app\'s lines, and may end on a broken word', async () => {
  const f = await fixture();
  try {
    const made = formatText('paper.pdf', 2, ['The workshop stores spare gloves inside the fire-\nproof cupboard beside the kiln room door.', 'The second page lists spare keys.']);
    const view = join(f.cwd, 'pdf-text');
    await mkdir(join(view, 'root-a'), { recursive: true });
    await writeFile(join(f.materials, 'paper.pdf'), 'pdf bytes');
    const text = join(view, 'root-a', 'paper.pdf.txt');
    await writeFile(text, made.text);
    const roots = f.input.refs.roots;
    const pdfs = [{ rootId: 'root-a', text: join(view, 'root-a'), ready: 1, missing: [], files: [{ file: 'paper.pdf', version: '2:9:1', pageStarts: made.pageStarts, generated: made.generated }] }];
    const evidence = new EvidenceRecorder(f.run, { cwd: f.cwd, locate: materialLocator({ roots, view, pdfs }) });
    const lines = made.text.split('\n');
    await evidence.record(tool('read', { path: text }, lines.join('\n')));
    const saved = await evidence.read();
    const [item] = saved.items;
    assert.ok(item.tool === 'read' && item.path === 'paper.pdf' && item.pdf?.generated.length === 3);
    const one = async (path: string, line: number, quote: string) => checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path, line, quote } }] })] },
      { run: 'run1', refs: f.input.refs, evidence: saved, pins: PINS }).evidence['run1:k1'].result;
    const joined = await one('R1/paper.pdf', 3, 'spare gloves inside the fireproof cupboard beside the kiln');
    assert.deepEqual([joined.ok, joined.line, joined.page], [true, 3, 1]);
    assert.equal((await one('R1/paper.pdf.txt', 3, 'spare gloves inside the fireproof cupboard beside the kiln')).ok, true, 'cited by its text file');
    const broken = await one('R1/paper.pdf', 3, 'the workshop stores spare gloves inside the fire-');
    assert.deepEqual([broken.ok, broken.line, broken.to], [true, 3, 3], 'a quote ending on the broken word, up to its break');
    assert.equal((await one('R1/paper.pdf', 3, 'the workshop stores spare gloves inside the fire')).ok, false, 'without the hyphen it is half a word');
    assert.equal((await one('R1/paper.pdf', 2, 'page 1 of 2 the workshop stores spare gloves')).ok, false, 'the app\'s page line is not text');
    // Without the page lines recorded with the view, a PDF text's quotes never count (nothing is taken from the live cache).
    const bare = new EvidenceRecorder(join(f.folder, 'run-bare'), { cwd: f.cwd, locate: materialLocator({ roots, view }) });
    await mkdir(join(f.folder, 'run-bare'));
    await bare.record(tool('read', { path: text }, lines.join('\n')));
    const unpaged = await bare.read();
    assert.equal(unpaged.items[0].tool === 'read' && unpaged.items[0].pdf?.missing, true);
    const failed = checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/paper.pdf', line: 3, quote: 'spare gloves inside the fireproof cupboard beside the kiln' } }] })] },
      { run: 'run1', refs: f.input.refs, evidence: unpaged, pins: PINS }).evidence['run1:k1'].result;
    assert.match(failed.reason!, /no page lines were recorded/);
  } finally { await f.close(); }
});

test('an explicit root must agree with the root of the file an absolute path names, a PDF view\'s text included', async () => {
  const f = await fixture();
  try {
    const other = join(f.folder, 'other');
    await mkdir(other);
    const roots = planRoots([{ id: 'root-a', scope: 'meeting:m1', path: f.materials, kind: 'folder', label: 'materials' }, { id: 'root-b', scope: 'project:p', path: other, kind: 'folder', label: 'other' }]);
    const input = buildPlanInput({ notes: notes(), roots });
    assert.ok(!('refused' in input));
    const made = formatText('paper.pdf', 1, ['Leave the red emergency key inside the sealed box behind reception.']);
    const view = join(f.cwd, 'pdf-text');
    await mkdir(join(view, 'root-a'), { recursive: true });
    const text = join(view, 'root-a', 'paper.pdf.txt');
    await writeFile(text, made.text);
    const pdfs = [{ rootId: 'root-a', text: join(view, 'root-a'), ready: 1, missing: [], files: [{ file: 'paper.pdf', version: 'v', pageStarts: made.pageStarts, generated: made.generated }] }];
    const evidence = new EvidenceRecorder(f.run, { cwd: f.cwd, locate: materialLocator({ roots: input.refs.roots, view, pdfs }) });
    await evidence.record(readResult(f.file, 5, 20));
    await evidence.record(tool('read', { path: text }, made.text));
    const saved = await evidence.read();
    const one = (source: Record<string, unknown>) => checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', ...source } }] })] },
      { run: 'run1', refs: input.refs, evidence: saved, pins: PINS }).evidence['run1:k1'].result;
    const access = { line: 12, quote: 'reopen the kiln room at quarter past two after the latch inspection' };
    assert.equal(one({ root: 'R1', path: f.file, ...access }).ok, true);
    assert.match(one({ root: 'R2', path: f.file, ...access }).reason!, /the path is in R1, not R2/);
    const pdf = { line: 3, quote: 'leave the red emergency key inside the sealed box' };
    assert.equal(one({ path: text, ...pdf }).ok, true, 'the view\'s file names its root');
    assert.equal(one({ root: 'R1', path: text, ...pdf }).ok, true);
    assert.match(one({ root: 'R2', path: text, ...pdf }).reason!, /the path is in R1, not R2/);
  } finally { await f.close(); }
});

test('a grep over PDFs whose page lines alone pass the cap keeps the longest run of whole items that fits, marked cut', async () => {
  const f = await fixture();
  try {
    const view = join(f.cwd, 'pdf-text');
    await mkdir(join(view, 'root-a'), { recursive: true });
    // Four PDFs of thousands of pages: each one's page lines are about 30 KB as written.
    const pageStarts = Array.from({ length: 5_000 }, (_, i) => 2 * i + 3);
    const names = ['a', 'b', 'c', 'd'];
    for (const n of names) await writeFile(join(view, 'root-a', `${n}.pdf.txt`), 'x');
    const pdfs = [{ rootId: 'root-a', text: join(view, 'root-a'), ready: 4, missing: [],
      files: names.map(n => ({ file: `${n}.pdf`, version: 'v', pageStarts, generated: [1, ...pageStarts.map(p => p - 1)] })) }];
    const evidence = new EvidenceRecorder(f.run, { cwd: f.cwd, locate: materialLocator({ roots: f.input.refs.roots, view, pdfs }) });
    const line = 'leave the red emergency key inside the sealed box behind reception';
    await evidence.record(tool('grep', { pattern: 'emergency', path: join(view, 'root-a') }, names.map(n => `${n}.pdf.txt:3: ${line}`).join('\n')));
    const saved = await evidence.read();
    const kept = saved.items.filter(i => i.tool === 'grep');
    assert.ok(kept.length >= 1 && kept.length < 4, `${kept.length} of 4 kept whole`);
    assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 100_000);
    assert.ok(kept.every(i => i.cut));
    assert.deepEqual(kept.map(i => i.tool === 'grep' && i.blocks[0].lines[0]), kept.map(() => line), 'each kept item whole, its line included');
    const checked = checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/a.pdf', line: 3, quote: 'leave the red emergency key inside the sealed box' } }] })] },
      { run: 'run1', refs: f.input.refs, evidence: saved, pins: PINS });
    assert.equal(checked.evidence['run1:k1'].result.ok, true);
  } finally { await f.close(); }
});

test('bases: an answer needs at least one valid item; malformed, unknown and repeated ids are invalid, never empty', async () => {
  const f = await withRead(await fixture());
  try {
    const answerWith = async (basis: unknown) => (await check(f, { plans: [rawPlan({ answer: { text: 'a', complete: true, open: null, basis } })] })).plans[0].answer!;
    assert.equal((await answerWith(['k1'])).check, 'checked');
    assert.deepEqual([(await answerWith([])).check, (await answerWith([])).reason], ['unchecked', 'an answer needs at least one checked source']);
    assert.match((await answerWith(undefined)).reason!, /no basis/);
    assert.match((await answerWith('k1')).reason!, /no basis/);
    assert.match((await answerWith([1])).reason!, /malformed/);
    assert.match((await answerWith(['k1', 'k1'])).reason!, /listed twice/);
    assert.match((await answerWith(['k9'])).reason!, /unknown id k9/);
    const stepWith = async (basis: unknown) => (await check(f, { plans: [rawPlan({ next: { text: 'Do it', basis } })] })).plans[0].steps[0];
    assert.equal((await stepWith([])).check, 'proposal', 'a step on nothing quoted is an ordinary proposal');
    assert.equal((await stepWith(['k1'])).check, 'checked');
    assert.equal((await stepWith(['k2'])).check, 'unchecked');
    assert.equal((await stepWith(undefined)).check, 'unchecked');
    const failed = await check(f, { plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/notes/plan.md', line: 12, quote: 'a quote that is nowhere in the file' } }] })] });
    assert.deepEqual([failed.plans[0].answer!.check, failed.plans[0].steps[0].check], ['unchecked', 'unchecked']);
    assert.deepEqual(failed.plans[0].review.map(r => r.item), ['run1:k1'], 'the failed item is under Needs review in its plan');
  } finally { await f.close(); }
});

test('an id defined twice is invalid wherever it is used; an id may name another plan\'s item', async () => {
  const f = await withRead(await fixture());
  try {
    const second = rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], stateNow: [{ id: 'k1', text: 'The shelf needs a photograph', source: { type: 'transcript', ref: 'S2', quote: 'Vesper will photograph the cracked shelf before the caretaker arrives' } }],
      answer: null, next: { text: 'Place a ruler beside the crack for the photograph', basis: ['k1'] } });
    const checked = await check(f, { plans: [rawPlan(), second] });
    assert.equal(checked.evidence['run1:k1'].result.ok, false);
    assert.match(checked.evidence['run1:k1'].result.reason!, /defined more than once/);
    assert.equal(checked.plans[0].answer!.check, 'unchecked');
    assert.equal(checked.plans[1].steps[0].check, 'unchecked');
    const third = rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], stateNow: [], answer: null, next: { text: 'Place a ruler beside the crack for the photograph', basis: ['k1'] } });
    const shared = await check(f, { plans: [rawPlan(), third] });
    assert.equal(shared.plans[1].steps[0].check, 'checked', 'k1 of the first plan');
  } finally { await f.close(); }
});

test('a definition repeated in a plan past the limit still makes the id invalid', async () => {
  const f = await withRead(await fixture());
  try {
    const filler = (n: number) => rawPlan({ question: `Question ${n}`, stateNow: [{ ...rawPlan().stateNow[0], id: `k${n + 10}` }], answer: null, next: { text: 'Do it', basis: [] } });
    const plans = [rawPlan(), ...Array.from({ length: 7 }, (_, i) => filler(i)), rawPlan({ question: 'Ninth' })];
    const checked = await check(f, { plans });
    assert.equal(checked.plans.length, 8);
    assert.match(checked.evidence['run1:k1'].result.reason!, /defined more than once/);
    assert.equal(checked.plans[0].answer!.check, 'unchecked');
  } finally { await f.close(); }
});

test('the per-result cap holds for the evidence as written, ids and line numbers included; the run cap for the whole file', async () => {
  const many = Array.from({ length: 400 }, (_, i) => `${i % 10}`);
  const f = await fixture({ limits: { resultBytes: 1_500, runBytes: 4_000 } });
  try {
    await writeFile(f.file, many.join('\n'));
    await f.evidence.record(readResult(f.file, 1, 400, many));
    const [read] = (await f.evidence.read()).items;
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 1_500, 'within the cap as written');
    assert.equal(read.cut, true);
    // Absolute paths affect the serialized size; fill the run rather than assuming exactly three results do.
    for (let i = 0; i < 10 && !f.evidence.state.full; i++) await f.evidence.record(readResult(f.file, 1, 400, many));
    const file = await readFile(join(f.run, 'evidence.json'), 'utf8');
    assert.ok(Buffer.byteLength(file) <= 4_000, 'the file within the run cap');
    assert.equal(f.evidence.state.full, true);
    assert.equal(f.evidence.complete, false);
  } finally { await f.close(); }
});

test('quick checks name a recorded run_python call that finished without error; the plan shows its own script and output', async () => {
  const f = await fixture();
  try {
    await f.evidence.record(pythonResult(1));
    await f.evidence.record(pythonResult(2, false));
    const checks = [{ id: 'c1', run: 1, showed: 'one' }, { id: 'c2', run: 2, showed: 'two' }, { id: 'c3', run: 3, showed: 'three' }, { id: 'c4', run: 'first', showed: 'x' }];
    const checked = await check(f, { plans: [rawPlan({ stateNow: [], checks, answer: { text: 'a', complete: true, open: null, basis: ['c1'] } })] });
    const e = checked.evidence;
    assert.deepEqual([e['run1:c1'].result.ok, e['run1:c1'].result.script, e['run1:c1'].result.output], [true, 'print(1)', '1\n']);
    assert.match(e['run1:c2'].result.reason!, /did not finish without error/);
    assert.match(e['run1:c3'].result.reason!, /no run_python call 3/);
    assert.match(e['run1:c4'].result.reason!, /no run number/);
    assert.equal(checked.plans[0].answer!.check, 'checked');
  } finally { await f.close(); }
});

test('plans: from, owner, steps, row texts never cut, coverage over kept plans, and the three statuses', async () => {
  const f = await withRead(await fixture());
  try {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen';
    const checked = await check(f, {
      plans: [
        rawPlan({ label: 'A label that runs on far too long', stepLine: long, owner: 'Oriel', from: ['N1', 'N9'],
          followOn: [{ if: 'the latch sticks', then: 'Keep the room locked and call the caretaker', basis: [] }, { then: 'No condition', basis: [] }, { if: 'x', then: 'y', basis: [] }] }),
        rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], owner: 'Vesper', stateNow: [], answer: null, next: { text: 'Place a ruler beside the crack for the photograph', basis: [] } }),
        rawPlan({ question: 'Invented', from: ['N42'] }),
      ],
      deferred: [{ item: 'N3', why: 'only a summary' }, { item: 'N8', why: 'x' }],
    });
    const [a, b] = checked.plans;
    assert.equal(checked.plans.length, 2);
    assert.deepEqual(checked.dropped.map(d => d.reason), ['no valid N or S reference in "from"']);
    assert.deepEqual(a.from, ['N1']);
    assert.equal(a.owner, null, 'the model\'s owner alone is not an owner');
    assert.equal(a.ownerClaimed, 'Oriel');
    assert.equal(b.owner, 'Vesper', 'the notes verified Vesper for N2');
    assert.equal(a.label, 'A label that runs on far too long', 'kept whole');
    assert.equal(a.stepLine, long);
    assert.deepEqual(a.rowFlags, ['label over 5 words', 'step line over 15 words']);
    assert.deepEqual(a.steps.map(s => [s.id, s.kind, s.if]), [['p1.s1', 'next', null], ['p1.s2', 'follow', 'the latch sticks']]);
    assert.ok(a.review.some(r => r.reason === 'a follow-on step without its condition'));
    assert.equal(a.changeIf, 'A red fault light on the latch');
    assert.deepEqual(checked.deferred.map(d => d.item), ['N3']);
    assert.ok(checked.review.some(r => /N8/.test(r)));
    assert.deepEqual(checked.notCovered, [], 'N1 and N2 are planned, N3 is a summary item');
    assert.equal(checked.status, 'plans');
    const uncovered = await check(f, { plans: [rawPlan()] });
    assert.deepEqual(uncovered.notCovered.map(n => n.item), ['N2'], 'the action item is neither planned nor deferred');
    assert.equal((await check(f, { plans: [], deferred: [{ item: 'N1', why: 'answered in the meeting' }, { item: 'N2', why: 'done already' }] })).status, 'nothing to plan');
    const failed = await check(f, { plans: [rawPlan({ from: ['N77'] }), rawPlan({ from: [] })] });
    assert.deepEqual([failed.status, failed.notCovered.length], ['all plans failed checks', 2], 'coverage counts kept plans only');
    assert.equal((await check(f, { plans: Array.from({ length: 10 }, () => rawPlan()) })).dropped.length, 2, 'at most 8 plans');
    // A plan with neither an answer nor a next step is dropped before coverage and status.
    const empty = await check(f, { plans: [rawPlan({ answer: null, next: null }), rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], answer: { text: '' }, next: { text: '  ' } })] });
    assert.deepEqual([empty.status, empty.plans.length, empty.notCovered.map(n => n.item)], ['all plans failed checks', 0, ['N1', 'N2']]);
    assert.deepEqual(empty.dropped.map(d => d.reason), ['neither an answer nor a next step', 'neither an answer nor a next step']);
    // "Nothing to plan" only with a valid empty list and every open item deferred with a reason.
    assert.equal((await check(f, {})).status, 'all plans failed checks');
    assert.equal((await check(f, { plans: [], deferred: [] })).status, 'all plans failed checks');
    assert.equal((await check(f, { plans: [], deferred: [{ item: 'N1', why: 'answered in the meeting' }] })).status, 'all plans failed checks');
    assert.equal((await check(f, { plans: [], deferred: [{ item: 'N1', why: 'answered' }, { item: 'N2', why: '' }] })).status, 'all plans failed checks', 'a deferral needs its reason');
  } finally { await f.close(); }
});

test('deferrals use their leading N or S id, reject unknown ids, and still require reasons for coverage', async () => {
  const f = await fixture();
  try {
    const refs = { ...f.input.refs, notes: f.input.refs.notes.map((n, i) => ({ ...n, ref: `N${i + 10}` })),
      lines: f.input.refs.lines.map((l, i) => ({ ...l, ref: `S${i + 14}` })) };
    const result = await check(f, { plans: [], deferred: [
      { item: 'N10: room access', why: 'The signed handover log answers it.' },
      { item: 'N11 shelf photograph', why: 'Vesper has the camera ready.' },
      { item: 'S14 — transcript context', why: 'Context only.' },
      { item: 'N99: invented note', why: 'Not in this input.' },
    ] }, { refs });
    assert.deepEqual(result.deferred.map(d => d.item), ['N10', 'N11', 'S14']);
    assert.equal(result.deferred[0].text, refs.notes[0].text);
    assert.deepEqual(result.notCovered, [], 'N10 and N11 are covered by their reasoned deferrals');
    assert.equal(result.status, 'nothing to plan');
    assert.deepEqual(result.review, ['A deferred item names no note of the input ("N99").']);
    const noReason = await check(f, { plans: [], deferred: [{ item: 'N10: room access', why: '' },
      { item: 'N11', why: 'Done.' }, { item: 'S14 — context', why: 'Context only.' }] }, { refs });
    assert.deepEqual(noReason.notCovered.map(n => n.item), ['N10']);
    assert.equal(noReason.status, 'all plans failed checks');
    assert.ok(noReason.review.includes('N10 was deferred without a reason.'));
  } finally { await f.close(); }
});

test('a no-reference deferral is retained without a review line and cannot cover open items', async () => {
  const f = await fixture();
  try {
    const remark = { item: 'Project-memory items outside this meeting', why: 'Outside this meeting’s scope.' };
    const result = await check(f, { plans: [rawPlan()], deferred: [remark] });
    assert.deepEqual(result.review, []);
    assert.deepEqual(result.deferred, [{ ...remark, text: null }]);
    const doc = plansDocument(result, { kind: 'plan', base: null, createdAt: 1, finished: true, evidenceComplete: true,
      pins: { ...PINS, materials: { roots: [], files: {}, complete: true, digest: PINS.manifest } } });
    await saveRunPlans(f.run, doc);
    assert.deepEqual((await loadRunPlans(f.run))?.deferred, [{ ...remark, text: null }], 'also retained in the saved run record');
    assert.deepEqual(result.notCovered.map(n => n.item), ['N2']);
    const empty = await check(f, { plans: [], deferred: [remark, { item: 'About N1', why: 'Not a leading reference.' }] });
    assert.equal(empty.status, 'all plans failed checks');
    assert.deepEqual(empty.notCovered.map(n => n.item), ['N1', 'N2']);
    assert.equal(empty.review.length, 1, 'only the missing coverage is a review diagnostic');
  } finally { await f.close(); }
});

test('the rows: an answer only when checked, "Next:" only beside an answer, the first three open, out-of-date labels per plan', async () => {
  const f = await withRead(await fixture());
  try {
    // Each plan its own item ids (they are unique across plans).
    const own = (n: number, over: Record<string, unknown>) => rawPlan({ stateNow: [{ ...rawPlan().stateNow[0], id: `k${n}` }], next: { text: 'Hang the green access card beside the kiln room door', basis: [`k${n}`] },
      answer: { text: 'At 14:15 after inspection', complete: true, open: null, basis: [`k${n}`] }, ...over });
    const checked = await check(f, { plans: [own(1, {}), own(2, { answer: { text: 'So far half', complete: false, open: 'the rest', basis: ['k2'] } }),
      own(3, { answer: null, stepLine: null }), own(4, { answer: { text: 'x', complete: true, open: null, basis: [] } })] });
    const version: PublishedVersion = { schema: 1, meetingId: 'm1', version: 1, base: null, publishedAt: 1, run: 'run1', kind: 'plan', plan: null, status: checked.status,
      warnings: [], plans: checked.plans, evidence: checked.evidence, deferred: [], notCovered: [], dropped: [], review: [] };
    const view = planRows(version, { current: { notesVersion: 2, memoryStamp: 'm1', manifest: 'digest-1' } });
    assert.deepEqual(view.rows.map(r => r.answer?.kind ?? null), ['answer', 'so far', null, 'unchecked']);
    assert.deepEqual(view.rows.map(r => r.step?.prefix ?? null), ['Next:', 'Next:', null, 'Next:']);
    assert.equal(view.rows[2].step!.text, 'Hang the green access card beside the kiln room door', 'no step line: the full step');
    assert.deepEqual(view.rows.map(r => r.folded), [false, false, false, true]);
    assert.equal(view.folded, 1);
    assert.equal(view.rows[0].outOfDate, 'Made before the notes changed');
    assert.equal(view.label, 'Plans — sources checked, not the ideas themselves');
  } finally { await f.close(); }
});
