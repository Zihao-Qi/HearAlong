import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import {
  ActionJobs, MAX_FOLLOW_UP_DEPTH, actionInput, captureContext, checkAnswer, checkTranscriptSource, toolsFor, checkFileSource, checkWebSource, compareManifests, materialManifest, parseAnswer, webEvidence,
  type ActionRunner,
} from '../src/actions.ts';
import type { PiTaskResult, ToolResult } from '../src/pi-task.ts';
import { Cooldowns } from '../src/quota.ts';
import type { Material } from '../src/materials.ts';
import type { Recognition } from '../src/recognizer.ts';

const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
const LINES = ['How many brass buttons are in the costume cupboard?', 'Count the jackets on rail C before lunch.', 'The stock sheet lists seven packets of eight.',
  'Did anyone water the lobby fern?', 'Find a repair shop for the sewing machine.'];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-actions-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Community theatre wardrobe count');
  for (const [i, line] of LINES.entries()) {
    const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 60_000, 16000, Buffer.alloc(16000 * 4, i + 1));
    store.completeChunk(chunk.id, recognition(line));
  }
  const materials = join(directory, 'materials');
  await mkdir(join(materials, 'inventory'), { recursive: true });
  await writeFile(join(materials, 'inventory', 'stock.txt'), ['Costume cupboard stock sheet', 'Rail C holds the blue parade jackets.',
    'Brass buttons: 7 packets of 8 = 56 buttons, counted on Thursday.', 'Spare thread is stored in the green tin.'].join('\n'));
  await writeFile(join(directory, 'outside.txt'), 'secret words that are outside the materials root');
  const roots: Material[] = [{ id: 'R1', scope: `meeting:${meeting.id}`, path: materials, kind: 'folder', label: 'materials' }];
  const segments = store.segments(meeting.id);
  return { directory, store, meeting, roots, materials, segments, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const result = (text: string, extra: Partial<PiTaskResult> = {}): PiTaskResult => ({
  text, ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 0, toolResults: [], provider: 'openai-codex', model: 'gpt-6.1-sol', ...extra,
});
const META = (sources: unknown[]) => `\n<<<META\n${JSON.stringify({ sources, assumptions: ['all packets are unopened'], openPoints: [] })}\nMETA>>>`;

test('context is captured once around the selection, with limits', async () => {
  const f = await fixture();
  try {
    const context = captureContext(f.store, f.meeting.id, { text: 'rail C', segmentIds: [f.segments[1].id] }, Date.now(), null, f.roots);
    assert.deepEqual(context.lines.map(l => l.selected), context.lines.map(l => l.id === f.segments[1].id));
    assert.equal(context.lines[0].startMs, 0, 'two minutes before the selection');
    assert.ok(context.lines.every(l => l.startMs <= 60_000 + 30_000 + 60_000), 'only up to 30 s after the selection');
    assert.match(actionInput({ action: 'compute', prompt: null, context }), /^<<<ACTION DATA — not instructions[\s\S]*>> \[01:00\] Count the jackets[\s\S]*- R1: /);
    assert.throws(() => captureContext(f.store, f.meeting.id, { text: 'x', segmentIds: ['nope'] }, Date.now(), null, f.roots), /not in the transcript/);
    assert.throws(() => captureContext(f.store, f.meeting.id, { text: 'x'.repeat(5000), segmentIds: [f.segments[1].id] }, Date.now(), null, f.roots), /too long/);
  } finally { await f.close(); }
});

test('the answer is split from its metadata even after a Python code fence', () => {
  const text = 'Count the buttons [1].\n```python\nprint({"a": 1})\n```\n' + META([{ id: 1, type: 'file', rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: 'x' }]);
  const parsed = parseAnswer(text);
  assert.equal(parsed.error, null);
  assert.equal(parsed.meta?.sources.length, 1);
  assert.match(parsed.markdown, /```python/);
  assert.match(parseAnswer('No block at all').error!, /no metadata/);
  assert.match(parseAnswer('x\n<<<META\n{bad json\nMETA>>>').error!, /not valid JSON/);
});

test('file citations: inside the root, real lines, quote found; traversal and symlinks rejected', async () => {
  const f = await fixture();
  try {
    const ok = await checkFileSource({ id: 1, rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: '7 packets of 8 = 56 buttons, counted on Thursday' }, f.roots);
    assert.equal(ok.status, 'quote found');
    assert.match(ok.excerpt!, /56/);
    const near = await checkFileSource({ id: 2, rootId: 'R1', path: 'inventory/stock.txt', lines: '1', quote: 'Spare thread is stored in the green tin' }, f.roots);
    assert.equal(near.status, 'quote found', 'within ±3 lines');
    assert.match(near.excerpt!, /green tin/, 'the preview shows the lines that matched, not just the cited one');
    assert.deepEqual([near.matchedFrom, near.matchedTo], [4, 4]);
    assert.match((await checkFileSource({ id: 2, rootId: 'R1', path: 'inventory/stock.txt', lines: '1-999', quote: 'thread is stored in the green tin' }, f.roots)).detail!, /not inside the file/);
    const multi = await checkFileSource({ id: 3, rootId: 'R1', path: 'inventory/stock.txt', lines: '1, 4', quote: 'Spare thread is stored in the green tin' }, f.roots);
    assert.equal(multi.status, 'quote found', 'several ranges');
    assert.match(multi.citedText!, /\[1-1\][\s\S]*\[4-4\]/);
    // A repo's live memory files may hold unapproved edits: never a source (memory is cited from the app's snapshot).
    assert.match((await checkFileSource({ id: 5, rootId: 'R1', path: 'project-memory/todos.md', lines: '1', quote: 'T-5' }, f.roots)).detail!, /not a source/);
    const wrong = await checkFileSource({ id: 3, rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: 'Brass buttons: 9 packets of 8 = 72 buttons' }, f.roots);
    assert.equal(wrong.status, 'quote not found');
    const changedNumber = await checkFileSource({ id: 4, rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: '7 packets of 8 = 57 buttons, counted on Thursday' }, f.roots);
    assert.equal(changedNumber.status, 'quote not found');
    assert.equal((await checkFileSource({ id: 5, rootId: 'R1', path: '../outside.txt', lines: '1', quote: 'secret words that are outside' }, f.roots)).detail, 'outside the attached materials');
    await symlink(join(f.directory, 'outside.txt'), join(f.materials, 'link.txt'));
    assert.equal((await checkFileSource({ id: 6, rootId: 'R1', path: 'link.txt', lines: '1', quote: 'secret words that are outside' }, f.roots)).detail, 'outside the attached materials');
    assert.equal((await checkFileSource({ id: 7, rootId: 'R1', path: 'inventory/missing.txt', lines: '1', quote: 'a b c' }, f.roots)).detail, 'file not found');
    assert.match((await checkFileSource({ id: 8, rootId: 'R1', path: 'inventory/stock.txt', lines: '40-50', quote: 'a b c' }, f.roots)).detail!, /not inside the file/);
    const roots2 = [...f.roots, { ...f.roots[0], id: 'R2' }];
    assert.equal((await checkFileSource({ id: 9, rootId: 'R9', path: 'inventory/stock.txt', lines: '3', quote: 'a b c' }, roots2)).detail, 'unknown material root', 'no guessing between roots');
  } finally { await f.close(); }
});

test('web citations: each page gets only its own text, from the tools\' structured results', () => {
  // Shapes as pi-web-access returns them (structuredContent / details), not just the model-facing text.
  const results: ToolResult[] = [
    { id: '1', name: 'web_search', args: { query: 'sewing repairs' }, isError: false, text: 'summary of two repair shops; a needle alignment costs 37 dollars',
      structured: { queries: [{ query: 'sewing repairs', answer: 'Spool Shed charges 37 dollars for needle alignment; Stitch Bench sells bobbins.', results: [
        { title: 'Spool Shed', url: 'https://a.example/repairs?utm_source=openai', snippet: 'A needle alignment costs 37 dollars at Spool Shed' },
        { title: 'Stitch Bench', url: 'https://b.example/bobbins', snippet: 'Stitch Bench stocks wooden bobbin racks' }] }] } },
    { id: '2', name: 'fetch_content', args: { urls: ['https://example.org/workshop', 'https://broken.example/'] }, isError: false, text: '## Fetched URLs ...',
      structured: { responseId: 'r1', urls: [{ url: 'https://example.org/workshop', title: 'Workshop', content: 'Bring the machine pedal to the repair workshop on Tuesday at 14:35.', error: null },
        { url: 'https://broken.example/', title: '', content: '', error: 'HTTP 500' }] } },
    { id: '3', name: 'get_search_content', args: { responseId: 'r2', urlIndex: 0 }, isError: false, text: '# Returns\n\nUnused bobbins can be exchanged within 17 days with a receipt.',
      details: { url: 'https://notions.example/returns', title: 'Returns' } },
  ];
  const evidence = webEvidence(results);
  const check = (url: string, quote: string) => checkWebSource({ id: 1, url, quote }, evidence).status;
  assert.equal(check('https://example.org/workshop', 'Bring the machine pedal to the repair workshop'), 'quote found');
  assert.equal(check('https://example.org/workshop', 'The workshop supplies a free replacement pedal'), 'quote not found');
  assert.equal(check('https://broken.example', 'anything at all here'), 'fetch failed', 'only the page that failed is marked failed');
  assert.equal(check('https://a.example/repairs', 'A needle alignment costs 37 dollars'), 'quote in search snippet', 'tracking parameters ignored; snippet is not a fetched page');
  assert.equal(check('https://b.example/bobbins', 'A needle alignment costs 37 dollars'), 'seen in search only', 'another result\'s words are not credited to B');
  assert.equal(check('https://notions.example/returns', 'Unused bobbins can be exchanged within 17 days'), 'quote found', 'stored slices count for their own page');
  assert.equal(check('https://made-up.example/thread', 'waxed thread in six colours'), 'not seen');
  assert.equal(checkWebSource({ id: 2, url: 'javascript:alert(1)', quote: 'x y z' }, evidence).url, undefined, 'invalid addresses never become links');
});

test('metadata is validated: duplicate ids, unknown types and too many sources are never all-green', async () => {
  const f = await fixture();
  try {
    const src = { type: 'file', rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: '7 packets of 8 = 56 buttons, counted on Thursday' };
    const dup = await checkAnswer('56 buttons [1].' + META([{ id: 1, ...src }, { id: 1, ...src }]), f.roots, { pages: {} });
    assert.deepEqual(dup.checks.map(c => c.detail), ['malformed source: duplicate id 1', 'malformed source: duplicate id 1']);
    assert.equal(dup.summary, '0/2 quotes found · 1 missing source', '[1] points at an invalid (duplicated) source');
    const odd = await checkAnswer('x [1] [123].' + META([{ id: 1, ...src, type: 'book' }]), f.roots, { pages: {} });
    assert.match(odd.checks[0].detail!, /unknown type/);
    assert.deepEqual(odd.uncitedRefs, [1, 123], 'three-digit markers are checked too');
    assert.match(parseAnswer('x' + META(Array.from({ length: 31 }, (_, i) => ({ id: i + 1, ...src })))).error!, /too many sources/);
    assert.match(parseAnswer('x\n<<<META\n[1,2]\nMETA>>>').error!, /wrong shape/);
  } finally { await f.close(); }
});

test('material manifest notices a changed file and says when it could not check everything', async () => {
  const f = await fixture();
  try {
    const before = await materialManifest(f.roots);
    assert.equal(compareManifests(before, await materialManifest(f.roots)).status, 'no change seen');
    await writeFile(join(f.materials, 'inventory', 'stock.txt'), 'changed');
    await utimes(join(f.materials, 'inventory', 'stock.txt'), new Date(), new Date(Date.now() + 5000));
    assert.equal(compareManifests(before, await materialManifest(f.roots)).status, 'change observed');
    assert.equal(compareManifests(await materialManifest(f.roots, 20_000, 0), await materialManifest(f.roots, 20_000, 0)).status, 'not fully checked', 'depth cap reached');
  } finally { await f.close(); }
});

/** A scripted Pi: each call waits for the test to release it with a result. */
function scripted() {
  const calls: { action: string; input: string; signal: AbortSignal; release: (r: PiTaskResult | Error) => void }[] = [];
  const runner: ActionRunner = async ({ action, inputPath, signal, onEvent }) => {
    const input = await (await import('node:fs/promises')).readFile(inputPath, 'utf8');
    return new Promise((resolve, reject) => {
      const call = { action, input, signal, release: (r: PiTaskResult | Error) => r instanceof Error ? reject(r) : resolve(r) };
      // Like runPiTask: an abort that happened before the task started still cancels it.
      if (signal.aborted) return reject(new Error('Pi task was cancelled.'));
      signal.addEventListener('abort', () => reject(new Error('Pi task was cancelled.')), { once: true });
      onEvent({ type: 'tool_execution_start', toolName: 'read', args: { path: '/x/inventory/stock.txt' } });
      onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Draft…' } });
      calls.push(call);
    });
  };
  return { runner, calls };
}
// Job completion includes asynchronous evidence checks and durable writes.
import { until } from './helpers/until.ts';

test('action jobs: two at a time, merged duplicates, bounded queue, cancel, checks, failure keeps the draft', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    const sel = (i: number) => ({ text: LINES[i].slice(0, 20), segmentIds: [f.segments[i].id] });
    const a = await jobs.submit(f.meeting.id, { action: 'answer', selection: sel(0) });
    const dup = await jobs.submit(f.meeting.id, { action: 'answer', selection: sel(0) });
    assert.equal(dup.merged, true);
    assert.equal(dup.job.id, a.job.id);
    const b = await jobs.submit(f.meeting.id, { action: 'compute', selection: sel(1) });
    const c = await jobs.submit(f.meeting.id, { action: 'explain', selection: sel(2) });
    await until(() => calls.length === 2);
    assert.equal(jobs.get(c.job.id)!.state, 'queued', 'only two run at once');
    assert.equal(jobs.list(f.meeting.id).find(j => j.id === c.job.id)!.queuePosition, 1);
    assert.deepEqual(jobs.get(a.job.id)!.status, ['Reading stock.txt']);
    for (let i = 3; i < 8; i++) await jobs.submit(f.meeting.id, { action: 'other', prompt: `q${i}`, selection: sel(0) });
    await assert.rejects(jobs.submit(f.meeting.id, { action: 'other', prompt: 'one too many', selection: sel(0) }), /Too many actions waiting/);
    await jobs.cancel(f.meeting.id, c.job.id);
    assert.equal(jobs.get(c.job.id)!.state, 'cancelled');

    // A finished answer with one good and one invented citation: done, with the failure shown.
    calls[0].release(result('The cupboard has 56 buttons [1], see also [2] and [3].' + META([
      { id: 1, type: 'file', rootId: 'R1', path: 'inventory/stock.txt', lines: '3', quote: '7 packets of 8 = 56 buttons, counted on Thursday' },
      { id: 2, type: 'web', url: 'https://invented.example/wardrobe', quote: 'a page nobody fetched here' }])));
    await until(() => jobs.get(a.job.id)!.state === 'done');
    const done = jobs.get(a.job.id)!.result!;
    assert.deepEqual(done.checks.map(x => x.status), ['quote found', 'not seen']);
    assert.deepEqual(done.uncitedRefs, [3]);
    assert.equal(done.summary, '1/2 quotes found · 1 missing source');
    assert.equal(jobs.get(a.job.id)!.draft, '');

    // A run that prints text and then exits abnormally is a failure; the partial draft is kept, labelled by state.
    calls[1].release(result('Partial', { exitCode: 1 }));
    await until(() => jobs.get(b.job.id)!.state === 'failed');
    assert.match(jobs.get(b.job.id)!.error!, /did not finish normally/);
    assert.equal(jobs.get(b.job.id)!.draft, 'Draft…');
    assert.equal(jobs.get(b.job.id)!.result!.manifest!.status, 'no change seen', 'compute checks the materials even on failure');

    // Cancel a running job (the queue has moved on: two more started).
    await until(() => calls.length === 4);
    await jobs.cancel(f.meeting.id, jobs.list(f.meeting.id).find(j => j.state === 'running')!.id);
    await until(() => jobs.list(f.meeting.id).filter(j => j.state === 'cancelled').length === 2);
    await jobs.close();
  } finally { await f.close(); }
});

test('retry makes a new job, follow-ups need a finished parent, restarts never rerun anything', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    const selection = { text: 'repair shop for the sewing machine', segmentIds: [f.segments[4].id] };
    const first = await jobs.submit(f.meeting.id, { action: 'lookUp', selection });
    await assert.rejects(jobs.submit(f.meeting.id, { parentId: first.job.id, prompt: 'Do they take walk-ins?' }), /finished answer/);
    await until(() => calls.length === 1);
    calls[0].release(result('Spool Shed repairs foot pedals [1].' + META([{ id: 1, type: 'web', url: 'https://spool.example/repairs', quote: 'repairs foot pedals and replaces drive belts' }]), {
      toolResults: [{ id: '1', name: 'fetch_content', args: { url: 'https://spool.example/repairs' }, isError: false, text: 'Spool Shed repairs foot pedals and replaces drive belts.' }],
    }));
    await until(() => jobs.get(first.job.id)!.state === 'done');
    const follow = await jobs.submit(f.meeting.id, { parentId: first.job.id, prompt: 'Can they fix the pedal too?' });
    await until(() => calls.length === 2);
    assert.match(calls[1].input, /THIS IS A FOLLOW-UP[\s\S]*Spool Shed repairs foot pedals/);
    // The follow-up cites the parent's page without fetching it again: checked against the parent's saved evidence.
    calls[1].release(result('The pedal service is listed [1].' + META([{ id: 1, type: 'web', url: 'https://spool.example/repairs', quote: 'repairs foot pedals and replaces drive belts' }])));
    await until(() => jobs.get(follow.job.id)!.state === 'done');
    assert.deepEqual(jobs.get(follow.job.id)!.result!.checks.map(c => [c.status, c.inherited]), [['quote found', true]]);
    assert.match(calls[1].input, /"excerpt"|"url":"https:\/\/spool\.example\/repairs"/, 'the follow-up gets the earlier evidence as data');
    // A follow-up of the follow-up still sees the grandparent's page (inheritance is transitive).
    const grand = await jobs.submit(f.meeting.id, { parentId: follow.job.id, prompt: 'What about the drive belt?' });
    await until(() => calls.length === 3);
    calls[2].release(result('Drive belts are also listed [1].' + META([{ id: 1, type: 'web', url: 'https://spool.example/repairs', quote: 'repairs foot pedals and replaces drive belts' }])));
    await until(() => jobs.get(grand.job.id)!.state === 'done');
    assert.deepEqual(jobs.get(grand.job.id)!.result!.checks.map(c => [c.status, c.inherited]), [['quote found', true]]);

    const retry = await jobs.submit(f.meeting.id, { retryOf: first.job.id });
    assert.notEqual(retry.job.id, first.job.id);
    assert.equal(retry.job.retryOf, first.job.id);
    assert.equal(jobs.get(first.job.id)!.state, 'done', 'the original is kept');
    await until(() => calls.length === 4);
    const queued = await jobs.submit(f.meeting.id, { action: 'explain', selection });
    const third = await jobs.submit(f.meeting.id, { action: 'other', prompt: 'x', selection });
    await jobs.close();
    assert.equal(jobs.get(retry.job.id)!.state, 'interrupted');

    // After a restart: nothing is started again; unfinished jobs read as interrupted.
    const { runner: runner2, calls: calls2 } = scripted();
    const restarted = new ActionJobs({ store: f.store, directory: f.directory, runner: runner2, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    await restarted.load();
    assert.deepEqual([queued.job.id, third.job.id].map(id => restarted.get(id)!.state), ['interrupted', 'interrupted']);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls2.length, 0);
    await restarted.close();
  } finally { await f.close(); }
});

test('needs-materials actions explain themselves; writing is refused when models are off', async () => {
  const f = await fixture();
  try {
    const { runner } = scripted();
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => [] });
    await assert.rejects(jobs.submit(f.meeting.id, { action: 'answer', selection: { text: 'x', segmentIds: [f.segments[0].id] } }), /Attach materials first/);
    await assert.rejects(jobs.submit(f.meeting.id, { action: 'other', selection: { text: 'x', segmentIds: [f.segments[0].id] } }), /Type what you want/);
    const off = new ActionJobs({ store: f.store, directory: f.directory, runner: null, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    await assert.rejects(off.submit(f.meeting.id, { action: 'explain', selection: { text: 'x', segmentIds: [f.segments[0].id] } }), /disabled/);
    assert.deepEqual(off.list(f.meeting.id), [], 'nothing is created without a click');
    await jobs.close();
  } finally { await f.close(); }
});

test('a job whose record cannot be saved is refused and never runs; closing waits for submissions in preparation', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    await mkdir(join(f.directory, 'actions'), { recursive: true });
    await writeFile(join(f.directory, 'actions', f.meeting.id), 'not a folder'); // makes every job write fail
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    await assert.rejects(jobs.submit(f.meeting.id, { action: 'explain', selection: { text: 'x', segmentIds: [f.segments[0].id] } }), /Could not save/);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls.length, 0);
    assert.deepEqual(jobs.list(f.meeting.id), []);
    await jobs.close();

    await rm(join(f.directory, 'actions', f.meeting.id));
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const slow = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => { await gate; return null; }, rootsFor: () => f.roots });
    const pending = slow.submit(f.meeting.id, { action: 'explain', selection: { text: 'x', segmentIds: [f.segments[0].id] } });
    const closing = slow.close();
    open();
    await assert.rejects(pending, /closing/);
    await closing;
    assert.equal(calls.length, 0, 'nothing starts after shutdown began');
  } finally { await f.close(); }
});

test('at start-up, PDF text views left by runs that never finished are removed', async () => {
  const f = await fixture();
  try {
    const view = join(f.directory, 'scratch', 'actions', 'crashed-job', 'pdf-text', 'R1');
    await mkdir(view, { recursive: true });
    await writeFile(join(view, 'main.pdf.txt'), 'old text');
    await writeFile(join(f.directory, 'scratch', 'actions', 'crashed-job', 'kept.txt'), 'other scratch');
    await new ActionJobs({ store: f.store, directory: f.directory, runner: null, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots }).load();
    assert.deepEqual(await readdir(join(f.directory, 'scratch', 'actions', 'crashed-job')), ['kept.txt']);
  } finally { await f.close(); }
});

test('a rate-limit error pauses dispatch; queued jobs wait', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    const sel = (i: number) => ({ text: LINES[i].slice(0, 12), segmentIds: [f.segments[i].id] });
    const a = await jobs.submit(f.meeting.id, { action: 'explain', selection: sel(0) });
    await jobs.submit(f.meeting.id, { action: 'explain', selection: sel(1) });
    const c = await jobs.submit(f.meeting.id, { action: 'explain', selection: sel(2) });
    await until(() => calls.length === 2);
    // The first job's call (the two may start in either order).
    calls.find(call => call.input.includes(`]: "${sel(0).text.trim()}"`))!.release(result('partial text', { stopReason: 'error', errorMessage: 'You have hit your usage limit (429).' }));
    await until(() => jobs.get(a.job.id)!.state === 'failed');
    assert.match(jobs.get(a.job.id)!.error!, /usage limit/);
    assert.ok(jobs.paused());
    await new Promise(r => setTimeout(r, 50));
    assert.equal(jobs.get(c.job.id)!.state, 'queued', 'dispatch paused');
    await jobs.close();
  } finally { await f.close(); }
});

test('transcript citations are checked against the lines the action was given', async () => {
  const f = await fixture();
  try {
    const context = captureContext(f.store, f.meeting.id, { text: 'rail C', segmentIds: [f.segments[1].id] }, Date.now(), null, f.roots);
    assert.equal(checkTranscriptSource({ id: 1, time: '01:00', quote: 'Count the jackets on rail C before lunch' }, context.lines).status, 'quote found');
    assert.equal(checkTranscriptSource({ id: 1, time: '01:00', quote: 'The velvet capes are ready for collection' }, context.lines).status, 'quote not found');
    const answer = await checkAnswer('The cupboard count is still a question [1].\n<<<META\n{"sources":[{"id":1,"type":"transcript","time":"00:00","quote":"How many brass buttons are in the costume cupboard"}]}\nMETA>>>', f.roots, { pages: {} }, context.lines);
    assert.equal(answer.summary, '1/1 quotes found');
  } finally { await f.close(); }
});

test('transcript evidence: the stated time picks among repeats; text as heard and two-line quotes are kept exactly', () => {
  const line = (id: string, startMs: number, text: string, originalText = text) => ({ id, revision: 0, startMs, endMs: startMs + 5000, text, originalText, selected: false });
  const lines = [line('a', 16_000, 'the silver masks go in this crate'), line('b', 92_000, 'the seam ripper is missing', 'the steam ripper is missing'),
    line('c', 98_000, 'please hang the velvet capes'), line('d', 104_000, 'on padded wooden hangers tonight'), line('e', 360_000, 'the silver masks go in this crate')];
  const late = checkTranscriptSource({ id: 1, time: '06:00', quote: 'the silver masks go in this crate' }, lines);
  assert.equal(late.segmentId, 'e', 'repeated phrase: the one near the stated time');
  const heard = checkTranscriptSource({ id: 2, time: '01:32', quote: 'the steam ripper is missing' }, lines);
  assert.equal(heard.excerpt, 'the steam ripper is missing');
  assert.match(heard.detail!, /as originally heard/);
  const two = checkTranscriptSource({ id: 3, time: '01:38', quote: 'hang the velvet capes on padded wooden hangers' }, lines);
  assert.equal(two.excerpt, 'please hang the velvet capes on padded wooden hangers tonight');
  assert.match(checkTranscriptSource({ id: 4, time: '42:00', quote: 'the silver masks go in this crate' }, lines).detail!, /cited as 42:00/);
  const three = [line('x', 4_000, 'the red crate'), line('y', 5_000, 'has room for'), line('z', 6_000, 'another 13 felt hats')];
  assert.equal(checkTranscriptSource({ id: 5, time: 'Transcript [00:04–00:06]', quote: 'the red crate has room for another 13 felt hats' }, three).status, 'quote found', 'three short segments, time given as a range');
});

test('web evidence keeps the matched page text; per-page quota errors pause dispatch', async () => {
  const evidence = webEvidence([{ id: '1', name: 'fetch_content', args: { url: 'https://x.example/p' }, isError: false, text: 'summary',
    structured: { urls: [{ url: 'https://x.example/p', title: 'P', content: 'Intro. The repair counter opens at 14:35 on Tuesdays. Outro.', error: null }] } }]);
  assert.match(checkWebSource({ id: 1, url: 'https://x.example/p', quote: 'repair counter opens at 14:35' }, evidence).excerpt!, /opens at 14:35 on Tuesdays/);
  assert.equal(toolsFor('explain', false), 'read,grep,find,ls', 'without web tools, Explain uses the materials only');
  assert.equal(toolsFor('lookUp', true), 'web_search,fetch_content,get_search_content');

  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    const a = await jobs.submit(f.meeting.id, { action: 'lookUp', selection: { text: 'repair shop', segmentIds: [f.segments[4].id] } });
    await until(() => calls.length === 1);
    calls[0].release(result('Nothing found.\n<<<META\n{"sources":[]}\nMETA>>>', { toolResults: [{ id: '1', name: 'web_search', args: { query: 'q' }, isError: false, text: 'partial',
      structured: { queries: [{ query: 'q', error: 'HTTP 429: rate limit exceeded', results: [] }] } }] }));
    await until(() => jobs.get(a.job.id)!.state === 'done');
    assert.ok(jobs.paused('lookUp'), 'a quota error inside a successful search still pauses web actions');
    await jobs.close();
  } finally { await f.close(); }
});

test('the cooldown is shared: a model rate limit pauses every sol job, a web service throttle only the jobs waiting on the web', async () => {
  const f = await fixture();
  try {
    // A search service's 429: web actions wait, not local-only actions.
    const web = new Cooldowns();
    const folders: string[] = [];
    const first = scripted();
    const runner: ActionRunner = input => { folders.push(input.processDir); return first.runner(input); };
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots, cooldowns: web });
    const a = await jobs.submit(f.meeting.id, { action: 'lookUp', selection: { text: 'repair shop', segmentIds: [f.segments[4].id] } });
    await until(() => first.calls.length === 1);
    assert.equal(folders[0], join(f.directory, 'processes', a.job.id), "Pi and its scripts are recorded in the job's own process folder");
    first.calls[0].release(result('Nothing found.\n<<<META\n{"sources":[]}\nMETA>>>', { toolResults: [{ id: '1', name: 'web_search', args: { query: 'q' }, isError: false, text: 'partial',
      structured: { queries: [{ query: 'q', error: 'HTTP 429: rate limit exceeded', results: [] }] } }] }));
    await until(() => jobs.get(a.job.id)!.state === 'done');
    assert.ok(web.pausedUntil('web'));
    assert.equal(web.pausedUntil('model'), null, "a search service's 429 is not the model's quota");
    assert.ok(jobs.paused('lookUp'));
    assert.equal(jobs.paused('compute'), null);
    await jobs.close();

    // The model's rate limit in an action: the model's cooldown, which every sol job sharing it sees.
    const model = new Cooldowns();
    const second = scripted();
    const actions = new ActionJobs({ store: f.store, directory: f.directory, runner: second.runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots, cooldowns: model });
    const b = await actions.submit(f.meeting.id, { action: 'explain', selection: { text: LINES[0].slice(0, 12), segmentIds: [f.segments[0].id] } });
    await until(() => second.calls.length === 1);
    second.calls[0].release(result('', { stopReason: 'error', errorMessage: 'You have hit your usage limit (429).' }));
    await until(() => actions.get(b.job.id)!.state === 'failed');
    assert.ok(model.pausedUntil('model'));
    assert.equal(model.pausedUntil('web'), null);
    await actions.close();

    // Another job's rate limit (the notes, a plan run) pauses the actions for the same time.
    const shared = new Cooldowns();
    const third = scripted();
    const later = new ActionJobs({ store: f.store, directory: f.directory, runner: third.runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots, cooldowns: shared });
    shared.hit('model', 'notes');
    assert.equal(later.paused(), shared.pausedUntil('model'));
    const c = await later.submit(f.meeting.id, { action: 'explain', selection: { text: LINES[1].slice(0, 12), segmentIds: [f.segments[1].id] } });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(later.get(c.job.id)!.state, 'queued', 'dispatch waits for the shared cooldown');
    assert.equal(third.calls.length, 0);
    await later.close();
  } finally { await f.close(); }
});

test('a merged duplicate fails with the original when its record cannot be saved; follow-ups stop at the depth limit', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    await mkdir(join(f.directory, 'actions'), { recursive: true });
    await writeFile(join(f.directory, 'actions', f.meeting.id), 'not a folder');
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    const request = { action: 'explain', selection: { text: 'x y', segmentIds: [f.segments[0].id] } };
    const results = await Promise.allSettled([jobs.submit(f.meeting.id, request), jobs.submit(f.meeting.id, request)]);
    assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected'], 'no acknowledged job that does not exist');
    assert.equal(calls.length, 0);
    await jobs.close();
    await rm(join(f.directory, 'actions', f.meeting.id));

    const deep = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots });
    let parent = (await deep.submit(f.meeting.id, { action: 'explain', selection: { text: 'x', segmentIds: [f.segments[0].id] } })).job;
    for (let level = 0; level <= MAX_FOLLOW_UP_DEPTH; level++) {
      await until(() => calls.length === level + 1);
      calls[level].release(result('ok.\n<<<META\n{"sources":[]}\nMETA>>>'));
      await until(() => deep.get(parent.id)!.state === 'done');
      if (level === MAX_FOLLOW_UP_DEPTH) {
        await assert.rejects(deep.submit(f.meeting.id, { parentId: parent.id, prompt: `deeper ${level}` }), /levels deep at most/);
        break;
      }
      parent = (await deep.submit(f.meeting.id, { parentId: parent.id, prompt: `deeper ${level}` })).job;
    }
    await deep.close();
  } finally { await f.close(); }
});

test('evidence is located exactly: whole web quote, the right transcript line, all cited ranges', async () => {
  const page = `The repair counter opens by appointment. ${'Filler text about spare bobbins. '.repeat(30)}The repair counter opens at 14:35 on Tuesdays.`;
  const evidence = webEvidence([{ id: '1', name: 'fetch_content', args: { url: 'https://x.example/s' }, isError: false, text: '',
    structured: { urls: [{ url: 'https://x.example/s', title: 'S', content: page, error: null }] } }]);
  assert.match(checkWebSource({ id: 1, url: 'https://x.example/s', quote: 'The repair counter opens at 14:35 on Tuesdays' }, evidence).excerpt!, /opens at 14:35 on Tuesdays/,
    'a repeated first phrase does not pull the excerpt to the wrong passage');
  const line = (id: string, startMs: number, text: string) => ({ id, revision: 0, startMs, endMs: startMs + 5000, text, originalText: text, selected: false });
  const hit = checkTranscriptSource({ id: 1, time: '00:18', quote: 'the pedal cable needs a new plug' },
    [line('a', 18_000, 'opening remarks'), line('b', 156_000, 'the pedal cable needs a new plug')]);
  assert.equal(hit.segmentId, 'b', 'a neighbouring line is not glued on when one line holds the quote');
  assert.match(hit.detail!, /cited as 00:18, found at 02:36/);
  const f = await fixture();
  try {
    const wide = await checkFileSource({ id: 1, rootId: 'R1', path: 'inventory/stock.txt', lines: '1, 4', quote: 'Spare thread is stored in the green tin' }, f.roots);
    assert.equal(wide.ranges, '1, 4', 'the ranges themselves are kept, not their bounding interval');
  } finally { await f.close(); }
});

test('cancel while Python is being prepared releases the job without reaching the runner', async () => {
  const f = await fixture();
  try {
    const { runner, calls } = scripted();
    let warm!: () => void;
    const ready = new Promise<void>(r => { warm = r; });
    const jobs = new ActionJobs({ store: f.store, directory: f.directory, runner, clock: Date.now, glossaryFor: async () => null, rootsFor: () => f.roots, computeReady: () => ready });
    const c = await jobs.submit(f.meeting.id, { action: 'compute', selection: { text: 'How many brass buttons', segmentIds: [f.segments[0].id] } });
    await until(() => jobs.get(c.job.id)!.status[0] === 'Preparing the Python environment');
    await jobs.cancel(f.meeting.id, c.job.id);
    await until(() => jobs.get(c.job.id)!.state === 'cancelled');
    assert.equal(calls.length, 0, 'never reached the runner');
    warm();
    await jobs.close();
  } finally { await f.close(); }
});
