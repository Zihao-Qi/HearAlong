import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { Projects } from '../src/projects.ts';
import { Memory } from '../src/memory.ts';
import { MemoryFiles } from '../src/memory-files.ts';
import { Proposals } from '../src/proposals.ts';
import { searchRoots } from '../src/materials.ts';
import { ActionJobs } from '../src/actions.ts';
import { Cooldowns } from '../src/quota.ts';
import { Explorations } from '../src/explorations.ts';
import { AutoPlanning } from '../src/plans/auto.ts';
import { PlanJobs } from '../src/plans/jobs.ts';
import { EvidenceRecorder, materialLocator } from '../src/plans/evidence.ts';
import { checkPlans } from '../src/plans/validate.ts';
import { fixture, notes, PINS, rawPlan, tool } from './plans-fixture.ts';

const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let n = 0; n < 500; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('condition did not become true');
};
async function domain() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'meeting-sweep2-')));
  const store = new MeetingStore(directory), projects = new Projects(store, directory), memory = new Memory(store);
  return { directory, store, projects, memory, close: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Pi 6: a repo validation await cannot overwrite a concurrent rename or planning setting', async () => {
  const f = await domain();
  try {
    const p = await f.projects.create('Before');
    const repo = f.projects.update(p.id, { repoPath: f.directory });
    await f.projects.update(p.id, { name: 'After', planAfterNotes: true });
    await repo;
    assert.deepEqual(f.projects.get(p.id), { ...p, name: 'After', planAfterNotes: true, repoPath: f.directory });
  } finally { await f.close(); }
});

test('Gemini 3: material folder and file roots through symlinks are searched with relative hit paths', async () => {
  const f = await domain();
  try {
    const actual = join(f.directory, 'actual'), alias = join(f.directory, 'alias');
    await mkdir(actual); await writeFile(join(actual, 'paper.md'), 'A unique sentinel phrase.'); await symlink(actual, alias);
    for (const kind of ['folder', 'file'] as const) {
      const result = await searchRoots([{ id: 'r', scope: 's', label: 'r', path: kind === 'folder' ? alias : join(alias, 'paper.md'), kind }], 'sentinel');
      assert.equal(result.scanned, 1);
      assert.equal(result.hits[0]?.file, 'paper.md');
    }
  } finally { await f.close(); }
});

test('Pi 3: truncated grep boundaries cannot manufacture quotes, including PDF wraps', async () => {
  const f = await fixture();
  try {
    const first = 'We use the unbiased estimator', second = 'for every trial in this study';
    await f.evidence.record(tool('grep', { path: f.file, pattern: 'estimator', context: 1 }, `${f.file}:1: ${first}... [truncated]\n${f.file}-2- ${second}`));
    const saved = await f.evidence.read();
    for (const pdf of [false, true]) {
      const evidence = structuredClone(saved);
      if (pdf) Object.assign(evidence.items[0], { pdf: { version: 'v', pageStarts: [1], generated: [] } });
      const check = (quote: string) => checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/notes/plan.md', line: 1, quote } }] })] }, { run: 'r', refs: f.input.refs, evidence, pins: PINS });
      const bad = check(`${first} ${second}`);
      assert.equal(bad.evidence['r:k1'].result.ok, false, `a ${pdf ? 'PDF' : 'text'} gap is not whitespace`);
      assert.equal(bad.plans[0].answer?.check, 'unchecked');
      assert.equal(bad.plans[0].steps[0].check, 'unchecked');
      assert.equal(check(first).evidence['r:k1'].result.ok, true, 'the visible prefix still counts');
      assert.equal(check(second).evidence['r:k1'].result.ok, true, 'the following line still counts');
      const whole = structuredClone(evidence); delete (whole.items[0] as any).cutLines;
      assert.equal(checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/notes/plan.md', line: 1, quote: `${first} ${second}` } }] })] }, { run: 'r', refs: f.input.refs, evidence: whole, pins: PINS }).evidence['r:k1'].result.ok, true);
    }
  } finally { await f.close(); }
});

test('Pi 4: pending memory captures are not plan evidence; app-written exports can be checked', async () => {
  const f = await domain();
  let files: MemoryFiles | undefined, proposals: Proposals | undefined;
  try {
    const p = await f.projects.create('P', f.directory);
    proposals = new Proposals(f.store, f.memory, { directory: f.directory, clock: Date.now, runner: null, projectOf: () => p.id, notesFor: async () => null });
    files = new MemoryFiles(f.store, f.memory, proposals, { directory: f.directory, clock: Date.now, project: () => p, projects: () => [p], meetingTitle: () => 'M', interpreter: null, guesser: null });
    f.memory.apply(p.id, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'create', type: 'decision', text: 'Use independent samples for every trial', source: { kind: 'app' } }] });
    await files.sync(p.id);
    const path = join(files.folder(p), 'decisions.md');
    const roots = [{ id: 'root', ref: 'R1', path: f.directory, kind: 'folder' as const, label: 'repo' }];
    const locate = materialLocator({ roots });
    const folder = join(f.directory, 'evidence'); await mkdir(folder);
    const record = async () => { const e = new EvidenceRecorder(folder, { cwd: f.directory, locate, eligible: (path, blocks) => files!.evidenceAllowed(path, blocks) }); await e.record(tool('read', { path }, await readFile(path, 'utf8'))); return e.read(); };
    assert.equal((await record()).items.length, 1, 'approved app-written content qualifies');
    const approved = await readFile(path, 'utf8');
    await writeFile(path, approved.replace('independent samples', 'correlated samples'));
    assert.equal((await record()).items.length, 0, 'an unscanned outside edit cannot qualify either');
    await files.sync(p.id);
    assert.equal(files.pendingCaptures(p.id).length, 1);
    const saved = await record();
    const input = notes();
    // Use the same citations/bases as the review scenario, including its answer and dependent next step.
    const result = checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 't', source: { type: 'file', path: 'R1/project-memory/decisions.md', line: 7, quote: 'Use correlated samples for every trial' } }] })] }, { run: 'r', refs: { notes: [{ ref: 'N1', section: 'openQuestions', text: input.notes.openQuestions[0].text, owner: null }], lines: [], roots } as any, pins: PINS, evidence: saved });
    assert.equal(result.evidence['r:k1'].result.ok, false);
    assert.equal(result.plans[0].answer?.check, 'unchecked'); assert.equal(result.plans[0].steps[0].check, 'unchecked');
    // A capture for different bytes cannot veto returned blocks matching an app-written export.
    await writeFile(path, approved); assert.equal((await record()).items.length, 1);
    files.dismissCapture(p.id, files.pendingCaptures(p.id)[0].id); await files.sync(p.id);
    assert.equal((await record()).items.length, 1);
  } finally { await files?.close(); await proposals?.close(); await f.close(); }
});

