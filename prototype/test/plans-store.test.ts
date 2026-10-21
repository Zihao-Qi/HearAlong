import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingStore } from '../src/store.ts';
import { Memory } from '../src/memory.ts';
import { Proposals } from '../src/proposals.ts';
import { render } from '../src/memory-files.ts';
import {
  AutoPlanning, PlanTodos, PlanVersions, changedFiles, changedSinceRead, checkPlans, currentPins, planRows, freshness, loadRunPlans, materialsManifest, memoryStamp, onManualPlan, onNotes, onSettingOff,
  pinRun, plansDocument, saveRunPlans, type PlanPins, type PlansDocument, type PublishedVersion,
} from '../src/plans/index.ts';
import { stat, utimes, writeFile } from 'node:fs/promises';
import { PINS, fixture, rawPlan, readResult, type Fixture } from './plans-fixture.ts';

// Stored plans, versions, Add to to-dos and automatic planning (M7b §2b). No model; a real meetings database in a temp folder.
const P = 'project-a';
/** Two kiln handover plans: room access (k1) and Vesper's shelf photograph (k2). */
const twoPlans = (over: Record<string, unknown> = {}) => ({ plans: [
  rawPlan({ followOn: [{ if: 'the latch sticks', then: 'Keep the room locked and call the caretaker', basis: ['k1'] }], ...over }),
  rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], label: 'Shelf photograph', answer: null, answerLine: null, stepLine: 'Place a ruler beside the crack',
    stateNow: [{ id: 'k2', text: 'Vesper is documenting the damaged shelf', source: { type: 'transcript', ref: 'S2', quote: 'Vesper will photograph the cracked shelf before the caretaker arrives' } }],
    next: { text: 'Place a ruler beside the crack and photograph the entire shelf', basis: ['k2'] }, changeIf: 'The caretaker removes the shelf first' }),
] });
async function doc(f: Fixture, raw: unknown, meta: { run?: string; kind?: 'plan' | 'explore'; base?: number | null; plan?: string; pins?: Partial<PlanPins>; complete?: boolean } = {}): Promise<PlansDocument> {
  const pins = { ...PINS, ...meta.pins };
  const checked = checkPlans(raw, { run: meta.run ?? 'run1', refs: f.input.refs, evidence: await f.evidence.read(), pins });
  return plansDocument(checked, { kind: meta.kind ?? 'plan', base: meta.base ?? null, plan: meta.plan, createdAt: 1, finished: meta.complete ?? true, evidenceComplete: true,
    pins: { ...pins, materials: { roots: [], files: {}, complete: true, digest: pins.manifest } } });
}
async function setup() {
  const f = await fixture();
  await f.evidence.record(readResult(f.file, 5, 20));
  const store = new MeetingStore(f.folder);
  let now = 1000;
  const clock = () => now++;
  const memory = new Memory(store, clock);
  const versions = new PlanVersions(f.folder, clock);
  const todos = new PlanTodos(store, memory, clock);
  const publish = async (d: PlansDocument) => { const r = await versions.publish('m1', d); assert.ok('published' in r, JSON.stringify(r)); return r.published; };
  return { f, store, memory, versions, todos, publish, async close() { store.close(); await f.close(); } };
}
let ops = 0;
const op = () => `op-${String(++ops).padStart(6, '0')}`;

