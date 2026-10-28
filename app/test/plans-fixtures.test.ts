import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtures, fixturesModule } from '../scripts/plans-fixtures-build.ts';
// @ts-expect-error a browser module (plain JS, no types)
import { fixturePlansApi } from '../public/plans-fixtures.js';

// The Plans page's fixtures (public/plans-fixtures.js and its data). Pi's review found that hand-made fixtures hid integration
// defects; these are made through the real domain and projection, and the fixture API's changes are checked against PlanTodos.

async function built() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-plans-fixtures-'));
  const fixtures = await buildFixtures(directory);
  return { ...fixtures, async close() { fixtures.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('the fixture data is what the real domain and projection give now (run scripts/plans-fixtures-build.ts after a change)', async () => {
  const b = await built();
  try {
    const committed = await readFile(new URL('../public/plans-fixtures-data.js', import.meta.url), 'utf8');
    assert.equal(committed, fixturesModule(b.data), 'public/plans-fixtures-data.js is out of date: run node --experimental-strip-types scripts/plans-fixtures-build.ts');
    assert.deepEqual(Object.keys(b.data), ['idle', 'running', 'waiting-recording', 'waiting-notes', 'waiting-quota', 'plans', 'replanning', 'mixed', 'nothing', 'all-failed',
      'stopped', 'closed', 'failed', 'stale', 'stale-materials', 'explored', 'explore-stopped', 'newer', 'refused', 'moved', 'no-project']);
  } finally { await b.close(); }
});

type Outcome = { status: number; code?: string; current?: unknown; result?: unknown; todo?: unknown };
/** What a route answers, as the page sees it: the status and code of a refusal, or the result and the step's state now. */
const outcome = (r: any): Outcome => r.status !== 200 ? { status: r.status, code: r.code, ...(r.current !== undefined ? { current: r.current } : {}) }
  : { status: 200, ...(r.result ? { result: { state: r.result.state, todo: r.result.todo, project: r.result.project, generation: r.result.generation, created: r.result.created, replayed: Boolean(r.result.replayed) } } : {}), todo: r.todo };
const failed = (e: any) => ({ status: e.status, code: e.code, current: e.current });

/** The same operations on the domain (as the routes call it) and on the fixture API of one state. */
async function both(b: Awaited<ReturnType<typeof built>>, state: string) {
  const s = b.states[state];
  const project = s.project?.id ?? null;
  const version = async (n: number) => (await s.world.all()).find(v => v.version === n)!;
  const api = fixturePlansApi(state, {}, { latency: false, quiet: true });
  const ops: Record<string, string> = {};
  const id = (name: string) => name === 'bad' ? 'bad' : (ops[name] ??= `contract-op-${name}-0001`);
  return {
    async add(n: number, step: string, expect: number, op: string) {
      const v = await version(n);
      const domain = await (async () => { try { const result = s.world.todos.accept(v, step, { opId: id(op), expect, project }); return { status: 200, result, todo: s.world.todos.states(v, project)[step] }; } catch (e) { return failed(e); } })();
      const fixture = await api.addTodo('m', n, step, { expect, opId: id(op) }).then((r: any) => ({ status: 200, ...r }), failed);
      return { domain: outcome(domain), fixture: outcome(fixture) };
    },
    async undo(n: number, step: string, op: string) {
      const v = await version(n);
      const expect = s.world.todos.states(v, project)[step].generation;
      const domain = await (async () => { try { s.world.todos.undo(v, step, { opId: id(op), expect, project }); return { status: 200, todo: s.world.todos.states(v, project)[step] }; } catch (e) { return failed(e); } })();
      const fixture = await api.undoTodo('m', n, step, { opId: id(op), expect }).then((r: any) => ({ status: 200, todo: r.todo }), failed);
      return { domain: outcome(domain), fixture: outcome(fixture) };
    },
  };
}

test('the fixture API keeps the domain\'s rules: once-only Add and Undo by operation id, generations, aliases, and every refusal', async () => {
  const b = await built();
  try {
    const plans = await both(b, 'plans');
    const steps: [string, () => Promise<{ domain: Outcome; fixture: Outcome }>, Partial<Outcome>][] = [
      ['add', () => plans.add(2, 'p2.s1', 0, 'A'), { status: 200 }],
      ['a double click', () => plans.add(2, 'p2.s1', 0, 'A'), { status: 200 }],
      ['another tab that saw generation 0', () => plans.add(2, 'p2.s1', 0, 'B'), { status: 409, code: 'generation' }],
      ['add on a step in to-dos', () => plans.add(2, 'p1.s1', 1, 'C'), { status: 200 }],
      ['an operation id used for another step', () => plans.add(2, 'p2.s2', 0, 'A'), { status: 409, code: 'op reused' }],
      ['undo', () => plans.undo(2, 'p2.s1', 'U'), { status: 200 }],
      ['undo, retried', () => plans.undo(2, 'p2.s1', 'U'), { status: 200 }],
      ['undo again', () => plans.undo(2, 'p2.s1', 'V'), { status: 409, code: 'not in to-dos' }],
      ['the first add, retried late', () => plans.add(2, 'p2.s1', 0, 'A'), { status: 200 }],
      ['add again after undo', () => plans.add(2, 'p2.s1', 1, 'D'), { status: 200 }],
      ['add on a step whose equal is in to-dos from another version', () => plans.add(2, 'p3.s1', 0, 'E'), { status: 200 }],
      ['add on the alias', () => plans.add(2, 'p3.s1', 1, 'F'), { status: 200 }],
      ['undo on the alias', () => plans.undo(2, 'p3.s1', 'W'), { status: 409, code: 'alias' }],
      ['add on a step undone before the page opened, stale', () => plans.add(2, 'p5.s1', 0, 'G'), { status: 409, code: 'generation' }],
      ['add on a step undone before the page opened', () => plans.add(2, 'p5.s1', 1, 'H'), { status: 200 }],
      ['no such step', () => plans.add(2, 'p9.s1', 0, 'I'), { status: 404, code: 'no step' }],
      ['no operation id', () => plans.add(2, 'p1.s1', 1, 'bad'), { status: 400, code: 'bad request' }],
    ];
    const refused = await both(b, 'refused');
    const mixed = await both(b, 'mixed');
    const none = await both(b, 'no-project');
    steps.push(
      ['a step over 600 characters', () => refused.add(1, 'p2.s1', 0, 'J'), { status: 413, code: 'too long' }],
      ['an unchecked step', () => mixed.add(1, 'p2.s1', 0, 'K'), { status: 409, code: 'unchecked' }],
      ['no project', () => none.add(1, 'p1.s1', 0, 'L'), { status: 400, code: 'no project' }],
    );
    for (const [what, run, expected] of steps) {
      const { domain, fixture } = await run();
      assert.deepEqual(fixture, domain, what);
      for (const [key, value] of Object.entries(expected)) assert.equal(domain[key as keyof Outcome], value, `${what}: ${key}`);
    }
  } finally { await b.close(); }
  // Plans made in another project, in a world of their own (the main meeting's, unchanged).
  const c = await built();
  try {
    const moved = await both(c, 'moved');
    for (const [what, run, status] of [['another project', () => moved.add(2, 'p2.s1', 0, 'M'), 409], ['a to-do added before the move', () => moved.add(2, 'p1.s1', 1, 'N'), 200]] as const) {
      const { domain, fixture } = await run();
      assert.deepEqual(fixture, domain, what);
      assert.equal(domain.status, status, what);
    }
  } finally { await c.close(); }
});

test('fixture runs publish contract-shaped history and preserve to-do deduplication; Cancel is repeatable', async () => {
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  try {
    const running = fixturePlansApi('running', {}, { latency: false, quiet: true });
    const run = (await running.getPlans()).run;
    assert.equal((await running.cancel('m', run.id)).run.state, 'cancelled');
    assert.equal((await running.cancel('m', run.id)).run.state, 'cancelled');
    const api = fixturePlansApi('idle', {}, { latency: false, quiet: true });
    await api.startPlan('m', { opId: 'fixture-run-0001' });
    time += 7000;
    const first = (await api.getPlans()).current;
    assert.equal(first.version, 1);
    assert.ok(first.plans.every((p: any) => p.evidence.every((id: string) => first.evidence[id] && id.startsWith(`${first.run}:`))));
    const added = await api.addTodo('m', 1, 'p2.s1', { expect: 0, opId: 'fixture-add-0001' });
    await api.startPlan('m', { opId: 'fixture-run-0002' });
    time += 7000;
    const second = (await api.getPlans()).current;
    assert.equal(second.version, 2);
    assert.equal(second.plans[1].steps[0].todo.state, 'already in to-dos');
    const alias = await api.addTodo('m', 2, 'p2.s1', { expect: 0, opId: 'fixture-alias-0001' });
    assert.deepEqual([alias.result.created, alias.result.todo], [false, added.result.todo]);
    await api.undoTodo('m', 1, 'p2.s1', { opId: 'fixture-undo-0001', expect: 1 });
    const replay = await api.addTodo('m', 1, 'p2.s1', { expect: 0, opId: 'fixture-add-0001' });
    assert.deepEqual([replay.result.replayed, replay.todo.state, replay.todo.generation], [true, 'add', 1]);
    assert.deepEqual((await api.getPlans()).current.plans[1].steps[0].todo, { state: 'add', generation: 1 });
  } finally { Date.now = now; }
});

test('fixture historical versions share payload acceptances: alias creation, Undo, replay after Undo and re-add', async () => {
  const b = await built();
  try {
    const plans = await both(b, 'plans');
    for (const [what, operation] of [
      ['old version Add', () => plans.add(1, 'p2.s1', 0, 'old')],
      ['new version aliases the payload', () => plans.add(2, 'p2.s1', 0, 'alias')],
      ['alias cannot Undo', () => plans.undo(2, 'p2.s1', 'alias-undo')],
      ['Undo from the original version', () => plans.undo(1, 'p2.s1', 'old-undo')],
      ['a replay on the alias adds nothing', () => plans.add(2, 'p2.s1', 0, 'alias')],
      ['a new operation at the alias generation', () => plans.add(2, 'p2.s1', 1, 'new')],
      ['an operation finding a standing to-do', () => plans.add(2, 'p2.s1', 2, 'standing')],
      ['Undo it', () => plans.undo(2, 'p2.s1', 'new-undo')],
      ['that standing operation cannot resurrect it', () => plans.add(2, 'p2.s1', 2, 'standing')],
    ] as const) {
      const { domain, fixture } = await operation();
      assert.deepEqual(fixture, domain, what);
    }
  } finally { await b.close(); }
});