test('Gemini 1: a third automatic memory update queues and starts when either slot finishes', async () => {
  const f = await domain(), held = [gate(), gate(), gate()];
  const seen: string[] = [];
  const proposals = new Proposals(f.store, f.memory, { directory: f.directory, clock: Date.now, projectOf: () => 'p',
    notesFor: async id => ({ ...notes(), version: 1, meetingId: id, input: { inputHash: 'h' } }) as any,
    runner: async ({ cwd }) => { const id = cwd.split('/').at(-1)!; seen.push(id); await held[Number(id.slice(1)) - 1].promise; return { text: '{"results":[]}' } as any; } });
  try {
    await proposals.request('m1'); await proposals.request('m2'); await until(() => seen.length === 2);
    await proposals.request('m3');
    assert.equal(proposals.busy('m3'), true, 'queued updates also reserve their meeting');
    assert.deepEqual([...seen].sort(), ['m1', 'm2'], 'the two independent slots may reach the runner in either order');
    held[1].release(); await until(() => seen.includes('m3'));
    assert.equal(proposals.busy('m1'), true, 'the first slot is still running');
    held[0].release(); held[2].release(); await until(() => !['m1', 'm2', 'm3'].some(id => proposals.busy(id)));
    assert.equal(proposals.run('m3')?.state, 'done');
  } finally { held.forEach(h => h.release()); await proposals.close(); await f.close(); }
});

test('Gemini 2: early returns, submission errors and crash-torn claims do not consume an automatic attempt', async () => {
  const f = await domain();
  try {
    const m = f.store.createMeeting('M'), p = await f.projects.create('P'); f.projects.move(m.id, p.id, []);
    await f.projects.update(p.id, { planAfterNotes: true });
    const auto = new AutoPlanning(f.store);
    let version = 2, failSubmit = false;
    const jobs: any[] = [{ id: 'old', meetingId: m.id, kind: 'plan', key: 'plan', state: 'waiting', data: { origin: 'auto', notesVersion: 1 } }];
    const explorations = { list: () => jobs, cancel: async () => { jobs[0].state = 'cancelled'; await f.projects.update(p.id, { planAfterNotes: false }); },
      submit: async (_id: string, request: any) => { if (failSubmit) throw new Error('save failed'); const j = { id: `run-${version}`, meetingId: m.id, state: 'waiting', kind: 'plan', data: request.data }; jobs.push(j); return j; } };
    const options: any = { store: f.store, projects: f.projects, auto, enabled: true, final: () => true, explorations,
      notes: { file: () => ({ load: async () => ({ version }) }) } };
    let plans = new PlanJobs(options);
    await plans.notesSaved(m.id);
    assert.equal(auto.attempted(m.id, 2), false, 'setting changed during cancellation: no stranded claim');
    await f.projects.update(p.id, { planAfterNotes: true });
    failSubmit = true; await assert.rejects(plans.notesSaved(m.id), /save failed/);
    assert.equal(auto.attempted(m.id, 2), false, 'persistence error releases the claim');
    failSubmit = false; await plans.notesSaved(m.id);
    assert.equal(auto.attempts(m.id)[0].run, 'run-2');
    plans = new PlanJobs(options); await plans.notesSaved(m.id);
    assert.equal(jobs.filter(j => j.id === 'run-2').length, 1, 'restart never retries a version with a run');
    jobs.at(-1)!.state = 'done'; version = 3; auto.claim(m.id, version);
    plans = new PlanJobs(options); assert.equal(auto.attempted(m.id, version), false, 'crash before a run: release');
    auto.claim(m.id, version); jobs.push({ id: 'crash-run', kind: 'plan', state: 'interrupted', data: { origin: 'auto', notesVersion: version } });
    plans = new PlanJobs(options); assert.equal(auto.attempts(m.id).at(-1)!.run, 'crash-run', 'crash after persistence: reconcile the run');
    await plans.notesSaved(m.id); assert.equal(jobs.filter(j => j.data.notesVersion === version).length, 1);
  } finally { await f.close(); }
});