test('a run\'s plans.json keeps the schema, pins, registry and every plan field; publication is compare-and-swap', async () => {
  const s = await setup();
  try {
    const first = await doc(s.f, twoPlans());
    await saveRunPlans(s.f.run, first);
    const loaded = await loadRunPlans(s.f.run);
    assert.deepEqual(loaded, first);
    assert.equal(loaded!.schema, 1);
    assert.equal(loaded!.plans[1].changeIf, 'The caretaker removes the shelf first');
    assert.ok(loaded!.evidence['run1:k1'] && loaded!.evidence['run1:k2']);
    const v1 = await s.publish(first);
    assert.deepEqual([v1.version, v1.plans[0].origin], [1, { run: 'run1', version: 1 }]);
    assert.deepEqual(await s.versions.publish('m1', await doc(s.f, twoPlans(), { run: 'run2', base: null })), { conflict: { newest: 1 } }, 'based on no version, but one appeared');
    assert.match((await s.versions.publish('m1', await doc(s.f, twoPlans(), { run: 'run2', base: 1, complete: false })) as { refused: string }).refused, /did not complete/);
    // Two Plan again runs based on version 1 finish together: one publishes, the other is kept in the history.
    const [a, b] = await Promise.all([s.versions.publish('m1', await doc(s.f, twoPlans(), { run: 'run3', base: 1 })), s.versions.publish('m1', await doc(s.f, twoPlans(), { run: 'run4', base: 1 }))]);
    assert.ok('published' in a && a.published.version === 2);
    assert.deepEqual(b, { conflict: { newest: 2 } });
    assert.deepEqual(await s.versions.list('m1'), [1, 2]);
    assert.equal((await s.versions.latest('m1'))!.run, 'run3');
  } finally { await s.close(); }
});

test('Explore further replaces one plan; carried plans keep their origin, pins, evidence and every field; ids never collide', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    // The explore run uses its own k1 for a new version of p2, made after the notes changed.
    const explored = rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], label: 'Shelf photograph', answer: null,
      stateNow: [{ id: 'k1', text: 'Vesper needs an unobstructed view of the crack', source: { type: 'transcript', ref: 'S2', quote: 'Vesper will photograph the cracked shelf before the caretaker arrives' } }],
      next: { text: 'Photograph both faces of the shelf with a ruler and its inventory tag visible', basis: ['k1'] }, changeIf: 'The inventory tag is missing' });
    const v2 = await s.publish(await doc(s.f, { plans: [explored] }, { run: 'run2', kind: 'explore', base: 1, plan: 'p2', pins: { notesVersion: 2 } }));
    const [carried, fresh] = v2.plans;
    assert.deepEqual(carried, v1.plans[0], 'p1 carried over unchanged');
    assert.deepEqual(carried.origin, { run: 'run1', version: 1 });
    assert.equal(carried.changeIf, 'A red fault light on the latch');
    assert.deepEqual([fresh.id, fresh.origin, fresh.originPins.notesVersion, fresh.steps[0].id], ['p2', { run: 'run2', version: 2 }, 2, 'p2.s1']);
    assert.deepEqual(fresh.steps[0].basis, ['run2:k1']);
    assert.deepEqual(Object.keys(v2.evidence).sort(), ['run1:k1', 'run2:k1'], 'the old p2\'s evidence goes with it; p1\'s stays');
    assert.equal(v2.evidence['run2:k1'].plan, 'p2');
    assert.deepEqual(v2.evidence['run1:k1'], v1.evidence['run1:k1']);
    // Freshness is per plan: exploring p2 after the notes changed does not make p1 look current.
    const now = { notesVersion: 2, memoryStamp: 'm1', manifest: 'digest-1' };
    assert.equal(freshness(carried, now).label, 'Made before the notes changed');
    assert.equal(freshness(fresh, now).current, true);
    assert.equal(freshness(fresh, { notesVersion: 3, memoryStamp: 'm2', manifest: 'digest-2' }).label, 'Made before the notes, the memory and the materials changed');
    // A second exploration based on version 1 finishes later: a newer version exists, nothing changes.
    assert.deepEqual(await s.versions.publish('m1', await doc(s.f, { plans: [explored] }, { run: 'run3', kind: 'explore', base: 1, plan: 'p1' })), { conflict: { newest: 2 } });
    assert.match((await s.versions.publish('m1', await doc(s.f, { plans: [] }, { run: 'run4', kind: 'explore', base: 2, plan: 'p1' })) as { refused: string }).refused, /no plan that passed/);
    assert.match((await s.versions.publish('m1', await doc(s.f, { plans: [explored] }, { run: 'run5', kind: 'explore', base: 2, plan: 'p9' })) as { refused: string }).refused, /not in its version/);
  } finally { await s.close(); }
});

