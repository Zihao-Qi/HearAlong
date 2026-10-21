// The Plans section's one HTTP contract (M7b §2b, §3): what GET …/plans returns, made on the server from the domain. The page
// shows only this. Freshness is per plan, from its origin's pins; to-do states and eligibility are PlanTodos.states(); checks
// are 'checked', 'proposal' or 'unchecked'; each plan names the registry entries it rests on, another plan's included
// (entriesOf); diagnostics and coverage are passed on; the run is one exploration job, chosen so that an active job is
// never hidden behind a finished one.
import type { ExplorationJob, ExplorationState, StopReason, WaitingReason } from '../explorations.ts';
import { SECTION_LABEL } from './rows.ts';
import type { Refusal, TodoState } from './todos.ts';
import { entriesOf, type Answer, type CheckedPlan, type CheckedRun, type Registry, type RunStatus, type Step } from './validate.ts';
import { freshness, type CurrentPins, type ExplorationKind, type PlansDocument, type PublishedVersion } from './versions.ts';

/** Who started a plans job: the user (Plan, Plan again, Explore further) or "Plan after the notes". */
export type RunOrigin = 'auto' | 'manual';
/** What a plans job keeps in its record (ExplorationJob.data). */
export type PlanJobData = {
  origin: RunOrigin; opId: string | null;
  /** Explore further: the version and plan it explores, and the plan's label then. */
  base: number | null; plan: string | null; label: string | null;
  /** The notes version an automatic run was made for. */
  notesVersion: number | null;
};
/** What its work returns (ExplorationJob.result): published, kept beside a newer version, or refused by publication. */
export type PlanJobResult = { outcome: 'published'; version: number } | { outcome: 'kept'; newest: number | null } | { outcome: 'refused'; message: string };
/** Counted from the run's stream: material files read, web pages read, quick checks run. */
export type Progress = { files: number; pages: number; checks: number };
export type ListedJob = ExplorationJob & { waiting: WaitingReason | null };

export type RunView = {
  id: string; kind: ExplorationKind; origin: RunOrigin; state: ExplorationState;
  /** Explore further: the plan and its label. */
  plan: string | null; label: string | null;
  /** What a waiting run waits for, in words ("Waiting for the notes"); null when it is about to start. */
  waiting: WaitingReason | null;
  progress: Progress;
  createdAt: number; startedAt: number | null; finishedAt: number | null;
  /** Pi's time limit, in minutes (5 for the plan pass, 20 for Explore further). */
  limitMinutes: number;
  stopped: StopReason | null; error: string | null;
  /** A finished run: what became of its plans. `message`: why publication refused them. */
  outcome: PlanJobResult['outcome'] | null; message: string | null;
};
export type Freshness = { current: boolean; changed: ('notes' | 'memory' | 'materials')[]; label: string | null };
export type StepView = Step & {
  /** What its slot shows (PlanTodos.states); null on kept plans, which are not a version and add nothing. */
  todo: TodoState | null;
};
export type PlanView = {
  id: string;
  /** The model's label, or the question when it gave none (flagged in rowFlags). */
  label: string; answerLine: string | null; stepLine: string | null; rowFlags: string[];
  question: string; from: string[]; fromItems: CheckedPlan['fromItems']; owner: string | null;
  /** Where the plan comes from: its run and version, what that run was, when it was published and how long an exploration took. */
  origin: { run: string; version: number | null; kind: ExplorationKind; at: number; minutes: number | null };
  /** For a plan revised by Explore further: the plan it replaced. */
  earlier: { version: number; at: number; stepLine: string | null; answerLine: string | null } | null;
  freshness: Freshness;
  answer: Answer | null; steps: StepView[];
  waitingOn: string[]; decideAfter: string[]; changeIf: string | null; further: CheckedPlan['further'];
  stateNow: string[]; checks: string[];
  /** Every registry entry the plan rests on: its own items and every id its answer and steps name, in that order. */
  evidence: string[];
  /** Its items that need review: failed evidence (by id) and other parts that did not check (`from`, a step, `further`). */
  review: CheckedPlan['review'];
};
export type DocView = {
  /** Null for kept plans: a run that finished after a newer version appeared is not a version. */
  version: number | null; run: string; kind: ExplorationKind; base: number | null;
  /** When it was published (kept plans: when the run's plans were checked). */
  at: number;
  status: RunStatus; message: string | null; label: typeof SECTION_LABEL;
  warnings: string[];
  /** Diagnostics of the answer as a whole (a deferred item without a reason, no list of plans…). */
  review: string[];
  dropped: CheckedRun['dropped']; deferred: CheckedRun['deferred']; notCovered: CheckedRun['notCovered'];
  /** When every plan was made before the same change, said once for the section; otherwise per plan. */
  freshness: Freshness | null;
  /** Why no step of these plans can be added now (said once above the rows), with the project they were made in. */
  addable: { code: Extract<Refusal, 'no project' | 'other project'>; madeIn: { id: string; name: string | null } | null } | null;
  plans: PlanView[];
  /** The entries the plans rest on (entriesOf), by qualified id. */
  evidence: Registry;
};
export type KeptView = DocView & { finishedAt: number; newest: { version: number; kind: ExplorationKind; at: number } | null };
export type PlansPage = {
  /** Plans can be made (cloud models on). */
  enabled: boolean;
  notes: { version: number; at: number } | null;
  project: { id: string; name: string; planAfterNotes: boolean } | null;
  run: RunView | null;
  current: DocView | null;
  kept: KeptView | null;
};

