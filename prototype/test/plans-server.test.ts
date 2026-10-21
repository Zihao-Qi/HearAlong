import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { MeetingStore } from '../src/store.ts';
import { EXPLORATION_LIMITS } from '../src/explorations.ts';
import type { PiTaskOptions, PiTaskResult } from '../src/pi-task.ts';
import { EXPLORE_PROMPT, PLAN_PROMPT, PlanVersions, loadRunPlans, type PlansPage } from '../src/plans/index.ts';
import type { Recognition } from '../src/recognizer.ts';

// The Plans routes (M7b §2b, §4) against the real server, with a fake Pi: it streams one read of the materials and answers with
// plans as the model writes them. No model is called. Invented content only.
EXPLORATION_LIMITS.pollMs = 20;
EXPLORATION_LIMITS.stopGraceMs = 300;

const LINES = [
  'The carpet cleaners arrive at noon, so where can the library robot dock?',
  'Oriel will bag the worn caster and leave it on the repair bench.',
  'Keep the public charging station unplugged while the carpet is damp.',
];
const MATERIAL = Array.from({ length: 30 }, (_, i) => `Maintenance ledger entry ${i + 1}: a cupboard was checked and its key returned.`);
MATERIAL[11] = 'Park the library robot in the tiled returns alcove until the carpet is dry.';
const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
const item = (text: string, n: number) => ({ text, cites: [`S${n}`], quote: LINES[n - 1].split(' ').slice(0, 8).join(' ') });
const NOTES = JSON.stringify({
  title: 'Library robot service window',
  summary: [item('The public charger stays unplugged until the carpet dries.', 3)], decisions: [],
  actions: [{ ...item('Bag the worn caster and place it on the repair bench', 2), owner: 'Oriel', ownerQuote: 'Oriel will bag the worn caster and leave it on the repair bench' }],
  openQuestions: [item('Where should the robot dock during carpet cleaning?', 1)], otherMatters: [], otherTalk: [],
});

/** Model-shaped plans: a temporary dock, a sourced caster task for Oriel, and an overlength inventory task. */
function answer(over: { long?: boolean; step?: string; further?: boolean } = {}) {
  return { plans: [
    { label: 'Temporary robot dock', answerLine: 'Use the tiled returns alcove', stepLine: 'Mark a docking square in the returns alcove', question: 'Where should the robot dock during carpet cleaning?', from: ['N1', 'S1'],
      stateNow: [{ id: 'k1', text: 'The service ledger designates the tiled alcove as temporary parking', source: { type: 'file', path: 'R1/plan.md', line: 12, quote: 'park the library robot in the tiled returns alcove until the carpet is dry' } }],
      answer: { text: 'In the tiled returns alcove until the carpet dries', complete: true, open: null, basis: ['k1'] },
      next: { text: over.step ?? 'Tape a temporary docking square in the returns alcove', basis: ['k1'] },
      followOn: [{ if: 'the returns alcove is occupied', then: 'Switch off the robot and park it behind the service desk', basis: ['k1'] }], changeIf: 'The returns chute needs emergency access', checks: [], waitingOn: [], decideAfter: [],
      further: over.further === false ? null : { state: 'ready', what: 'Measure the clearance beside the returns chute', why: 'the book trolley must pass without touching the robot', minutes: 10 } },
    { label: 'Worn caster', answerLine: null, stepLine: 'Label the caster bag for the repair bench', question: 'How will the worn caster reach the repair bench?', from: ['N2'],
      stateNow: [{ id: 'k2', text: 'Oriel is transferring the worn caster to the repair bench', source: { type: 'transcript', ref: 'S2', quote: 'Oriel will bag the worn caster and leave it on the repair bench' } }],
      answer: null, next: { text: 'Label the caster bag with the robot inventory number before leaving it on the bench', basis: ['k2'] }, followOn: [], changeIf: null, checks: [], waitingOn: [], decideAfter: [], further: null },
    ...(over.long === false ? [] : [{ label: 'Cupboard inventory', answerLine: null, stepLine: 'Catalogue the repair cupboard', question: 'What supplies remain in the repair cupboard?', from: ['N1'],
      stateNow: [], answer: null, next: { text: `Catalogue ${'each drawer of washers, bolts, spare wheels and cable clips; '.repeat(16)}`, basis: [] }, followOn: [], changeIf: null, checks: [], waitingOn: [], decideAfter: [], further: null }]),
  ], deferred: [] };
}