test('the pins: the materials manifest per root and file (its digest changes with a file), the memory stamp, the notes and their warnings', async () => {
  const s = await setup();
  try {
    const roots = s.f.input.refs.roots;
    const before = await materialsManifest(roots);
    assert.deepEqual(Object.keys(before.files), ['R1/notes/plan.md']);
    assert.equal((await materialsManifest(roots)).digest, before.digest);
    await writeFile(s.f.file, 'changed text of another length');
    const after = await materialsManifest(roots);
    assert.notEqual(after.digest, before.digest);
    assert.deepEqual([...changedFiles(before, after)], ['R1/notes/plan.md']);
    const coverage = { untilMs: 0, chunks: 1, pendingChunks: 2, gaps: [], uncorrected: 0 };
    const pins = await pinRun({ notes: { version: 3, input: { inputHash: 'h', coverage, glossaryVersion: null, segments: 3, takenAt: 0 } }, stale: true,
      project: P, memory: s.memory, roots });
    assert.deepEqual([pins.notesVersion, pins.project, pins.manifest, pins.memoryStamp], [3, P, after.digest, memoryStamp(s.memory, P)]);
    assert.deepEqual(pins.notesWarnings, ['The transcript changed after the notes were written.', '2 audio chunk(s) were still being transcribed when the notes were written.']);
    assert.equal((await pinRun({ notes: { version: 3, input: { inputHash: 'h', coverage, glossaryVersion: null, segments: 3, takenAt: 0 } }, project: null, memory: s.memory, roots })).memoryStamp, null);
  } finally { await s.close(); }
});

test('Add to to-dos makes one sourced to-do; a repeated operation returns its first result; a second tab gets the state', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    assert.deepEqual(s.todos.states(v1, P)['p1.s1'], { state: 'add', generation: 0 });
    const opId = op();
    const added = s.todos.accept(v1, 'p1.s1', { opId, expect: 0, project: P });
    assert.deepEqual([added.state, added.todo, added.generation, added.created], ['in to-dos', 'T-1', 1, true]);
    const item = s.memory.item(P, 'T-1')!;
    assert.deepEqual([item.text, item.owner, item.confirmed], ['Hang the green access card beside the kiln room door', null, true]);
    const source = s.memory.timeline(P, 'T-1')[0].source;
    assert.deepEqual(source && source.kind === 'plan' && [source.meetingId, source.run, source.version, source.step], ['m1', 'run1', 1, 'p1.s1']);
    assert.deepEqual(s.todos.accept(v1, 'p1.s1', { opId, expect: 0, project: P }), { ...added, replayed: true }, 'a double click');
    assert.equal(s.memory.items(P).length, 1);
    assert.throws(() => s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P }), (e: Error & { status?: number; current?: unknown }) =>
      e.status === 409 && (e.current as { state: string }).state === 'in to-dos', 'another tab that saw generation 0');
    assert.throws(() => s.todos.accept(v1, 'p2.s1', { opId, expect: 0, project: P }), /already used for another step/);
    assert.deepEqual(s.todos.states(v1, P)['p1.s1'], { state: 'in to-dos', generation: 1, todo: 'T-1', project: P });
    // The history renders the source as the plans of the meeting, never as a meeting note.
    const files = render(s.memory, P, 2000, () => 'Kiln room handover');
    assert.match(Object.entries(files).find(([k]) => k.startsWith('history/'))![1], /T-1 created: .* · from the plans of "Kiln room handover" · by the user/);
  } finally { await s.close(); }
});

