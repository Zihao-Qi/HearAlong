import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { Projects } from '../src/projects.ts';
import { Memory } from '../src/memory.ts';
import { MemoryFiles } from '../src/memory-files.ts';
import { Proposals } from '../src/proposals.ts';
import { EvidenceRecorder, materialLocator, type MaterialEligibility, type SavedEvidence } from '../src/plans/evidence.ts';
import { buildPlanInput, planRoots } from '../src/plans/input.ts';
import { checkPlans } from '../src/plans/validate.ts';
import { changedSinceRead } from '../src/plans/versions.ts';
import { notes, PINS, rawPlan, tool } from './plans-fixture.ts';

const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'meeting-memory-evidence-')));
  const store = new MeetingStore(directory), projects = new Projects(store, directory), memory = new Memory(store);
  const project = await projects.create('P', directory);
  const proposals = new Proposals(store, memory, { directory, clock: Date.now, runner: null, projectOf: () => project.id, notesFor: async () => null });
  const files = new MemoryFiles(store, memory, proposals, { directory, clock: Date.now, project: () => project, projects: () => [project], meetingTitle: () => 'M', interpreter: null, guesser: null });
  memory.apply(project.id, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'create', type: 'decision', text: 'Use independent samples for every trial', source: { kind: 'app' } }] });
  await files.sync(project.id);
  const path = join(files.folder(project), 'decisions.md'), approved = await readFile(path, 'utf8');
  const unapproved = approved.replace('independent samples', 'correlated samples');
  const roots = planRoots([{ id: 'r', scope: `project:${project.id}`, path: directory, kind: 'folder', label: 'repo' }]);
  const locate = materialLocator({ roots });
  const eligible: MaterialEligibility = (path, blocks) => files.evidenceAllowed(path, blocks);
  const built = buildPlanInput({ notes: notes(), roots });
  assert.ok(!('refused' in built));
  const line = approved.split('\n').findIndex(l => l.includes('Use independent samples')) + 1;
  const check = async (evidence: SavedEvidence, quote: string) => checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 'Sample rule', source: { type: 'file', path: 'R1/project-memory/decisions.md', line, quote } }] })] },
    { run: 'r', refs: built.refs, evidence, pins: PINS, changed: await changedSinceRead(evidence, roots) });
  const recorder = async (options: { locate?: typeof locate; eligible?: MaterialEligibility } = {}) => {
    const folder = join(directory, randomUUID()); await mkdir(folder);
    return new EvidenceRecorder(folder, { cwd: directory, locate, eligible, ...options });
  };
  return { directory, store, memory, project, files, path, approved, unapproved, line, locate, eligible, check, recorder,
    close: async () => { await files.close(); await proposals.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const outcome = (checked: ReturnType<typeof checkPlans>) => [checked.evidence['r:k1'].result.ok, checked.plans[0].answer?.check, checked.plans[0].steps[0].check];

test('Pi 4 round 2: queued read and grep evidence authenticate returned bytes, not a restored live export', async () => {
  const f = await fixture();
  const hold = gate(), entered = gate();
  try {
    const blocker = join(f.directory, 'other.md'); await writeFile(blocker, 'ordinary material');
    const recorder = await f.recorder({ locate: async path => {
      if (path === blocker) { entered.release(); await hold.promise; }
      return f.locate(path);
    } });
    const first = recorder.record(tool('read', { path: blocker }, 'ordinary material'));
    await entered.promise;
    await writeFile(f.path, f.unapproved);
    const returned = await readFile(f.path, 'utf8');
    const read = recorder.record(tool('read', { path: f.path }, returned));
    const grep = recorder.record(tool('grep', { path: f.path, pattern: 'samples' }, `${f.path}:${f.line}: ${returned.split('\n')[f.line - 1]}`));
    await writeFile(f.path, f.approved);
    hold.release(); await Promise.all([first, read, grep]);
    const saved = await recorder.read();
    const checked = await f.check(saved, 'Use correlated samples for every trial');
    assert.deepEqual(outcome(checked), [false, 'unchecked', 'unchecked'], 'change detection must not merely label unapproved wording changed while leaving it checked');
    assert.equal(saved.items.length, 1, 'only the ordinary material is evidence');

    // Reverse timing: an approved read still qualifies after a later unapproved disk edit.
    await writeFile(f.path, f.unapproved);
    const approvedRead = await f.recorder();
    await approvedRead.record(tool('read', { path: f.path }, f.approved));
    assert.deepEqual(outcome(await f.check(await approvedRead.read(), 'Use independent samples for every trial')), [true, 'checked', 'checked']);
  } finally { hold.release(); await f.close(); }
});

test('Pi 4 round 2: a pending capture cannot veto exact approved read or grep blocks at their recorded lines', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, f.unapproved); await f.files.sync(f.project.id);
    assert.equal(f.files.pendingCaptures(f.project.id).length, 1);
    await writeFile(f.path, f.approved);
    const approvedLine = f.approved.split('\n')[f.line - 1];
    const returned = [
      tool('read', { path: f.path }, f.approved),
      tool('read', { path: f.path, offset: f.line, limit: 1 }, `${approvedLine}\n\n[1 more lines in file. Use offset=${f.line + 1} to continue.]`),
      tool('grep', { path: f.path, pattern: 'samples' }, `${f.path}:${f.line}: ${approvedLine}`),
    ];
    for (const result of returned) {
      const recorder = await f.recorder(); await recorder.record(result);
      assert.deepEqual(outcome(await f.check(await recorder.read(), 'Use independent samples for every trial')), [true, 'checked', 'checked'], result.name);
    }
    assert.equal(f.files.pendingCaptures(f.project.id).length, 1, 'evidence eligibility does not approve or dismiss the outside edit');

    // Matching text at the wrong line, changed whitespace, or a shortened line is not verbatim approval.
    for (const [line, text] of [[f.line + 1, approvedLine], [f.line, approvedLine.replace('Use ', 'Use  ')], [f.line, `${approvedLine.slice(0, -5)}... [truncated]`]] as const) {
      const recorder = await f.recorder();
      await recorder.record(tool('grep', { path: f.path, pattern: 'samples' }, `${f.path}:${line}: ${text}`));
      assert.equal((await recorder.read()).items.length, 0);
    }
  } finally { await f.close(); }
});