type Script = { answer?: unknown; text?: string; gate?: Promise<unknown> };
async function setup(meetings = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-plans-server-'));
  const materials = await realpath(await mkdtemp(join(tmpdir(), 'meeting-plans-mat-')));
  await writeFile(join(materials, 'plan.md'), MATERIAL.join('\n'));
  const ids: string[] = [];
  {
    const store = new MeetingStore(directory);
    for (let m = 0; m < meetings; m++) {
      const meeting = store.createMeeting(`Library robot service window ${m + 1}`);
      ids.push(meeting.id);
      for (const [i, line] of LINES.entries()) store.completeChunk((await store.addPcm(meeting.id, 'mic:t', i, i * 30_000, 16000, Buffer.alloc(16000 * 4, i + 1))).id, recognition(line));
    }
    store.close();
  }
  const scripts: Script[] = [];
  const calls: { prompt: string; options: PiTaskOptions; input: string }[] = [];
  let notesGate: Promise<unknown> | null = null;
  const plans = async (prompt: string, options: PiTaskOptions): Promise<PiTaskResult> => {
    const input = await readFile(options.files![0], 'utf8');
    calls.push({ prompt, options, input });
    const script = scripts.shift() ?? {};
    const file = join(materials, 'plan.md');
    options.onEvent?.({ type: 'tool_execution_start', toolCallId: `c-${calls.length}`, toolName: 'read', args: { path: file, offset: 1, limit: 30 } });
    options.onEvent?.({ type: 'tool_execution_end', toolCallId: `c-${calls.length}`, toolName: 'read', isError: false, result: { content: [{ type: 'text', text: MATERIAL.join('\n') }] } });
    if (script.gate) {
      await Promise.race([script.gate, new Promise((_, reject) => {
        const stop = () => reject(Object.assign(new Error('Pi task was cancelled.'), { reason: 'cancelled' }));
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
      })]);
    }
    return { text: script.text ?? JSON.stringify(script.answer ?? answer()), ms: 1, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 2, toolResults: [] };
  };
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null,
    notes: async () => { const gate = notesGate; notesGate = null; if (gate) await gate; return { text: NOTES, model: 'scripted' }; }, plans });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 25)); }
  };
  const writeNotes = async (id: string) => {
    const before = (await call(`/api/meetings/${id}/notes`)).body.notes?.version ?? 0;
    assert.equal((await call(`/api/meetings/${id}/notes`, 'POST', {})).status, 202);
    await until(async () => ((await call(`/api/meetings/${id}/notes`)).body.notes?.version ?? 0) > before, 'the notes');
  };
  const page = async (id: string) => (await call(`/api/meetings/${id}/plans`)).body as PlansPage;
  /** A new project from the meeting; the materials are attached to it unless the meeting brings its own. */
  const intoProject = async (id: string, name = 'Library robot maintenance', attach = true) => {
    const project = (await call('/api/projects', 'POST', { name, repoPath: null, fromMeetingId: id })).body;
    if (attach) assert.equal((await call(`/api/meetings/${id}/materials`, 'POST', { path: materials, scope: 'project' })).status, 201);
    return project as { id: string; name: string };
  };
  /** Plan (or Plan again) through the route, and waits for the version it publishes. */
  const plan = async (id: string, script: Script = {}) => {
    const before = (await page(id)).current?.version ?? 0;
    scripts.push(script);
    const started = await call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(async () => ((await page(id)).current?.version ?? 0) > before, 'the plans');
    return started.body.run as PlansPage['run'] & {};
  };
  return { directory, materials, ids, app, call, until, page, plan, writeNotes, intoProject, scripts, calls, holdNotes: (gate: Promise<unknown>) => { notesGate = gate; },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); await rm(materials, { recursive: true, force: true }); } };
}
const op = () => `op-${randomUUID()}`;
const todo = (id: string, version: number, step: string) => `/api/meetings/${id}/plans/${version}/steps/${step}/todo`;
const undo = (id: string, version: number, step: string) => `/api/meetings/${id}/plans/${version}/steps/${step}/undo`;