test('Undo, then a delayed retry of the old operation changes nothing; only a new operation against the undone generation adds again', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    const first = op();
    const added = s.todos.accept(v1, 'p1.s1', { opId: first, expect: 0, project: P });
    const undoOp = op();
    s.todos.undo(v1, 'p1.s1', { opId: undoOp, expect: 1, project: P });
    s.todos.undo(v1, 'p1.s1', { opId: undoOp, expect: 1, project: P }); // repeated: the first result
    assert.deepEqual([s.memory.item(P, 'T-1')!.status, s.memory.item(P, 'T-1')!.fields.reason], ['dropped', 'undone']);
    assert.deepEqual(s.todos.states(v1, P)['p1.s1'], { state: 'add', generation: 1 }, 'Add to to-dos again');
    assert.throws(() => s.todos.undo(v1, 'p1.s1', { opId: op(), expect: 1, project: P }), /not in to-dos/);
    const retry = s.todos.accept(v1, 'p1.s1', { opId: first, expect: 0, project: P });
    assert.deepEqual(retry, { ...added, replayed: true }, 'the old, undone result');
    assert.equal(s.memory.items(P).length, 1, 'nothing created');
    assert.equal(s.memory.item(P, 'T-1')!.status, 'dropped');
    assert.throws(() => s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P }), (e: Error & { status?: number }) => e.status === 409, 'a stale page');
    const again = s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 1, project: P });
    assert.deepEqual([again.todo, again.generation, again.created], ['T-2', 2, true]);
    assert.deepEqual(s.todos.states(v1, P)['p1.s1'], { state: 'in to-dos', generation: 2, todo: 'T-2', project: P });
  } finally { await s.close(); }
});

test('every successful operation is replay-safe: one that found the to-do already there does nothing on a retry after Undo', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P });
    // Another tab saw generation 1 and pressed Add: nothing to make, but its operation is recorded with its result.
    const b = op();
    const noop = s.todos.accept(v1, 'p1.s1', { opId: b, expect: 1, project: P });
    assert.deepEqual([noop.state, noop.todo, noop.generation, noop.created], ['in to-dos', 'T-1', 1, false]);
    s.todos.undo(v1, 'p1.s1', { opId: op(), expect: 1, project: P });
    const retry = s.todos.accept(v1, 'p1.s1', { opId: b, expect: 1, project: P });
    assert.deepEqual(retry, { ...noop, replayed: true }, 'the retry returns its first result');
    assert.equal(s.memory.items(P).length, 1, 'and does not undo the Undo');
    assert.equal(s.memory.item(P, 'T-1')!.status, 'dropped');
    // A reuse (an alias) is replay-safe too.
    const v2 = await s.publish(await doc(s.f, twoPlans(), { run: 'run2', base: 1 }));
    const fresh = s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 1, project: P });
    const c = op();
    const alias = s.todos.accept(v2, 'p1.s1', { opId: c, expect: 0, project: P });
    assert.deepEqual([alias.state, alias.todo], ['already in to-dos', fresh.todo]);
    s.todos.undo(v1, 'p1.s1', { opId: op(), expect: 2, project: P });
    assert.deepEqual(s.todos.accept(v2, 'p1.s1', { opId: c, expect: 0, project: P }), { ...alias, replayed: true });
    assert.equal(s.memory.items(P).filter(i => i.status === 'open').length, 0);
  } finally { await s.close(); }
});

test('changed since read: a same-size edit with its time put back is caught by the saved lines, not by the manifest', async () => {
  const s = await setup();
  try {
    const roots = s.f.input.refs.roots;
    const evidence = await s.f.evidence.read();
    const before = await materialsManifest(roots);
    assert.deepEqual([...await changedSinceRead(evidence, roots, { before, after: await materialsManifest(roots) })], []);
    const { atime, mtime } = await stat(s.f.file);
    const text = (await import('node:fs/promises')).readFile;
    const old = await text(s.f.file, 'utf8');
    const revised = old.split('\n');
    revised[11] = 'Reopen the kiln room at quarter past ten after the latch inspection.';
    await writeFile(s.f.file, revised.join('\n'));
    await utimes(s.f.file, atime, mtime);
    // The manifest sees the same size and time (as a file system with coarse times would): only the lines show the edit.
    assert.equal((await stat(s.f.file)).size, Buffer.byteLength(old));
    assert.deepEqual([...await changedSinceRead(evidence, roots, { before, after: before })], ['R1/notes/plan.md']);
    // An edit outside the lines read is not a change of what was read.
    const unreadEdit = old.split('\n');
    unreadEdit[34] = 'Log entry 35 records a missing broom and a newly stocked soap dispenser.';
    await writeFile(s.f.file, unreadEdit.join('\n'));
    assert.deepEqual([...await changedSinceRead(evidence, roots)], []);
  } finally { await s.close(); }
});