const ACTIVE = new Set<ExplorationState>(['waiting', 'running']);
const NO_PROGRESS: Progress = { files: 0, pages: 0, checks: 0 };
export const jobData = (job: Pick<ExplorationJob, 'data'>): PlanJobData =>
  ({ origin: 'manual', opId: null, base: null, plan: null, label: null, notesVersion: null, ...(job.data as Partial<PlanJobData> | null ?? {}) });
export const jobResult = (job: Pick<ExplorationJob, 'result'>): PlanJobResult | null => {
  const r = job.result as PlanJobResult | null;
  return r && typeof r === 'object' && 'outcome' in r ? r : null;
};
/** A job's active state counts first: running, then the newest waiting one. */
export const activeJob = (jobs: ListedJob[]) => jobs.find(j => j.state === 'running') ?? jobs.find(j => j.state === 'waiting') ?? null;

/**
 * Which run the section shows, and whether a finished run's plans were kept aside. `jobs` newest first (Explorations.list).
 * An active job wins. Otherwise only the newest job counts: one that published shows nothing; one whose
 * plans were kept is offered as kept; any other (failed, stopped, interrupted, refused) is shown beside the last good plans.
 */
export function shownJobs(jobs: ListedJob[]): { run: ListedJob | null; kept: ListedJob | null } {
  const active = activeJob(jobs);
  if (active) return { run: active, kept: null };
  const newest = jobs[0];
  if (!newest) return { run: null, kept: null };
  const outcome = jobResult(newest)?.outcome;
  if (newest.state === 'done' && outcome === 'published') return { run: null, kept: null };
  if (newest.state === 'done' && outcome === 'kept') return { run: null, kept: newest };
  return { run: newest, kept: null };
}

export function runView(job: ListedJob, progress: Progress = NO_PROGRESS): RunView {
  const data = jobData(job);
  const result = jobResult(job);
  return {
    id: job.id, kind: job.kind, origin: data.origin, state: job.state, plan: data.plan, label: data.label,
    waiting: job.state === 'waiting' ? job.waiting : null, progress: { ...progress },
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, limitMinutes: Math.round(job.limitMs / 60_000),
    stopped: job.stopped, error: job.error, outcome: ACTIVE.has(job.state) ? null : result?.outcome ?? null,
    message: result?.outcome === 'refused' ? result.message : null,
  };
}

type DocLike = Pick<PublishedVersion, 'run' | 'kind' | 'base' | 'plan' | 'status' | 'warnings' | 'review' | 'plans' | 'evidence' | 'deferred' | 'notCovered' | 'dropped'>;
const MESSAGE: Record<RunStatus, string | null> = {
  plans: null,
  'nothing to plan': 'The meeting left no open decision to plan.',
  'all plans failed checks': 'Plans were made, but none passed the source checks. See Needs review.',
};