test('Plan runs the plan pass as an exploration: pinned input, the frozen prompt and its limits, evidence, checks, a published version', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    await s.intoProject(id);
    assert.equal((await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() })).body.code, 'no notes');
    await s.writeNotes(id);
    const empty = await s.page(id);
    assert.deepEqual([empty.current, empty.run, empty.kept, empty.enabled, empty.notes?.version], [null, null, null, true, 1]);
    const opId = op();
    s.scripts.push({});
    const first = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId });
    assert.equal(first.status, 202);
    assert.deepEqual([first.body.run.kind, first.body.run.origin, first.body.run.limitMinutes, first.body.replayed], ['plan', 'manual', 5, false]);
    const again = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId });
    assert.deepEqual([again.status, again.body.run.id, again.body.replayed], [200, first.body.run.id, true], 'a repeated operation returns its run');
    await s.until(async () => (await s.page(id)).current?.version === 1, 'version 1');
    // Publishing the version precedes persisting the exploration's terminal state.
    await s.until(() => s.app.explorations.get(first.body.run.id)?.state === 'done', 'the published run to finish');
    const call = s.calls[0];
    assert.equal(call.prompt, PLAN_PROMPT);
    assert.equal(call.options.model, 'openai-codex/gpt-6.1-sol:low');
    assert.deepEqual([call.options.env?.RUN_PYTHON_MAX_RUNS, call.options.env?.RUN_PYTHON_MS], ['3', '60000']);
    assert.match(call.options.tools!, /^read,grep,find,ls,.*run_python$/);
    assert.match(call.input, /# Notes \(N-numbers\)\n## Open questions\nN1 Where should the robot dock during carpet cleaning\?/);
    const folder = join(s.directory, 'explorations', id, first.body.run.id);
    for (const file of ['job.json', 'input.md', 'evidence.json', 'plans.json', 'events.jsonl']) assert.ok(existsSync(join(folder, file)), file);
    assert.equal(existsSync(join(s.directory, 'scratch', 'explore', id, first.body.run.id, 'pdf-text')), false, 'the PDF view is removed');
    const view = await s.page(id);
    assert.equal(view.run, null, 'a run that published shows nothing more');
    const [p1, p2, p3] = view.current!.plans;
    assert.deepEqual([view.current!.version, view.current!.status, view.current!.addable, view.current!.freshness], [1, 'plans', null, null]);
    assert.deepEqual([p1.label, p1.answer?.check, p1.steps.map(st => [st.id, st.kind, st.check, st.todo?.state])],
      ['Temporary robot dock', 'checked', [['p1.s1', 'next', 'checked', 'add'], ['p1.s2', 'follow', 'checked', 'add']]]);
    assert.deepEqual([p1.origin.kind, p1.origin.version, p1.freshness.current, p1.evidence], ['plan', 1, true, [`${first.body.run.id}:k1`]]);
    assert.equal(view.current!.evidence[`${first.body.run.id}:k1`].result.ok, true);
    assert.equal(p2.owner, 'Oriel');
    assert.deepEqual([p3.steps[0].check, p3.steps[0].todo], ['proposal', { state: 'not eligible', generation: 0, reason: p3.steps[0].todo!.state === 'not eligible' ? p3.steps[0].todo!.reason : '', code: 'too long' }]);
  } finally { await s.close(); }
});