test('the payload: a follow-on keeps its condition, the owner comes from the notes, and long or unchecked steps are refused', async () => {
  const s = await setup();
  try {
    const raw = twoPlans();
    raw.plans.push(rawPlan({ question: 'A long one', from: ['N1'], stateNow: [], answer: null, next: { text: 'Long '.repeat(130), basis: [] } }));
    raw.plans.push(rawPlan({ question: 'An unchecked one', from: ['N1'], stateNow: [], answer: null, next: { text: 'Do it', basis: ['k7'] } }));
    const v1 = await s.publish(await doc(s.f, raw));
    const follow = s.todos.accept(v1, 'p1.s2', { opId: op(), expect: 0, project: P });
    assert.equal(s.memory.item(P, follow.todo)!.text, 'If the latch sticks: Keep the room locked and call the caretaker');
    const photograph = s.todos.accept(v1, 'p2.s1', { opId: op(), expect: 0, project: P });
    assert.equal(s.memory.item(P, photograph.todo)!.owner, 'Vesper');
    assert.throws(() => s.todos.accept(v1, 'p3.s1', { opId: op(), expect: 0, project: P }), (e: Error & { status?: number }) => e.status === 413 && /too long for a to-do/.test(e.message));
    assert.throws(() => s.todos.accept(v1, 'p4.s1', { opId: op(), expect: 0, project: P }), /did not check out/);
    assert.deepEqual(s.todos.states(v1, P)['p3.s1'].state, 'not eligible');
    assert.equal(s.memory.items(P).length, 2, 'nothing cut, nothing made');
  } finally { await s.close(); }
});

test('across versions: an equal step shows Already in to-dos, and two tabs adding from two versions make one to-do', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    const v2 = await s.publish(await doc(s.f, twoPlans(), { run: 'run2', base: 1 }));
    // Both tabs saw "Add" before either added.
    assert.equal(s.todos.states(v2, P)['p1.s1'].state, 'add');
    const one = s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P });
    assert.deepEqual(s.todos.states(v2, P)['p1.s1'], { state: 'already in to-dos', generation: 0, todo: one.todo, project: P });
    const two = s.todos.accept(v2, 'p1.s1', { opId: op(), expect: 0, project: P });
    assert.deepEqual([two.state, two.todo, two.created], ['already in to-dos', one.todo, false]);
    assert.equal(s.memory.items(P).length, 1);
    assert.throws(() => s.todos.undo(v2, 'p1.s1', { opId: op(), expect: 1, project: P }), /added from another version/);
    // Equal wording under another question is another to-do.
    const v3 = await s.publish(await doc(s.f, twoPlans({ question: 'Who may unlock the room for the evening glazing class?' }), { run: 'run3', base: 2 }));
    assert.equal(s.todos.states(v3, P)['p1.s1'].state, 'add');
    assert.equal(s.todos.accept(v3, 'p1.s1', { opId: op(), expect: 0, project: P }).created, true);
    // Once the shared to-do is undone, the equal step may be added on its own.
    s.todos.undo(v1, 'p1.s1', { opId: op(), expect: 1, project: P });
    assert.deepEqual(s.todos.states(v2, P)['p1.s1'], { state: 'add', generation: 1 });
  } finally { await s.close(); }
});