/** One plan as the page shows it. `version` null: a kept document's plan (no to-dos, its own run as origin). */
function planView(plan: CheckedPlan, doc: DocLike, context: {
  version: number | null; versions: PublishedVersion[]; jobs: ListedJob[]; todos: Record<string, TodoState> | null; current: CurrentPins | null; at: number;
}): PlanView {
  const { versions, jobs } = context;
  const made = plan.origin.version === null ? null : versions.find(v => v.version === plan.origin.version) ?? null;
  const job = jobs.find(j => j.id === plan.origin.run);
  const kind = made?.kind ?? doc.kind;
  const minutes = kind === 'explore' && job?.startedAt && job.finishedAt ? Math.max(1, Math.round((job.finishedAt - job.startedAt) / 60_000)) : null;
  // The plan an exploration replaced: the same plan in the version the exploration was based on.
  const explored = made ? (made.kind === 'explore' && made.plan === plan.id ? { base: made.base, id: plan.id } : null)
    : doc.kind === 'explore' && doc.plan ? { base: doc.base, id: doc.plan } : null;
  const replaced = explored ? versions.find(v => v.version === explored.base)?.plans.find(p => p.id === explored.id) : undefined;
  const replacedIn = replaced && versions.find(v => v.version === (replaced.origin.version ?? explored!.base));
  const fresh = context.current ? freshness(plan, context.current) : { current: true, changed: [], label: null };
  return {
    id: plan.id, label: plan.label ?? plan.question, answerLine: plan.answerLine, stepLine: plan.stepLine, rowFlags: plan.rowFlags,
    question: plan.question, from: plan.from, fromItems: plan.fromItems, owner: plan.owner,
    origin: { run: plan.origin.run, version: plan.origin.version, kind, at: made?.publishedAt ?? context.at, minutes },
    earlier: replaced && replacedIn ? { version: replacedIn.version, at: replacedIn.publishedAt, stepLine: replaced.stepLine ?? replaced.steps.find(s => s.kind === 'next')?.text ?? null,
      answerLine: replaced.answerLine ?? replaced.answer?.text ?? null } : null,
    freshness: fresh,
    answer: plan.answer, steps: plan.steps.map(s => ({ ...s, todo: context.todos?.[s.id] ?? null })),
    waitingOn: plan.waitingOn, decideAfter: plan.decideAfter, changeIf: plan.changeIf, further: plan.further,
    stateNow: plan.stateNow, checks: plan.checks, evidence: Object.keys(entriesOf(plan, doc.evidence)), review: plan.review,
  };
}

function docView(doc: DocLike, context: Parameters<typeof planView>[2] & { project: { id: string } | null; projectName: (id: string) => string | null }): DocView {
  const plans = doc.plans.map(p => planView(p, doc, context));
  const stale = plans.map(p => p.freshness);
  const same = stale.length > 0 && stale.every(f => !f.current && f.label === stale[0].label);
  // Steps can be added only in the meeting's project now, and only from plans made there or with no project (§2b eligibility).
  const other = doc.plans.find(p => p.originPins.project && p.originPins.project !== context.project?.id)?.originPins.project ?? null;
  const addable: DocView['addable'] = !context.project ? { code: 'no project', madeIn: other ? { id: other, name: context.projectName(other) } : null }
    : other ? { code: 'other project', madeIn: { id: other, name: context.projectName(other) } } : null;
  return {
    version: context.version, run: doc.run, kind: doc.kind, base: doc.base, at: context.at,
    status: doc.status, message: MESSAGE[doc.status], label: SECTION_LABEL,
    warnings: doc.warnings, review: doc.review, dropped: doc.dropped, deferred: doc.deferred, notCovered: doc.notCovered,
    freshness: same ? stale[0] : null, addable: doc.status === 'plans' ? addable : null, plans,
    evidence: Object.assign({}, ...doc.plans.map(p => entriesOf(p, doc.evidence))),
  };
}

/**
 * The page's view of a meeting's plans. `versions`: every published version, oldest first; `todos`: PlanTodos.states() of
 * the newest; `current`: currentPins() now; `jobs`: Explorations.list(), newest first; `kept`: the document of the run
 * shownJobs() keeps aside (loadRunPlans), when there is one.
 */
export function plansPage(input: {
  enabled: boolean;
  notes: { version: number; at: number } | null;
  project: { id: string; name: string; planAfterNotes: boolean } | null;
  projectName: (id: string) => string | null;
  versions: PublishedVersion[];
  todos: Record<string, TodoState>;
  current: CurrentPins | null;
  jobs: ListedJob[];
  progress?: (job: string) => Progress;
  kept?: PlansDocument | null;
}): PlansPage {
  const latest = input.versions.at(-1) ?? null;
  const shown = shownJobs(input.jobs);
  const common = { versions: input.versions, jobs: input.jobs, current: input.current, project: input.project, projectName: input.projectName };
  const current = latest ? docView(latest, { ...common, version: latest.version, todos: input.todos, at: latest.publishedAt }) : null;
  let kept: KeptView | null = null;
  if (shown.kept && input.kept && input.kept.run === shown.kept.id) {
    // Kept plans are the run's own checked result: their origin is that run, never a version.
    const doc = { ...input.kept, plans: input.kept.plans.map(p => ({ ...p, origin: { run: input.kept!.run, version: null } })) };
    const newest = latest ? { version: latest.version, kind: latest.kind, at: latest.publishedAt } : null;
    kept = { ...docView(doc, { ...common, version: null, todos: null, at: input.kept.createdAt }), finishedAt: shown.kept.finishedAt ?? input.kept.createdAt, newest };
  }
  return {
    enabled: input.enabled, notes: input.notes, project: input.project,
    run: shown.run ? runView(shown.run, input.progress?.(shown.run.id)) : null, current, kept,
  };
}