test('Add to to-dos, a replay, Undo, a delayed retry of the old operation, and Add again; refusals carry their code', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    const project = await s.intoProject(id);
    await s.writeNotes(id);
    await s.plan(id);
    const first = op();
    const added = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: first });
    assert.equal(added.status, 200);
    assert.deepEqual([added.body.result.state, added.body.result.created, added.body.result.generation, added.body.todo.state, added.body.todo.project], ['in to-dos', true, 1, 'in to-dos', project.id]);
    const memory = async () => (await s.call(`/api/projects/${project.id}/memory`)).body.items as { id: string; status: string; text: string; owner: string | null }[];
    assert.deepEqual((await memory()).map(i => [i.text, i.status]), [['Tape a temporary docking square in the returns alcove', 'open']]);
    const replay = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: first });
    assert.deepEqual([replay.body.result.replayed, replay.body.result.todo, replay.body.todo.state], [true, added.body.result.todo, 'in to-dos']);
    const stale = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: op() });
    assert.deepEqual([stale.status, stale.body.code, stale.body.current.state, stale.body.current.generation], [409, 'generation', 'in to-dos', 1], 'another tab that saw generation 0');
    assert.equal((await s.call(todo(id, 1, 'p2.s1'), 'POST', { expect: 0, opId: first })).body.code, 'op reused');
    // Undo, once, by its own operation id (a lost reply is retried with the same id).
    const undoOp = op();
    const undone = await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: undoOp });
    assert.deepEqual([undone.status, undone.body.todo], [200, { state: 'add', generation: 1 }]);
    const undoneAgain = await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: undoOp });
    assert.deepEqual([undoneAgain.status, undoneAgain.body.batch], [200, undone.body.batch], 'the retry returns the first result');
    assert.equal((await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: op() })).body.code, 'not in to-dos');
    const reusedUndo = await s.call(undo(id, 1, 'p2.s1'), 'POST', { expect: 0, opId: undoOp });
    assert.deepEqual([reusedUndo.status, reusedUndo.body.code, reusedUndo.body.status], [409, 'op reused', 409]);
    // The delayed retry of the first Add returns its old result and makes nothing; the page sees the state now.
    const late = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: first });
    assert.deepEqual([late.body.result.replayed, late.body.result.state, late.body.todo], [true, 'in to-dos', { state: 'add', generation: 1 }]);
    assert.deepEqual((await memory()).map(i => i.status), ['dropped']);
    const again = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: op() });
    assert.deepEqual([again.body.result.generation, again.body.result.created, again.body.todo.generation], [2, true, 2]);
    // A follow-on keeps its condition; the owner comes from the notes.
    const follow = await s.call(todo(id, 1, 'p1.s2'), 'POST', { expect: 0, opId: op() });
    const caster = await s.call(todo(id, 1, 'p2.s1'), 'POST', { expect: 0, opId: op() });
    const items = await memory();
    assert.equal(items.find(i => i.id === follow.body.result.todo)!.text, 'If the returns alcove is occupied: Switch off the robot and park it behind the service desk');
    assert.equal(items.find(i => i.id === caster.body.result.todo)!.owner, 'Oriel');
    const long = await s.call(todo(id, 1, 'p3.s1'), 'POST', { expect: 0, opId: op() });
    assert.deepEqual([long.status, long.body.code], [413, 'too long']);
    assert.match(long.body.error, /at most 600/);
    assert.deepEqual([(await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 1 })).status, (await s.call(todo(id, 9, 'p1.s1'), 'POST', { expect: 0, opId: op() })).body.code], [400, 'no version']);
    assert.deepEqual((await s.page(id)).current!.plans[0].steps[0].todo, { state: 'in to-dos', generation: 2, todo: again.body.result.todo, project: project.id });
    assert.deepEqual((await s.page(id)).current!.plans[0].freshness.current, true, 'its own to-dos do not make the plans out of date');
  } finally { await s.close(); }
});

test('two tabs adding equal steps of two versions make one to-do; the alias has no Undo of its own', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    const project = await s.intoProject(id);
    await s.writeNotes(id);
    await s.plan(id);
    await s.plan(id);
    // Tab A shows version 1, tab B version 2; both saw Add.
    const a = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: op() });
    const b = await s.call(todo(id, 2, 'p1.s1'), 'POST', { expect: 0, opId: op() });
    assert.deepEqual([b.body.result.state, b.body.result.todo, b.body.result.created, b.body.todo.state], ['already in to-dos', a.body.result.todo, false, 'already in to-dos']);
    assert.equal((await s.call(`/api/projects/${project.id}/memory`)).body.items.length, 1);
    assert.equal((await s.call(undo(id, 2, 'p1.s1'), 'POST', { expect: 1, opId: op() })).body.code, 'alias');
    assert.deepEqual((await s.page(id)).current!.plans[0].steps[0].todo, { state: 'already in to-dos', generation: 1, todo: a.body.result.todo, project: project.id });
  } finally { await s.close(); }
});

test('refusals: no project (400), then plans made with no project go to the new one; plans made in another project need Plan again', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    assert.equal((await s.call(`/api/meetings/${id}/materials`, 'POST', { path: s.materials })).status, 201);
    await s.writeNotes(id);
    await s.plan(id);
    const none = await s.page(id);
    assert.deepEqual([none.project, none.current!.addable, none.current!.plans[0].steps[0].todo], [null, { code: 'no project', madeIn: null },
      { state: 'not eligible', generation: 0, reason: 'Move this meeting to a project to add its steps to to-dos.', code: 'no project' }]);
    const refused = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: op() });
    assert.deepEqual([refused.status, refused.body.code], [400, 'no project']);
    const a = await s.intoProject(id, 'Project A', false);
    assert.equal((await s.page(id)).current!.addable, null, 'plans made with no project: into the current one');
    assert.equal((await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: op() })).body.result.project, a.id);
    await s.plan(id);
    const b = (await s.call('/api/projects', 'POST', { name: 'Project B', repoPath: null })).body;
    assert.equal((await s.call(`/api/meetings/${id}/project`, 'POST', { projectId: b.id })).status, 200);
    const moved = await s.page(id);
    assert.deepEqual(moved.current!.addable, { code: 'other project', madeIn: { id: a.id, name: 'Project A' } });
    assert.equal(moved.current!.plans[1].steps[0].todo!.state, 'not eligible');
    const other = await s.call(todo(id, 2, 'p2.s1'), 'POST', { expect: 0, opId: op() });
    assert.deepEqual([other.status, other.body.code], [409, 'other project']);
  } finally { await s.close(); }
});