test('Pi 4 round 2: blocks share one recorded export, including historical exports, and never-written memory files are ineligible', async () => {
  const f = await fixture();
  try {
    f.memory.apply(f.project.id, { requestId: randomUUID(), actor: 'user', changes: [{ op: 'edit', item: 'D-1', text: 'Use stratified samples for every trial', source: { kind: 'app' } }] });
    await f.files.sync(f.project.id);
    const newer = await readFile(f.path, 'utf8');
    const oldLine = f.approved.split('\n')[f.line - 1], newLine = newer.split('\n')[f.line - 1];
    const recorder = await f.recorder();
    await recorder.record(tool('read', { path: f.path, offset: f.line, limit: 1 }, oldLine));
    assert.deepEqual(outcome(await f.check(await recorder.read(), 'Use independent samples for every trial')), [true, 'checked', 'checked'], 'a recorded historical export qualifies without reading live bytes');
    assert.equal(await f.eligible(f.path, [{ from: f.line, lines: [oldLine] }, { from: f.line, lines: [newLine] }]), false, 'approval cannot combine incompatible exports');
    const inbox = join(f.files.folder(f.project), 'inbox', 'outside.md');
    await writeFile(inbox, f.approved);
    assert.equal(await f.eligible(inbox, [{ from: 1, lines: f.approved.split('\n') }]), false, 'app never exported this file');
    assert.equal(await f.eligible(join(f.directory, 'ordinary.md'), [{ from: 1, lines: ['ordinary outside text'] }]), true, 'non-memory eligibility is unchanged');
    // The stored hash authenticates its stored export content, not just a matching substring in a damaged row.
    f.store.db.prepare('UPDATE memory_files SET content=? WHERE project=? AND file=?').run(f.unapproved, f.project.id, 'decisions.md');
    assert.equal(await f.eligible(f.path, [{ from: f.line, lines: [f.unapproved.split('\n')[f.line - 1]] }]), false);
  } finally { await f.close(); }
});