test('projects: the origin pin decides; plans with no project go to the current one; a replay after a move returns its result', async () => {
  const s = await setup();
  try {
    const inA = await s.publish(await doc(s.f, twoPlans()));
    const first = op();
    const added = s.todos.accept(inA, 'p1.s1', { opId: first, expect: 0, project: P });
    // The meeting moved to project B.
    assert.deepEqual(s.todos.accept(inA, 'p1.s1', { opId: first, expect: 0, project: 'project-b' }), { ...added, replayed: true });
    assert.throws(() => s.todos.accept(inA, 'p2.s1', { opId: op(), expect: 0, project: 'project-b' }), /Plan again/);
    assert.equal(s.todos.states(inA, 'project-b')['p2.s1'].state, 'not eligible');
    assert.equal(s.memory.item(P, added.todo)!.status, 'open', 'what was added stays in A');
    assert.throws(() => s.todos.accept(inA, 'p2.s1', { opId: op(), expect: 0, project: null }), (e: Error & { status?: number }) => e.status === 400 && /Move this meeting to a project/.test(e.message));
    const none = await s.publish(await doc(s.f, twoPlans(), { run: 'run2', base: 1, pins: { project: null } }));
    const moved = s.todos.accept(none, 'p2.s1', { opId: op(), expect: 0, project: 'project-b' });
    assert.deepEqual([moved.project, s.memory.item('project-b', moved.todo)!.owner], ['project-b', 'Vesper']);
  } finally { await s.close(); }
});

test('notes regeneration and the memory reconciliation never touch a plan\'s to-do; adding one leaves its own version\'s stamp alone', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans()));
    const stamp = memoryStamp(s.memory, P);
    const added = s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P });
    const ownOf = (v: number) => s.todos.addedFrom('m1', v, P);
    assert.deepEqual([...ownOf(1)], [added.todo]);
    assert.equal(memoryStamp(s.memory, P, ownOf(1)), stamp, 'its own to-do does not make version 1 out of date');
    assert.notEqual(memoryStamp(s.memory, P), stamp, 'without the exemption it counts');
    const proposals = new Proposals(s.store, s.memory, { runner: null, directory: s.f.folder, clock: () => 5000, notesFor: async () => null, projectOf: () => P });
    proposals.publish(P, 'm1', 'run-x', [], new Set());
    proposals.withdrawMeeting('m1');
    assert.deepEqual([s.memory.item(P, added.todo)!.status, s.memory.batch(P, added.batch)!.undone], ['open', false]);
    s.memory.apply(P, { requestId: 'edit-1', actor: 'user', changes: [{ op: 'edit', item: added.todo, text: 'Clip the signed access card to the door handle', source: { kind: 'app' } }] });
    assert.notEqual(memoryStamp(s.memory, P, ownOf(1)), stamp, 'an edit to it counts');
    // A later run read that to-do: for its version the to-do is an input like any other, and completing it changes the stamp.
    const v2 = await s.publish(await doc(s.f, twoPlans(), { run: 'run2', base: 1, pins: { memoryStamp: memoryStamp(s.memory, P) } }));
    const pinned = v2.plans[0].originPins.memoryStamp;
    assert.equal(memoryStamp(s.memory, P, ownOf(2)), pinned);
    s.memory.apply(P, { requestId: 'done-1', actor: 'user', changes: [{ op: 'status', item: added.todo, to: 'done', source: { kind: 'app' } }] });
    assert.notEqual(memoryStamp(s.memory, P, ownOf(2)), pinned, 'completed after the run read it');
    assert.equal(freshness(v2.plans[0], { notesVersion: 1, memoryStamp: memoryStamp(s.memory, P, ownOf(2)), manifest: 'digest-1' }).label, 'Made before the memory changed');
  } finally { await s.close(); }
});