test('a run that finishes after a newer version appeared keeps its plans aside; Cancel keeps the last plans; a failure is shown beside them', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    await s.intoProject(id);
    await s.writeNotes(id);
    const v1 = await s.plan(id);
    // Plan again; meanwhile another version is published (as by another server's run).
    let release!: () => void;
    s.scripts.push({ gate: new Promise<void>(r => { release = r; }) });
    const again = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    await s.until(async () => (await s.page(id)).run?.progress.files === 1, 'the run to read');
    const running = await s.page(id);
    assert.deepEqual([running.run!.progress.files, running.current!.version], [1, 1], 'progress from the stream; the plans stay meanwhile');
    assert.equal((await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() })).body.code, 'busy');
    const doc = (await loadRunPlans(join(s.directory, 'explorations', id, v1.id)))!;
    assert.ok('published' in await new PlanVersions(s.directory).publish(id, { ...doc, run: 'other-run', base: 1 }));
    release();
    await s.until(async () => Boolean((await s.page(id)).kept), 'the kept plans');
    const kept = await s.page(id);
    assert.deepEqual([kept.run, kept.current!.version, kept.kept!.version, kept.kept!.run, kept.kept!.newest?.version], [null, 2, null, again.body.run.id, 2]);
    assert.deepEqual(kept.kept!.plans[0].steps[0].todo, null, 'kept plans add nothing');
    // Cancel a running Plan again: the last plans stay, with the cancelled run's summary.
    s.scripts.push({ gate: new Promise(() => {}) });
    const cancelled = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    await s.until(async () => (await s.page(id)).run?.progress.files === 1, 'Pi to start');
    assert.equal((await s.call(`/api/meetings/${id}/plans/runs/${cancelled.body.run.id}/cancel`, 'POST', {})).status, 200);
    await s.until(async () => (await s.page(id)).run?.state === 'cancelled', 'the cancel');
    assert.deepEqual([(await s.page(id)).current!.version, (await s.page(id)).kept], [2, null]);
    // A failed run: shown with its error, beside the last good plans.
    s.scripts.push({ text: 'no plans here' });
    await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    await s.until(async () => (await s.page(id)).run?.state === 'failed', 'the failure');
    const failed = await s.page(id);
    assert.deepEqual([failed.run!.error, failed.current!.version], ["The model's answer could not be read as plans.", 2]);
  } finally { await s.close(); }
});