test('Gemini 4: only web-enabled explorations and actions wait for a web cooldown', async () => {
  const f = await domain(); let now = 1000;
  const cooldowns = new Cooldowns(() => now);
  let web = true;
  const explorations = new Explorations({ directory: f.directory, clock: () => now, cooldowns, usesWeb: () => web });
  const actions = new ActionJobs({ store: f.store, directory: f.directory, clock: () => now, cooldowns, runner: null, rootsFor: () => [], glossaryFor: async () => null, webAvailable: () => web });
  try {
    cooldowns.hit('web', 'test');
    const job = await explorations.submit('m1', { kind: 'plan', work: async () => 'done' });
    assert.equal(job.state, 'waiting'); assert.equal(explorations.waitingFor(job)?.until, cooldowns.pausedUntil('web'));
    for (const kind of ['answer', 'compute', 'findSource'] as const) assert.equal(actions.paused(kind), null, kind);
    assert.equal(actions.paused('explain'), cooldowns.pausedUntil('web'), 'Explain does have web tools');
    assert.equal(actions.paused('lookUp'), cooldowns.pausedUntil('web'));
    web = false; assert.equal(actions.paused('explain'), null); assert.equal(explorations.waitingFor(job), null);
    cooldowns.hit('model', 'test'); assert.equal(actions.paused('compute'), cooldowns.pausedUntil('model')); assert.equal(explorations.waitingFor(job)?.until, cooldowns.pausedUntil('model'));
    now += 1_000_000;
  } finally { await explorations.close(); await actions.close(); await f.close(); }
});

test('Gemini 4 dispatch: local actions can pass web actions waiting for cooldown', async () => {
  const f = await domain(), cooldowns = new Cooldowns();
  const actions = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, cooldowns, runner: null, rootsFor: () => [], glossaryFor: async () => null, webAvailable: () => true });
  const seen: string[] = [];
  try {
    cooldowns.hit('web', 'test');
    const internals = actions as any;
    internals.run = async (job: any) => { seen.push(job.id); job.state = 'done'; };
    for (const [id, action] of [['web-first', 'explain'], ['local', 'compute'], ['web-last', 'lookUp']]) {
      internals.jobs.set(id, { id, meetingId: 'm', action, origin: 'user', state: 'queued' }); internals.queue.push(id);
    }
    internals.dispatch();
    await until(() => seen.length > 0);
    assert.deepEqual(seen, ['local']);
    assert.equal(actions.get('web-first')!.state, 'queued');
    assert.equal(actions.get('web-last')!.state, 'queued');
  } finally { await actions.close(); await f.close(); }
});

test('Gemini 5: completed, failed and cancelled explorations remove scratch, not their run records', async () => {
  const f = await domain();
  const explorations = new Explorations({ directory: f.directory, clock: Date.now, cooldowns: new Cooldowns() });
  try {
    for (const outcome of ['done', 'failed', 'cancelled']) {
      let cwd = '';
      const reached = gate();
      const job = await explorations.submit(`m-${outcome}`, { kind: 'plan', work: async ctx => {
        cwd = ctx.cwd; await writeFile(join(cwd, 'run-1.py'), 'print(1)'); await writeFile(join(ctx.folder, 'result.md'), 'record'); reached.release();
        if (outcome === 'failed') throw new Error('failed');
        if (outcome === 'cancelled') await ctx.wait(new Promise(() => {}));
        return 'ok';
      } });
      await reached.promise;
      if (outcome === 'cancelled') await explorations.cancel(job.meetingId, job.id);
      await until(() => !['waiting', 'running'].includes(job.state));
      assert.equal(job.state, outcome); assert.equal(existsSync(cwd), false, outcome);
      assert.equal(await readFile(join(f.directory, 'explorations', job.meetingId, job.id, 'result.md'), 'utf8'), 'record');
    }
  } finally { await explorations.close(); await f.close(); }
});
