// Fixture plans for M7b: loaded only with ?plans-fixture=<state>, never by default. The real domain and HTTP projection make
// the data (scripts/plans-fixtures-build.ts). This page-local API keeps historical versions, acceptance generations and batches
// too: retries, aliases, Undo and eligibility follow PlanTodos, including after a fixture run publishes a new version.
import { STATES, T0 } from './plans-fixtures-data.js';

export const FIXTURES = Object.keys(STATES);
const TIMES = new Set(['at', 'until', 'createdAt', 'startedAt', 'finishedAt']);
const OP = /^[\w:-]{8,100}$/;
const STATUS = { unchecked: 409, 'too long': 413, 'no project': 400, 'other project': 409 };
const RUN_MS = 6000;
const clone = value => structuredClone(value);
const httpError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const clean = text => text.replace(/\s+/g, ' ').trim();
const todoText = step => clean(step.kind === 'follow' && step.if ? `If ${step.if}: ${step.text}` : step.text);
const payload = (plan, step, project) => ({ question: plan.question, from: plan.fromItems.map(f => ({ section: f.section, text: f.text })), text: todoText(step), if: step.if, owner: plan.owner, project });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function shifted(value, by) {
  if (Array.isArray(value)) return value.map(v => shifted(v, by));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, TIMES.has(key) && typeof v === 'number' ? v + by : shifted(v, by)]));
}