test('Explore further: only on a click, its own instruction after the frozen prompt, 20 minutes and 8 runs; the result replaces that plan', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    await s.intoProject(id);
    await s.writeNotes(id);
    const v1 = await s.plan(id);
    assert.equal(s.calls.length, 1, 'nothing explores by itself');
    assert.equal((await s.call(`/api/meetings/${id}/plans/1/plans/p2/explore`, 'POST', { opId: op() })).body.code, 'not ready');
    s.scripts.push({ answer: { plans: [answer({ step: 'Mark the alcove docking square with enough clearance for the book trolley', further: false }).plans[0]], deferred: [] } });
    const opId = op();
    const started = await s.call(`/api/meetings/${id}/plans/1/plans/p1/explore`, 'POST', { opId });
    assert.deepEqual([started.status, started.body.run.kind, started.body.run.plan, started.body.run.label, started.body.run.limitMinutes], [202, 'explore', 'p1', 'Temporary robot dock', 20]);
    assert.equal((await s.call(`/api/meetings/${id}/plans/1/plans/p1/explore`, 'POST', { opId })).body.replayed, true);
    await s.until(async () => (await s.page(id)).current?.version === 2, 'version 2');
    const call = s.calls[1];
    assert.ok(call.prompt.startsWith(`${PLAN_PROMPT}\n\n`) && call.prompt === EXPLORE_PROMPT, 'the frozen prompt, then the instruction for one plan');
    assert.deepEqual([call.options.model, call.options.env?.RUN_PYTHON_MAX_RUNS, call.options.env?.RUN_PYTHON_MS], ['openai-codex/gpt-6.1-sol:high', '8', '120000']);
    assert.match(call.input, /# The plan to explore further\nQuestion: Where should the robot dock during carpet cleaning\?/);
    assert.match(call.input, /Further \(this run's deliverable\): Measure the clearance beside the returns chute/);
    assert.equal(s.app.explorations.get(started.body.run.id)!.limitMs, 20 * 60_000);
    const view = await s.page(id);
    const [p1, p2] = view.current!.plans;
    assert.deepEqual([p1.id, p1.origin.run, p1.origin.kind, p1.earlier?.version, p1.earlier?.stepLine, p1.steps[0].text],
      ['p1', started.body.run.id, 'explore', 1, 'Mark a docking square in the returns alcove', 'Mark the alcove docking square with enough clearance for the book trolley']);
    assert.deepEqual([p2.origin.run, p2.origin.version, p2.origin.kind], [v1.id, 1, 'plan'], 'the other plans are carried over with their origin');
    assert.ok(p2.evidence.every(e => view.current!.evidence[e]), 'with their own evidence');
    const old = await s.call(`/api/meetings/${id}/plans/1/plans/p1/explore`, 'POST', { opId: op() });
    assert.deepEqual([old.status, old.body.code, old.body.current], [409, 'version', 2]);
  } finally { await s.close(); }
});

test('plans wait for the user’s work in another meeting, and concurrent submissions cannot queue competing runs for one meeting', async () => {
  const s = await setup(2);
  let release!: () => void;
  try {
    const [id, other] = s.ids;
    await s.intoProject(id);
    await s.writeNotes(id);
    await s.plan(id);
    s.holdNotes(new Promise<void>(r => { release = r; }));
    assert.equal((await s.call(`/api/meetings/${other}/notes`, 'POST', {})).status, 202);
    await s.until(async () => (await s.call(`/api/meetings/${other}/notes`)).body.job?.state === 'running', 'the other meeting’s notes');
    const submissions = await Promise.all([
      s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() }),
      s.call(`/api/meetings/${id}/plans/1/plans/p1/explore`, 'POST', { opId: op() }),
    ]);
    assert.deepEqual(submissions.map(r => r.status).sort(), [202, 409]);
    const page = await s.page(id);
    assert.deepEqual([page.run?.state, page.run?.waiting?.reason, s.calls.length], ['waiting', 'Waiting for the notes', 1]);
    assert.equal(s.app.explorations.list(id).filter(r => r.state === 'waiting').length, 1);
    release();
    await s.until(async () => (await s.page(id)).current?.version === 2, 'the waiting run');
  } finally { release?.(); await s.close(); }
});

test('Plan after the notes: off by default, saved per project; one automatic run per notes version; a manual Plan replaces a waiting one; off cancels only waiting automatic runs', async () => {
  const s = await setup(2);
  try {
    const [id, other] = s.ids;
    const project = await s.intoProject(id);
    assert.equal((await s.call('/api/projects')).body.projects[0].planAfterNotes, false, 'off by default');
    await s.writeNotes(id);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual([s.calls.length, (await s.page(id)).run], [0, null], 'off: notes start nothing');
    assert.equal((await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: 'yes' })).status, 400);
    const on = await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: true });
    assert.deepEqual([on.status, on.body.planAfterNotes, (await s.page(id)).project?.planAfterNotes], [200, true, true]);
    await s.writeNotes(id);
    await s.until(async () => (await s.page(id)).current?.version === 1, 'the automatic plans');
    assert.equal(s.calls.length, 1);
    const auto = s.app.explorations.list(id)[0];
    assert.deepEqual([(auto.data as any).origin, (auto.data as any).notesVersion], ['auto', 2]);
    // Another meeting's run holds the one slot, so the next automatic run waits.
    let free!: () => void;
    const blocker = await s.app.explorations.submit(other, { kind: 'plan', work: () => new Promise<void>(r => { free = r; }) });
    await s.writeNotes(id);
    await s.until(async () => (await s.page(id)).run?.state === 'waiting', 'a waiting automatic run');
    const waiting = (await s.page(id)).run!;
    assert.deepEqual([waiting.origin, waiting.waiting?.reason], ['auto', 'Waiting for another plan run to finish']);
    // The user's Plan replaces it.
    const manual = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    assert.equal(manual.status, 202);
    assert.equal(s.app.explorations.get(waiting.id)!.state, 'cancelled');
    assert.deepEqual([(await s.page(id)).run!.id, (await s.page(id)).run!.origin], [manual.body.run.id, 'manual']);
    // Turning the setting off leaves the user's run alone.
    assert.equal((await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: false })).body.planAfterNotes, false);
    assert.equal(s.app.explorations.get(manual.body.run.id)!.state, 'waiting');
    await s.call(`/api/meetings/${id}/plans/runs/${manual.body.run.id}/cancel`, 'POST', {});
    // On again, new notes: a waiting automatic run, which turning the setting off cancels.
    await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: true });
    await s.writeNotes(id);
    await s.until(async () => (await s.page(id)).run?.origin === 'auto', 'another automatic run');
    const second = (await s.page(id)).run!;
    await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: false });
    assert.equal(s.app.explorations.get(second.id)!.state, 'cancelled');
    free();
    await s.until(() => s.app.explorations.get(blocker.id)!.state === 'done', 'the other meeting\'s run');
    assert.equal(s.calls.length, 1, 'nothing more ran');
  } finally { await s.close(); }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

