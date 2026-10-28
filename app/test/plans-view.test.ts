import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlans, plansDocument, plansPage, runView, shownJobs, type ListedJob, type PublishedVersion } from '../src/plans/index.ts';
import { PINS, fixture, rawPlan, readResult } from './plans-fixture.ts';

// The page's projection (src/plans/view.ts): the one HTTP contract of the Plans section. No model, no server.
const job = (id: string, over: Partial<ListedJob> = {}): ListedJob => ({ id, meetingId: 'm1', kind: 'plan', key: 'plan', state: 'done', createdAt: 0, startedAt: 0, finishedAt: 1,
  error: null, stopped: null, limitMs: 300_000, runLimitMs: 900_000, worker: null, data: { origin: 'manual' }, result: null, waiting: null, ...over });

test('the run shown: an active job is never hidden behind a newer finished one; published runs show nothing; cancelled summaries stay; kept is offered', () => {
  const published = job('a', { createdAt: 3, result: { outcome: 'published', version: 2 } });
  const waiting = job('w', { createdAt: 1, state: 'waiting', waiting: { reason: 'Waiting for the notes' } });
  assert.equal(shownJobs([published, waiting]).run?.id, 'w');
  assert.equal(shownJobs([job('r', { createdAt: 0, state: 'running' }), waiting, published]).run?.id, 'r', 'running before waiting');
  assert.deepEqual(shownJobs([published]), { run: null, kept: null });
  assert.equal(shownJobs([job('c', { state: 'cancelled' }), job('f', { state: 'failed' })]).run?.id, 'c', 'cancelled summaries stay; only the newest counts');
  assert.equal(shownJobs([job('k', { result: { outcome: 'kept', newest: 3 } })]).kept?.id, 'k');
  assert.equal(shownJobs([job('x', { result: { outcome: 'refused', message: 'no' } })]).run?.id, 'x');
  assert.equal(shownJobs([job('s', { state: 'stopped', stopped: 'time limit' }), published]).run?.id, 's', 'a failure is shown beside the last good plans');
  const view = runView(job('e', { kind: 'explore', key: 'p2', limitMs: 1_200_000, state: 'waiting', waiting: { reason: 'Waiting for the recording to end' },
    data: { origin: 'manual', opId: 'op-1', base: 2, plan: 'p2', label: 'Shelf photograph', notesVersion: null } }), { files: 2, pages: 1, checks: 0 });
  assert.deepEqual([view.kind, view.plan, view.label, view.limitMinutes, view.waiting?.reason, view.progress.files, view.outcome], ['explore', 'p2', 'Shelf photograph', 20, 'Waiting for the recording to end', 2, null]);
});

test('the page: checks as checked, proposal or unchecked; per-plan freshness; cross-plan evidence; eligibility; kept plans add nothing', async () => {
  const f = await fixture();
  try {
    await f.evidence.record(readResult(f.file, 5, 20));
    const raw = { plans: [
      rawPlan(),
      // p2 rests on p1's k1 (ids are unique across plans), and proposes a follow-on resting on nothing.
      rawPlan({ question: 'How will the shelf damage be documented?', from: ['N2'], label: null, stateNow: [], answer: null, next: { text: 'Place a ruler beside the crack for the photograph', basis: ['k1'] },
        followOn: [{ if: 'the shelf tag is unreadable', then: 'Attach a temporary inventory label', basis: [] }] }),
    ], deferred: [] };
    const evidence = await f.evidence.read();
    const checked = checkPlans(raw, { run: 'r1', refs: f.input.refs, evidence, pins: PINS });
    const version: PublishedVersion = { schema: 1, meetingId: 'm1', version: 1, base: null, publishedAt: 10, run: 'r1', kind: 'plan', plan: null, status: checked.status, warnings: [],
      plans: checked.plans.map(p => ({ ...p, origin: { run: 'r1', version: 1 } })), evidence: checked.evidence, deferred: checked.deferred, notCovered: checked.notCovered, dropped: checked.dropped, review: checked.review };
    const page = plansPage({ enabled: true, notes: { version: 1, at: 1 }, project: { id: 'project-a', name: 'A', planAfterNotes: false }, projectName: () => 'A',
      versions: [version], todos: { 'p1.s1': { state: 'add', generation: 0 } }, current: { notesVersion: 2, memoryStamp: 'm1', manifest: 'digest-1' }, jobs: [] });
    const [p1, p2] = page.current!.plans;
    assert.deepEqual([p1.answer?.check, p1.steps[0].check, p2.steps[0].check, p2.steps[1].check], ['checked', 'checked', 'checked', 'proposal']);
    assert.deepEqual([p2.label, p2.rowFlags], ['How will the shelf damage be documented?', ['no label']], 'the question when there is no label, flagged');
    assert.deepEqual(p2.evidence, ['r1:k1'], 'another plan\'s evidence that its step rests on');
    assert.ok(page.current!.evidence['r1:k1']);
    assert.deepEqual([p1.steps[0].todo, p2.steps[0].todo], [{ state: 'add', generation: 0 }, null]);
    assert.deepEqual([p1.freshness.label, page.current!.freshness?.changed], ['Made before the notes changed', ['notes']], 'every plan stale alike: said once');
    assert.equal(page.current!.addable, null);
    const moved = plansPage({ enabled: true, notes: null, project: { id: 'project-b', name: 'B', planAfterNotes: false }, projectName: id => id === 'project-a' ? 'A' : null,
      versions: [version], todos: {}, current: null, jobs: [] });
    assert.deepEqual(moved.current!.addable, { code: 'other project', madeIn: { id: 'project-a', name: 'A' } });
    assert.deepEqual(plansPage({ enabled: true, notes: null, project: null, projectName: () => null, versions: [version], todos: {}, current: null, jobs: [] }).current!.addable,
      { code: 'no project', madeIn: { id: 'project-a', name: null } });
    // A Plan again that finished after a newer version: its own document, never a version, nothing to add.
    const keptDoc = { ...plansDocument(checked, { kind: 'plan', base: 0, createdAt: 20, finished: true, evidenceComplete: true, pins: { ...PINS, materials: { roots: [], files: {}, complete: true, digest: 'digest-1' } } }), run: 'r2' };
    const withKept = plansPage({ enabled: true, notes: null, project: null, projectName: () => null, versions: [version], todos: {}, current: null,
      jobs: [job('r2', { finishedAt: 30, result: { outcome: 'kept', newest: 1 } })], kept: keptDoc });
    assert.deepEqual([withKept.run, withKept.kept?.version, withKept.kept?.finishedAt, withKept.kept?.newest?.version, withKept.kept?.plans[0].steps[0].todo, withKept.kept?.plans[0].origin.run],
      [null, null, 30, 1, null, 'r2']);
  } finally { await f.close(); }
});