/** ctx.segmentIds() connects fixture transcript evidence to the shown meeting. latency:false answers at once in tests. */
export function fixturePlansApi(name, ctx = {}, options = {}) {
  const fixture = STATES[name] ?? STATES.plans;
  if (!STATES[name] && options.quiet !== true) console.warn(`No plans fixture “${name}”; showing “plans”. Fixtures: ${FIXTURES.join(', ')}`);
  if (options.quiet !== true) console.info(`Plans: fixture data (“${STATES[name] ? name : 'plans'}”), not the server.`);
  const by = Date.now() - T0;
  const delay = ms => options.latency === false ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
  const page = shifted(clone(fixture.page), by);
  const extra = clone(fixture.extra);
  const versions = new Map(extra.history.map(d => [d.version, shifted(d, by)]));
  if (page.current) versions.set(page.current.version, page.current);
  const rows = extra.acceptances;
  const originProjects = extra.originProjects;
  const ops = new Map();
  const runs = new Map(page.run ? [[page.run.id, page.run]] : []);
  let nextTodo = extra.nextTodo, batches = 0, started = null, refused = false;
  const opCheck = (id, what) => { if (typeof id !== 'string' || !OP.test(id)) throw httpError(400, 'bad request', `${what} needs an operation id.`); };
  const active = () => ['waiting', 'running'].includes(page.run?.state) ? page.run : null;
  const latest = (version, step) => rows.filter(r => r.version === version && r.step === step).at(-1);
  const same = (p, version, step) => rows.find(r => r.active && !(r.version === version && r.step === step) && equal(r.payload, p));
  const find = (version, id) => {
    const doc = versions.get(version);
    if (!doc) throw httpError(404, 'no version', 'No such version of the plans.');
    for (const plan of doc.plans) for (const step of plan.steps) if (step.id === id) return { plan, step };
    throw httpError(404, 'no step', 'No such step in this version of the plans.');
  };
  function refusal(plan, step) {
    if (step.check === 'unchecked') return { code: 'unchecked', reason: 'This step\'s sources did not check out, so it cannot be added to to-dos.' };
    const length = todoText(step).length;
    if (length > 600) return { code: 'too long', reason: `This step is too long for a to-do (${length} characters; at most 600). Write the to-do yourself in the project.` };
    if (!page.project) return { code: 'no project', reason: 'Move this meeting to a project to add its steps to to-dos.' };
    const origin = originProjects[plan.origin.run];
    if (origin && origin !== page.project.id) return { code: 'other project', reason: 'These plans were made in another project. Plan again to add steps here.' };
    return null;
  }
  function state(version, plan, step) {
    const row = latest(version, step.id), generation = row?.generation ?? 0;
    const standing = r => ({ state: r.alias ? 'already in to-dos' : 'in to-dos', generation, todo: r.todo, project: r.project });
    if (row?.active) return standing(row);
    const no = refusal(plan, step);
    if (no) return { state: 'not eligible', generation, ...no };
    const match = same(payload(plan, step, page.project.id), version, step.id);
    return match ? { ...standing(match), state: 'already in to-dos' } : { state: 'add', generation };
  }
  function reconcile() {
    for (const [version, doc] of versions) for (const plan of doc.plans) for (const step of plan.steps) step.todo = state(version, plan, step);
  }
  const ready = allowAuto => {
    if (!page.enabled) throw httpError(400, 'cloud off', 'Planning needs the cloud models, which are off.');
    const run = active();
    if (run && !(allowAuto && run.state === 'waiting' && run.kind === 'plan' && run.origin === 'auto')) throw httpError(409, 'busy', 'Plans are being made for this meeting; try again when they are done.');
  };
  const replayRun = (kind, id) => {
    const previous = ops.get(id);
    if (previous && previous.kind !== kind) throw httpError(409, 'op reused', 'This operation id was already used for another request.');
    return previous ? { run: clone(previous.run), replayed: true } : null;
  };
  function start(kind, plan, opId) {
    const run = { id: crypto.randomUUID(), kind, origin: 'manual', state: 'waiting', plan: plan?.id ?? null, label: plan?.label ?? null,
      waiting: { reason: 'Waiting for the memory update' }, progress: { files: 0, pages: 0, checks: 0 }, createdAt: Date.now(), startedAt: null, finishedAt: null,
      limitMinutes: kind === 'explore' ? 20 : 5, stopped: null, error: null, outcome: null, message: null };
    if (active()) Object.assign(page.run, { state: 'cancelled', stopped: 'cancelled', finishedAt: Date.now(), waiting: null });
    page.run = run; page.kept = null;
    runs.set(run.id, run);
    started = { id: run.id, at: Date.now() };
    ops.set(opId, { kind, run });
    return { run: clone(run), replayed: false };
  }
  /** A fresh run qualifies its own registry ids; carried plans keep their original evidence and pins. */
  function reorigin(plans, evidence, run, version, at) {
    const remap = id => `${run.id}:${id.slice(id.indexOf(':') + 1)}`;
    const registry = Object.fromEntries(Object.entries(evidence).map(([id, e]) => [remap(id), { ...e, id: remap(id), run: run.id }]));
    originProjects[run.id] = page.project?.id ?? null;
    return { evidence: registry, plans: plans.map(p => ({ ...p, origin: { run: run.id, version, kind: run.kind, at, minutes: run.kind === 'explore' ? 1 : null },
      freshness: { current: true, changed: [], label: null }, stateNow: p.stateNow.map(remap), checks: p.checks.map(remap), evidence: p.evidence.map(remap),
      review: p.review.map(r => ({ ...r, item: evidence[r.item] ? remap(r.item) : r.item })),
      answer: p.answer ? { ...p.answer, basis: p.answer.basis.map(remap) } : null,
      steps: p.steps.map(s => ({ ...s, basis: s.basis.map(remap), todo: null })) })) };
  }
  function advance() {
    const run = active();
    if (!run || started?.id !== run.id) return;
    const t = Date.now() - started.at;
    if (run.state === 'waiting' && t > 1500) Object.assign(run, { state: 'running', waiting: null, startedAt: Date.now() });
    if (run.state === 'running') run.progress = { files: Math.min(9, Math.floor(t / 700)), pages: Math.min(3, Math.floor(t / 1900)), checks: t > 3500 ? 1 : 0 };
    if (t < RUN_MS) return;
    const before = page.current, version = (before?.version ?? 0) + 1, at = Date.now();
    if (run.kind === 'explore') {
      const old = before.plans.find(p => p.id === run.plan);
      const template = run.plan === 'p2' ? shifted(clone(STATES.explored.page.current), by) : clone(before);
      const revised = template.plans.find(p => p.id === run.plan);
      const fresh = reorigin([revised], Object.fromEntries(revised.evidence.map(id => [id, template.evidence[id]])), run, version, at);
      const plan = { ...fresh.plans[0], further: null, earlier: { version: before.version, at: old.origin.at, stepLine: old.stepLine, answerLine: old.answerLine } };
      page.current = { ...before, version, run: run.id, kind: 'explore', base: before.version, at,
        plans: before.plans.map(p => p.id === run.plan ? plan : clone(p)), evidence: { ...before.evidence, ...fresh.evidence } };
    } else {
      const template = shifted(clone(STATES.plans.page.current), by);
      const fresh = reorigin(template.plans, template.evidence, run, version, at);
      page.current = { ...template, ...fresh, version, run: run.id, kind: 'plan', base: before?.version ?? null, at, freshness: null,
        addable: page.project ? null : { code: 'no project', madeIn: null } };
    }
    const fresh = page.current.plans.map(p => p.freshness);
    page.current.freshness = fresh.length && fresh.every(f => !f.current && f.label === fresh[0].label) ? fresh[0] : null;
    const evidenceIds = new Set(page.current.plans.flatMap(p => p.evidence));
    page.current.evidence = Object.fromEntries(Object.entries(page.current.evidence).filter(([id]) => evidenceIds.has(id)));
    versions.set(version, page.current);
    Object.assign(run, { state: 'done', finishedAt: at, outcome: 'published' });
    page.run = null; page.kept = null; started = null;
    reconcile();
  }
  function resolved() {
    const result = clone(page), ids = ctx.segmentIds?.() ?? [];
    for (const doc of [result.current, result.kept]) for (const e of Object.values(doc?.evidence ?? {})) {
      if (e.source?.type === 'transcript') e.source.segmentId = ids[Number(String(e.source.segmentId).replace(/^seg/, '')) - 1] ?? null;
    }
    return result;
  }

  return {
    fixture: name,
    async getPlans() { await delay(40); advance(); reconcile(); return resolved(); },
    async getSubmission(_meetingId, opId) { const previous = ops.get(opId); return { run: previous?.run ? clone(previous.run) : null }; },
    async startPlan(_meetingId, { opId } = {}) {
      await delay(60); opCheck(opId, 'Plan');
      const previous = replayRun('plan', opId);
      if (previous) return previous;
      ready(true);
      if (!page.notes) throw httpError(400, 'no notes', 'Write the notes first: plans are made from them.');
      return start('plan', null, opId);
    },
    async cancel(_meetingId, runId) {
      await delay(60);
      const run = runs.get(runId);
      if (!run) throw httpError(404, 'not found', 'No such run.');
      if (['waiting', 'running'].includes(run.state)) Object.assign(run, { state: 'cancelled', stopped: 'cancelled', finishedAt: Date.now(), error: 'Cancelled.', waiting: null });
      if (page.run?.id === runId) { page.run = run; started = null; }
      return { run: clone(run) };
    },
    async exploreFurther(_meetingId, version, planId, { opId } = {}) {
      await delay(60); opCheck(opId, 'Explore further');
      const previous = replayRun('explore', opId);
      if (previous) return previous;
      ready(false);
      if (page.current?.version !== version) throw httpError(409, 'version', 'These plans changed since they were shown; explore the plans shown now.', { current: page.current?.version ?? null });
      const plan = page.current.plans.find(p => p.id === planId);
      if (!plan) throw httpError(404, 'no plan', 'No such plan in this version.');
      if (plan.further?.state !== 'ready') throw httpError(409, 'not ready', 'This plan has nothing ready to explore further.');
      return start('explore', plan, opId);
    },
    async addTodo(_meetingId, version, stepId, { expect, opId } = {}) {
      await delay(250); opCheck(opId, 'An Add to to-dos');
      if (!Number.isInteger(expect) || expect < 0) throw httpError(400, 'bad request', 'Say which generation of the step you saw.');
      const { plan, step } = find(version, stepId), key = `${version}:${stepId}`;
      const previous = ops.get(opId);
      if (previous) {
        if (previous.kind !== 'todo' || previous.key !== key) throw httpError(409, 'op reused', 'This operation id was already used for another step.');
        return { result: { ...clone(previous.result), replayed: true }, todo: state(version, plan, step) };
      }
      const row = latest(version, stepId), generation = row?.generation ?? 0;
      if (generation !== expect) throw httpError(409, 'generation', 'This step changed since you saw it.', { current: state(version, plan, step) });
      const done = result => { ops.set(opId, { kind: 'todo', key, result }); reconcile(); return { result: clone(result), todo: clone(step.todo) }; };
      if (row?.active) return done({ state: row.alias ? 'already in to-dos' : 'in to-dos', todo: row.todo, project: row.project, generation, batch: row.batch, created: false });
      if (extra.refuse?.step === stepId && !refused) {
        refused = true;
        Object.assign(page, shifted(clone(extra.after), by));
        versions.set(page.current.version, page.current);
        throw httpError(extra.refuse.status, extra.refuse.code, extra.refuse.error);
      }
      const no = refusal(plan, step);
      if (no) throw httpError(STATUS[no.code], no.code, no.reason);
      const p = payload(plan, step, page.project.id), match = same(p, version, stepId);
      const acceptance = { version, step: stepId, generation: generation + 1, payload: p, alias: Boolean(match), active: true,
        project: p.project, todo: match?.todo ?? `T-${nextTodo++}`, batch: match?.batch ?? `fixture-batch-${++batches}` };
      rows.push(acceptance);
      return done({ state: match ? 'already in to-dos' : 'in to-dos', todo: acceptance.todo, project: p.project, generation: acceptance.generation, batch: acceptance.batch, created: !match });
    },
    async undoTodo(_meetingId, version, stepId, { expect, opId } = {}) {
      await delay(120); opCheck(opId, 'An Undo');
      const { plan, step } = find(version, stepId), key = `${version}:${stepId}`, previous = ops.get(opId);
      if (previous) {
        if (previous.kind !== 'undo' || previous.key !== key) throw httpError(409, 'op reused', 'This request id was already used for a different change.');
        return { batch: previous.batch, todo: state(version, plan, step) };
      }
      const row = latest(version, stepId);
      if (!Number.isInteger(expect) || expect < 0) throw httpError(400, 'bad request', 'Say which generation of the step you saw.');
      if ((row?.generation ?? 0) !== expect) throw httpError(409, 'generation', 'This step changed since you saw it.', { current: state(version, plan, step) });
      if (!row?.active) throw httpError(409, 'not in to-dos', 'This step is not in to-dos.');
      if (row.alias) throw httpError(409, 'alias', `${row.todo} was added from another version of these plans; undo it there or in the project.`);
      for (const r of rows) if (r.batch === row.batch) r.active = false;
      const batch = `fixture-undo-${++batches}`;
      ops.set(opId, { kind: 'undo', key, batch });
      reconcile();
      return { batch, todo: clone(step.todo) };
    },
    async setPlanAfterNotes(projectId, on) {
      await delay(80);
      if (page.project?.id === projectId) page.project.planAfterNotes = Boolean(on);
      if (!on && active()?.origin === 'auto' && page.run.state === 'waiting') {
        Object.assign(page.run, { state: 'cancelled', stopped: 'cancelled', finishedAt: Date.now(), waiting: null });
        started = null;
      }
      return { id: projectId, planAfterNotes: Boolean(on) };
    },
  };
}