test('stale Undo cannot remove a newer generation; a lost Undo reply replays before generation eligibility', async () => {
  const s = await setup();
  try {
    const [id] = s.ids;
    const project = await s.intoProject(id);
    await s.writeNotes(id); await s.plan(id);
    await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 0, opId: op() });
    const lost = op();
    const first = await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: lost });
    const added = await s.call(todo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: op() });
    const stale = await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: op() });
    assert.deepEqual([stale.status, stale.body.code, stale.body.current], [409, 'generation', added.body.todo]);
    const replay = await s.call(undo(id, 1, 'p1.s1'), 'POST', { expect: 1, opId: lost });
    assert.deepEqual([replay.status, replay.body.batch, replay.body.todo], [200, first.body.batch, added.body.todo]);
    const items = (await s.call(`/api/projects/${project.id}/memory`)).body.items;
    assert.equal(items.find((i: any) => i.id === added.body.result.todo).status, 'open');
  } finally { await s.close(); }
});

for (const boundary of ['queue', 'directory read', 'after commit'] as const) test(`Cancel during publication: ${boundary}`, async () => {
  const s = await setup();
  const held = gate(), reached = gate();
  try {
    const [id] = s.ids;
    await s.intoProject(id); await s.writeNotes(id);
    const versions = (s.app.plans as any).options.versions as PlanVersions;
    if (boundary === 'queue') {
      (versions as any).chains.set(id, held.promise);
      const publish = versions.publish.bind(versions);
      versions.publish = (...args) => { reached.release(); return publish(...args); };
    } else if (boundary === 'directory read') {
      const list = versions.list.bind(versions);
      // Gate only publication's list, not the page or input reads.
      const publish = versions.publish.bind(versions);
      let publishing = false;
      versions.publish = (...args) => { publishing = true; return publish(...args); };
      versions.list = async meeting => {
        const result = await list(meeting);
        if (publishing) { publishing = false; reached.release(); await held.promise; }
        return result;
      };
    } else {
      const publish = versions.publish.bind(versions);
      versions.publish = async (...args) => {
        const result = await publish(...args);
        reached.release(); await held.promise;
        return result;
      };
    }
    const started = await s.call(`/api/meetings/${id}/plans/runs`, 'POST', { opId: op() });
    await reached.promise;
    await s.app.plans.cancel(id, started.body.run.id);
    held.release();
    await s.until(() => !['waiting', 'running'].includes(s.app.explorations.get(started.body.run.id)!.state), 'terminal publication');
    const job = s.app.explorations.get(started.body.run.id)!;
    assert.deepEqual([await versions.list(id), job.state, job.result], boundary === 'after commit'
      ? [[1], 'done', { outcome: 'published', version: 1 }] : [[], 'cancelled', null]);
  } finally { held.release(); await s.close(); }
});