test('Explore further after an Add: the carried plan and the explored one are each current against their own run\'s memory', async () => {
  const s = await setup();
  try {
    const v1 = await s.publish(await doc(s.f, twoPlans(), { pins: { memoryStamp: memoryStamp(s.memory, P) } }));
    const added = s.todos.accept(v1, 'p1.s1', { opId: op(), expect: 0, project: P });
    // Explore p2: its run reads memory with p1's to-do in it.
    const explored = rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], answer: null,
      stateNow: [{ id: 'k1', text: 'Vesper is recording the shelf damage', source: { type: 'transcript', ref: 'S2', quote: 'Vesper will photograph the cracked shelf before the caretaker arrives' } }],
      next: { text: 'Save a close-up of the crack alongside the full shelf photograph', basis: ['k1'] } });
    const v2 = await s.publish(await doc(s.f, { plans: [explored] }, { run: 'run2', kind: 'explore', base: 1, plan: 'p2', pins: { memoryStamp: memoryStamp(s.memory, P) } }));
    const [carried, fresh] = v2.plans;
    assert.notEqual(carried.originPins.memoryStamp, fresh.originPins.memoryStamp);
    const now = () => currentPins({ notesVersion: 1, manifest: 'digest-1', memory: s.memory, project: P, meetingId: 'm1', todos: s.todos, versions: [v1, v2] });
    // One shared stamp would make one of the two stale whichever exemption it took.
    const shared = memoryStamp(s.memory, P, s.todos.addedFrom('m1', 2, P));
    assert.ok(shared !== carried.originPins.memoryStamp || shared !== fresh.originPins.memoryStamp);
    assert.deepEqual([freshness(carried, now()).current, freshness(fresh, now()).current], [true, true]);
    assert.deepEqual(planRows(v2, { current: now() }).rows.map(r => r.outOfDate), [null, null]);
    // The explored plan's run read the to-do: completing it makes that plan out of date.
    s.memory.apply(P, { requestId: 'done-2', actor: 'user', changes: [{ op: 'status', item: added.todo, to: 'done', source: { kind: 'app' } }] });
    assert.equal(planRows(v2, { current: now() }).rows[1].outOfDate, 'Made before the memory changed');
    // A plan without a project's memory is compared with none.
    assert.equal(currentPins({ notesVersion: 1, manifest: 'd', memory: null, project: null, meetingId: 'm1', todos: s.todos, versions: [v2] }).memoryStamp, null);
  } finally { await s.close(); }
});

test('automatic planning: one attempt per notes version, recorded durably; newer notes replace a waiting run; manual runs are never cancelled', async () => {
  const s = await setup();
  try {
    const auto = new AutoPlanning(s.store, () => 1);
    assert.equal(auto.claim('m1', 1), true);
    assert.equal(auto.claim('m1', 1), false, 'never twice');
    auto.started('m1', 1, 'run-1');
    const again = new AutoPlanning(s.store);
    assert.equal(again.attempted('m1', 1), true, 'durable');
    assert.deepEqual(again.attempts('m1'), [{ notesVersion: 1, run: 'run-1', at: 1 }]);
    assert.equal(again.attempted('m1', 2), false);
    const waitingAuto = { id: 'a1', state: 'waiting' as const, origin: 'auto' as const, notesVersion: 1 };
    const waitingManual = { id: 'm1', state: 'waiting' as const, origin: 'manual' as const, notesVersion: null };
    const runningAuto = { id: 'a2', state: 'running' as const, origin: 'auto' as const, notesVersion: 1 };
    assert.deepEqual(onNotes({ enabled: false, notesVersion: 2, attempted: false, runs: [] }).submit, false);
    assert.deepEqual(onNotes({ enabled: true, notesVersion: 1, attempted: true, runs: [] }).submit, false);
    assert.deepEqual(onNotes({ enabled: true, notesVersion: 2, attempted: false, runs: [] }), { cancel: [], submit: true, reason: 'plan after the notes' });
    assert.deepEqual(onNotes({ enabled: true, notesVersion: 2, attempted: false, runs: [waitingAuto] }).cancel, ['a1'], 'newer notes replace the waiting run');
    assert.equal(onNotes({ enabled: true, notesVersion: 2, attempted: false, runs: [runningAuto] }).submit, false, 'waits for the running one');
    assert.equal(onNotes({ enabled: true, notesVersion: 2, attempted: false, runs: [waitingManual] }).submit, false, 'the user\'s Plan goes first');
    assert.deepEqual(onManualPlan([waitingAuto, runningAuto]).cancel, ['a1']);
    assert.deepEqual(onSettingOff([waitingAuto, waitingManual, runningAuto]).cancel, ['a1'], 'only waiting automatic runs');
  } finally { await s.close(); }
});

export type { PublishedVersion };