test('automatic replacement rechecks setting after cancellation persistence', async () => {
  const s = await setup(2);
  const held = gate(), reached = gate(), block = gate();
  try {
    const [id, other] = s.ids;
    const project = await s.intoProject(id);
    await s.app.explorations.submit(other, { kind: 'plan', work: () => block.promise });
    await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: true });
    await s.writeNotes(id);
    await s.until(() => s.app.explorations.list(id).some(j => j.state === 'waiting'), 'old automatic run');
    const cancel = s.app.explorations.cancel.bind(s.app.explorations);
    s.app.explorations.cancel = async (...args) => {
      const job = await cancel(...args);
      reached.release(); await held.promise;
      return job;
    };
    const notesSaved = s.app.plans.notesSaved.bind(s.app.plans);
    let automatic!: Promise<unknown>;
    s.app.plans.notesSaved = meeting => (automatic = notesSaved(meeting)) as Promise<void>;
    await s.writeNotes(id);
    await reached.promise;
    const off = s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: false });
    await s.until(async () => (await s.page(id)).project?.planAfterNotes === false, 'setting saved off');
    held.release(); await off; await automatic;
    assert.equal(s.app.explorations.list(id).filter(j => j.state === 'waiting').length, 0);
  } finally { held.release(); block.release(); await s.close(); }
});

test('manual Plan and an automatic admission serialize: onManualPlan leaves only the manual run', async () => {
  const s = await setup(2);
  const held = gate(), reached = gate(), block = gate();
  try {
    const [id, other] = s.ids;
    const project = await s.intoProject(id);
    await s.writeNotes(id);
    await s.app.explorations.submit(other, { kind: 'plan', work: () => block.promise });
    await s.call(`/api/projects/${project.id}`, 'PATCH', { planAfterNotes: true });
    await s.writeNotes(id);
    await s.until(() => s.app.explorations.list(id).some(j => j.state === 'waiting'), 'old automatic run');
    const cancel = s.app.explorations.cancel.bind(s.app.explorations);
    s.app.explorations.cancel = async (...args) => {
      const job = await cancel(...args);
      reached.release(); await held.promise;
      return job;
    };
    const notesSaved = s.app.plans.notesSaved.bind(s.app.plans);
    let automatic!: Promise<unknown>;
    s.app.plans.notesSaved = meeting => (automatic = notesSaved(meeting)) as Promise<void>;
    await s.writeNotes(id);
    await reached.promise;
    const manual = s.app.plans.start(id, { opId: op() });
    // Without serialization the manual request can enter while automatic replacement awaits persistence.
    await new Promise(r => setTimeout(r, 30));
    held.release();
    const result = await manual;
    await automatic;
    const waiting = s.app.explorations.list(id).filter(j => j.state === 'waiting');
    assert.deepEqual(waiting.map(j => [j.id, (j.data as any).origin]), [[result.run.id, 'manual']]);
    const automaticRuns = s.app.explorations.list(id).filter(j => (j.data as any).origin === 'auto');
    assert.equal(automaticRuns.length, 2, 'the serialized automatic replacement is then superseded by onManualPlan');
    assert.ok(automaticRuns.every(j => j.state === 'cancelled'));
  } finally { held.release(); block.release(); await s.close(); }
});

test('submission opId lookup finds an unobserved cancelled or published run, even behind newer work', async () => {
  const s = await setup(2);
  const block = gate();
  try {
    const [id, other] = s.ids;
    await s.intoProject(id); await s.writeNotes(id); await s.plan(id);
    await s.app.explorations.submit(other, { kind: 'plan', work: () => block.promise });
    const opId = op();
    const submitted = await s.call(`/api/meetings/${id}/plans/1/plans/p1/explore`, 'POST', { opId });
    await s.app.plans.cancel(id, submitted.body.run.id);
    const cancelled = await s.call(`/api/meetings/${id}/plans/runs?opId=${opId}`);
    assert.deepEqual([cancelled.status, cancelled.body.run?.id, cancelled.body.run?.state], [200, submitted.body.run.id, 'cancelled']);
    assert.equal((await s.page(id)).run?.state, 'cancelled', 'cancelled summary remains visible');
    const next = await s.app.plans.start(id, { opId: op() });
    assert.notEqual(next.run.id, submitted.body.run.id);
    assert.equal((await s.call(`/api/meetings/${id}/plans/runs?opId=${opId}`)).body.run.state, 'cancelled');
    await s.app.plans.cancel(id, next.run.id);
    block.release();
    const publishedOp = op();
    const published = await s.app.plans.start(id, { opId: publishedOp });
    await s.until(() => s.app.explorations.get(published.run.id)?.state === 'done', 'published submission');
    assert.equal((await s.page(id)).run, null);
    assert.equal((await s.call(`/api/meetings/${id}/plans/runs?opId=${publishedOp}`)).body.run.outcome, 'published');
  } finally { block.release(); await s.close(); }
});
