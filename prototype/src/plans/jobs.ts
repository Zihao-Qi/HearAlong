// The plans of a meeting as the server runs them (M7b §2, §2b, §4): the plan pass and Explore further, each one exploration job
// (src/explorations.ts owns admission, the one-at-a-time rule, the shared quota cooldown, process groups and busy()), and what
// the Plans routes do: the page's view (view.ts), Plan, Explore further, Cancel, Add to to-dos and its Undo, and automatic
// planning after the notes. A run pins its inputs, builds its input, prepares the PDF text, runs Pi with the run's tools and
// limits while its evidence is saved, checks the answer and publishes compare-and-swap; a newer version keeps its plans aside.
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderOf, type ExplorationContext, type ExplorationJob, type Explorations } from '../explorations.ts';
import { checkCompleted, extractJson } from '../pi-task.ts';
import { RATE_LIMIT, clockTime, type Cooldowns } from '../quota.ts';
import type { Memory } from '../memory.ts';
import type { NotesJobs } from '../notes.ts';
import type { PdfText } from '../pdf-text.ts';
import type { Projects } from '../projects.ts';
import type { MeetingStore } from '../store.ts';
import { onManualPlan, onNotes, onSettingOff, type AutoPlanning, type PlanRun } from './auto.ts';
import { EvidenceRecorder, materialLocator, type MaterialEligibility } from './evidence.ts';
import { INPUT_LIMIT, buildPlanInput, exploreInput, planRoots } from './input.ts';
import { EXPLORE_PROMPT, PLAN_PROMPT } from './prompt.ts';
import type { PlanTodos } from './todos.ts';
import { checkPlans } from './validate.ts';
import {
  changedFiles, changedSinceRead, currentPins, loadRunPlans, materialsManifest, pinRun, plansDocument, saveRunPlans,
  type ExplorationKind, type PlanVersions, type PublishedVersion,
} from './versions.ts';
import { activeJob, jobData, plansPage, runView, shownJobs, type ListedJob, type PlanJobData, type PlanJobResult, type Progress } from './view.ts';

const RUN_PYTHON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pi-extensions', 'run-python.ts');
/** The tools of §2: reading (any path, like the actions; the input points at the materials), the web, and run_python. */
export const PLAN_TOOLS = { files: 'read,grep,find,ls', web: 'web_search,fetch_content,get_search_content', python: 'run_python' };
/** run_python's limits per run (decision 2): 3 runs of 60 s for the plan pass, 8 of 120 s for Explore further. */
export const PYTHON_LIMITS: Record<ExplorationKind, { ms: number; runs: number }> = { plan: { ms: 60_000, runs: 3 }, explore: { ms: 120_000, runs: 8 } };
/**
 * The model and thinking level: the plan pass as the held-out tests ran it (scripts/plan-probe.ts; PLAN_MODEL overrides it);
 * Explore further, which has 20 minutes, at high thinking (EXPLORE_MODEL overrides it).
 */
export const planModels = () => ({ plan: process.env.PLAN_MODEL || 'openai-codex/gpt-6.1-sol:low', explore: process.env.EXPLORE_MODEL || 'openai-codex/gpt-6.1-sol:high' });

const fail = (status: number, code: string, message: string, extra: object = {}) => Object.assign(new Error(message), { status, code, ...extra });
const OP = /^[\w:-]{8,100}$/;
/** The materials' digest is listed again at most this often per meeting for the page's freshness (a folder may be large). */
const MANIFEST_MS = 10_000;

export class PlanJobs {
  private options: {
    store: MeetingStore; directory: string; clock: () => number;
    explorations: Explorations; cooldowns: Cooldowns; versions: PlanVersions; todos: PlanTodos; auto: AutoPlanning;
    memory: Memory; projects: Projects; notes: NotesJobs; pdfText: PdfText;
    /** Plans can be made (cloud models on); off, saved plans stay readable and their to-dos can be added. */
    enabled: boolean;
    /** Compute's Python environment, prepared before Pi starts (not counted against its time); without it, no quick checks. */
    python?: () => Promise<void>;
    /** The web tools are installed (pi-web-access). */
    web: () => boolean;
    /** Returned memory-file blocks qualify only when they match a recorded app-written export. */
    materialEvidence?: MaterialEligibility;
    /** The meeting's notes are final, not drafts while it is still recorded: automatic planning waits for those. */
    final: (meetingId: string) => boolean;
    /** The notes are older than the transcript (their warning is pinned with the plans). */
    stale: (meetingId: string) => Promise<boolean>;
    /** A to-do was added or undone in this project: its memory files are written again. */
    changed: (projectId: string) => void;
    models?: { plan: string; explore: string };
  };
  private cache = new Map<string, PublishedVersion>();
  private manifests = new Map<string, { at: number; key: string; digest: Promise<string> }>();
  private progress = new Map<string, Progress>();
  private submitting = new Map<string, Promise<unknown>>();
  private admissions = new Map<string, Promise<unknown>>();
  /** Meetings whose automatic attempt waits for a running plan run to end. */
  private deferred = new Set<string>();
  constructor(options: PlanJobs['options']) {
    this.options = options;
    options.store.registerDeletionGuard('plans/exploration', id => options.explorations.busy(id) || this.submitting.has(id) || this.admissions.has(id) || this.deferred.has(id));
    // Recovery has loaded the run records. Finish a crash-torn claim if it has a run; otherwise release it.
    for (const meeting of options.store.meetings()) for (const attempt of options.auto.attempts(meeting.id)) {
      if (attempt.run !== null) continue;
      const job = this.jobs(meeting.id).find(j => jobData(j).origin === 'auto' && jobData(j).notesVersion === attempt.notesVersion);
      if (job) options.auto.started(meeting.id, attempt.notesVersion, job.id);
      else options.auto.release(meeting.id, attempt.notesVersion);
    }
  }

  /** Every published version, oldest first; versions are immutable files, so each is read once. */
  private async versions(meetingId: string): Promise<PublishedVersion[]> {
    const out: PublishedVersion[] = [];
    for (const n of await this.options.versions.list(meetingId)) {
      const key = `${meetingId}:${n}`;
      let version = this.cache.get(key);
      if (!version) {
        const loaded = await this.options.versions.get(meetingId, n);
        if (!loaded) continue;
        this.cache.set(key, version = loaded);
      }
      out.push(version);
    }
    return out;
  }
  private async version(meetingId: string, n: number) {
    const version = Number.isInteger(n) ? (await this.versions(meetingId)).find(v => v.version === n) : undefined;
    if (!version) throw fail(404, 'no version', 'No such version of the plans.');
    return version;
  }
  /** The materials' digest now, for freshness: listed again after MANIFEST_MS or when the roots change. */
  private manifest(meetingId: string): Promise<string> {
    const roots = planRoots(this.options.projects.rootsFor(meetingId));
    const key = JSON.stringify(roots.map(r => [r.id, r.path]));
    const cached = this.manifests.get(meetingId);
    if (cached && cached.key === key && this.options.clock() - cached.at < MANIFEST_MS) return cached.digest;
    const digest = materialsManifest(roots, this.options.pdfText).then(m => m.digest);
    this.manifests.set(meetingId, { at: this.options.clock(), key, digest });
    digest.catch(() => this.manifests.delete(meetingId));
    return digest;
  }
  private jobs(meetingId: string): ListedJob[] { return this.options.explorations.list(meetingId); }
  private runs(jobs: ListedJob[]): PlanRun[] {
    return jobs.map(j => ({ id: j.id, state: j.state, origin: jobData(j).origin, notesVersion: jobData(j).notesVersion }));
  }
  private listed(job: ExplorationJob): ListedJob { return this.jobs(job.meetingId).find(j => j.id === job.id) ?? { ...job, waiting: null }; }

  /** GET …/plans: the page's whole view (view.ts). */
  async page(meetingId: string) {
    const { projects, notes } = this.options;
    const record = await notes.file(meetingId).load();
    const projectId = projects.projectOf(meetingId);
    const project = projectId ? projects.get(projectId) : null;
    const versions = await this.versions(meetingId);
    const latest = versions.at(-1);
    const jobs = this.jobs(meetingId);
    const { kept } = shownJobs(jobs);
    const keptDoc = kept ? await loadRunPlans(folderOf(this.options.directory, meetingId, kept.id)) : null;
    const current = latest || keptDoc ? currentPins({ notesVersion: record?.version ?? null, manifest: await this.manifest(meetingId).catch(() => ''),
      memory: this.options.memory, project: projectId, meetingId, todos: this.options.todos, versions }) : null;
    return plansPage({
      enabled: this.options.enabled, notes: record ? { version: record.version, at: record.createdAt } : null,
      project: project ? { id: project.id, name: project.name, planAfterNotes: project.planAfterNotes } : null,
      projectName: id => { try { return projects.get(id).name; } catch { return null; } },
      versions, todos: latest ? this.options.todos.states(latest, projectId) : {}, current, jobs,
      progress: id => this.progress.get(id) ?? { files: 0, pages: 0, checks: 0 }, kept: keptDoc,
    });
  }

  /** A repeated operation id returns its run as it is now; one used for another kind of request is refused. */
  private replay(meetingId: string, kind: ExplorationKind, opId: unknown) {
    if (typeof opId !== 'string' || !OP.test(opId)) throw fail(400, 'bad request', 'Give an operation id.');
    const job = this.jobs(meetingId).find(j => jobData(j).opId === opId);
    if (!job) return null;
    if (job.kind !== kind) throw fail(409, 'op reused', 'This operation id was already used for another request.');
    return { run: runView(job, this.progress.get(job.id)), replayed: true as const };
  }
  /** One submission per operation id at a time: a double click waits for the first and gets its run. */
  private async once<T>(meetingId: string, kind: ExplorationKind, opId: string, work: () => Promise<T>): Promise<T | { run: ReturnType<typeof runView>; replayed: true }> {
    const key = `${meetingId}:${opId}`;
    const pending = this.submitting.get(key);
    if (pending) { await pending.catch(() => {}); const again = this.replay(meetingId, kind, opId); if (again) return again; }
    // Different operation ids still share the meeting's one admission decision (two tabs may explore different plans).
    const run = this.admit(meetingId, async () => this.replay(meetingId, kind, opId) ?? await work());
    this.submitting.set(key, run);
    try { return await run; } finally { this.submitting.delete(key); }
  }
  private async admit<T>(meetingId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.admissions.get(meetingId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.admissions.set(meetingId, run);
    try { return await run; } finally {
      if (this.admissions.get(meetingId) === run) this.admissions.delete(meetingId);
    }
  }
  /** Submission identity remains queryable even if its run is no longer the one shown on the page. */
  submission(meetingId: string, opId: unknown) {
    if (typeof opId !== 'string' || !OP.test(opId)) throw fail(400, 'bad request', 'Give an operation id.');
    const job = this.jobs(meetingId).find(j => jobData(j).opId === opId);
    return { run: job ? runView(job, this.progress.get(job.id)) : null };
  }
  /** A run may be asked for: cloud models on, and nothing else waiting or running for the meeting (but an automatic run that waits). */
  private ready(active: ListedJob | null, allowAuto: boolean) {
    if (!this.options.enabled) throw fail(400, 'cloud off', 'Planning needs the cloud models, which are off.');
    if (active && !(allowAuto && active.state === 'waiting' && active.kind === 'plan' && jobData(active).origin === 'auto')) {
      throw fail(409, 'busy', active.kind === 'explore' ? 'Explore further is running for this meeting; try again when it is done.' : 'Plans are being made for this meeting; try again when they are done.');
    }
  }
  private submit(meetingId: string, kind: ExplorationKind, data: PlanJobData) {
    return this.options.explorations.submit(meetingId, { kind, key: kind === 'explore' ? data.plan! : 'plan', data, work: this.work(meetingId, kind, data) });
  }

  /** Plan, or Plan again: a new run based on the newest version. It replaces a waiting automatic run (§2b). */
  async start(meetingId: string, request: { opId?: unknown }) {
    const replayed = this.replay(meetingId, 'plan', request.opId);
    if (replayed) return replayed;
    const opId = request.opId as string;
    return this.once(meetingId, 'plan', opId, async () => {
      this.ready(activeJob(this.jobs(meetingId)), true);
      if (!(await this.options.notes.file(meetingId).load())) throw fail(400, 'no notes', 'Write the notes first: plans are made from them.');
      const jobs = this.jobs(meetingId);
      this.ready(activeJob(jobs), true);
      for (const id of onManualPlan(this.runs(jobs)).cancel) await this.options.explorations.cancel(meetingId, id);
      const job = await this.submit(meetingId, 'plan', { origin: 'manual', opId, base: null, plan: null, label: null, notesVersion: null });
      return { run: runView(this.listed(job), this.progress.get(job.id)), replayed: false as const };
    });
  }

  /** Explore further on one plan of the newest version, only on the user's click; its result replaces that plan in a new version. */
  async explore(meetingId: string, versionNumber: number, planId: string, request: { opId?: unknown }) {
    const replayed = this.replay(meetingId, 'explore', request.opId);
    if (replayed) return replayed;
    const opId = request.opId as string;
    return this.once(meetingId, 'explore', opId, async () => {
      this.ready(activeJob(this.jobs(meetingId)), false);
      const latest = (await this.versions(meetingId)).at(-1) ?? null;
      if (!latest || latest.version !== versionNumber) throw fail(409, 'version', 'These plans changed since they were shown; explore the plans shown now.', { current: latest?.version ?? null });
      const plan = latest.plans.find(p => p.id === planId);
      if (!plan) throw fail(404, 'no plan', 'No such plan in this version.');
      if (plan.further?.state !== 'ready') throw fail(409, 'not ready', 'This plan has nothing ready to explore further.');
      this.ready(activeJob(this.jobs(meetingId)), false);
      const job = await this.submit(meetingId, 'explore', { origin: 'manual', opId, base: latest.version, plan: plan.id, label: plan.label ?? plan.question, notesVersion: null });
      return { run: runView(this.listed(job), this.progress.get(job.id)), replayed: false as const };
    });
  }

  async cancel(meetingId: string, runId: string) {
    const job = await this.options.explorations.cancel(meetingId, runId);
    return { run: runView(this.listed(job), this.progress.get(job.id)) };
  }

  /** Add to to-dos (§2b): the result of this operation (or of its first try) and the step's state now, which the page shows. */
  async add(meetingId: string, versionNumber: number, stepId: string, request: { expect?: unknown; opId?: unknown }) {
    const version = await this.version(meetingId, versionNumber);
    const project = this.options.projects.projectOf(meetingId);
    const result = this.options.todos.accept(version, stepId, { opId: request.opId as string, expect: request.expect as number, project });
    if (!result.replayed) this.options.changed(result.project);
    return { result, todo: this.options.todos.states(version, project)[stepId] };
  }
  /** Undo of a to-do just added, by its step (PlanTodos.undo); a repeated operation id returns the first result. */
  async undo(meetingId: string, versionNumber: number, stepId: string, request: { opId?: unknown; expect?: unknown }) {
    const version = await this.version(meetingId, versionNumber);
    const project = this.options.projects.projectOf(meetingId);
    const before = this.options.todos.states(version, project)[stepId];
    const undone = this.options.todos.undo(version, stepId, { opId: request.opId as string, expect: request.expect as number, project });
    const touched = before && 'project' in before ? before.project : project;
    if (touched) this.options.changed(touched);
    return { batch: undone.batch, todo: this.options.todos.states(version, project)[stepId] };
  }

  // ---------- Automatic planning (§2b) ----------

  /** New notes were saved: with "Plan after the notes" on, one automatic attempt per notes version. */
  async notesSaved(meetingId: string) {
    return this.admit(meetingId, () => this.autoNotes(meetingId));
  }
  private async autoNotes(meetingId: string) {
    if (!this.options.enabled) return;
    const projectId = this.options.projects.projectOf(meetingId);
    if (!projectId || !this.options.final(meetingId)) return;
    const record = await this.options.notes.file(meetingId).load();
    if (!record) return;
    const jobs = this.jobs(meetingId);
    const runs = this.runs(jobs);
    const decision = onNotes({ enabled: this.options.projects.get(projectId).planAfterNotes, notesVersion: record.version,
      attempted: this.options.auto.attempted(meetingId, record.version), runs });
    if (!decision.submit) { if (runs.some(r => r.state === 'running')) this.deferred.add(meetingId); return; }
    for (const id of decision.cancel) await this.options.explorations.cancel(meetingId, id);
    const current = await this.options.notes.file(meetingId).load();
    // Cancellation persistence yields: setting, notes and competing work may all have changed meanwhile.
    if (this.options.projects.projectOf(meetingId) !== projectId || !this.options.final(meetingId) || current?.version !== record.version
      || !this.options.projects.get(projectId).planAfterNotes || activeJob(this.jobs(meetingId))) return;
    // Inside the admission chain, after all early returns. A failed submission is not an attempt.
    if (!this.options.auto.claim(meetingId, record.version)) return;
    let job: ExplorationJob;
    try {
      job = await this.submit(meetingId, 'plan', { origin: 'auto', opId: null, base: null, plan: null, label: null, notesVersion: record.version });
    } catch (error) {
      this.options.auto.release(meetingId, record.version);
      throw error;
    }
    // Once a run exists, keep its claim even if this write fails; startup reconciles it from the run record.
    this.options.auto.started(meetingId, record.version, job.id);
  }
  /** The setting was turned off: only waiting automatic runs of the project's meetings are cancelled. */
  async settingOff(projectId: string) {
    for (const meeting of this.options.store.meetings()) {
      if (this.options.projects.projectOf(meeting.id) !== projectId) continue;
      await this.admit(meeting.id, async () => {
        for (const id of onSettingOff(this.runs(this.jobs(meeting.id))).cancel) await this.options.explorations.cancel(meeting.id, id);
      });
    }
  }
  /** A run ended (Explorations' onEnd): an automatic attempt that waited for it may go now. */
  ended(job: Readonly<ExplorationJob>) {
    this.progress.delete(job.id);
    if (!this.deferred.delete(job.meetingId)) return;
    void this.notesSaved(job.meetingId).catch(error => console.warn(`Plan after the notes: ${(error as Error).message}`));
  }

  // ---------- The run ----------

  private async tools(kind: ExplorationKind, ctx: ExplorationContext) {
    const warnings: string[] = [];
    let python = true;
    if (this.options.python) {
      try { await ctx.wait(this.options.python()); }
      catch (error) { if (ctx.signal.aborted) throw error; python = false; warnings.push(`Quick checks were off for this run: ${(error as Error).message}`); }
    }
    const tools = [PLAN_TOOLS.files, ...(this.options.web() ? [PLAN_TOOLS.web] : []), ...(python ? [PLAN_TOOLS.python] : [])].join(',');
    const limits = PYTHON_LIMITS[kind];
    return { tools, extensions: python ? [RUN_PYTHON] : [], env: { RUN_PYTHON_MS: String(limits.ms), RUN_PYTHON_MAX_RUNS: String(limits.runs) }, warnings };
  }
  /** Progress from the stream: material files read, web pages read, quick checks run. */
  private count(id: string, event: any) {
    if (event?.type !== 'tool_execution_end') return;
    const p = this.progress.get(id) ?? { files: 0, pages: 0, checks: 0 };
    if (event.toolName === 'read' || event.toolName === 'grep') p.files++;
    else if (event.toolName === 'fetch_content' || event.toolName === 'get_search_content') p.pages++;
    else if (event.toolName === 'run_python') p.checks++;
    this.progress.set(id, p);
  }

  /** The work of one run: from its pins to its publication. Throws on failure; a stop ends it through its Pi call. */
  private work(meetingId: string, kind: ExplorationKind, data: PlanJobData) {
    return async (ctx: ExplorationContext): Promise<PlanJobResult> => {
      const o = this.options;
      const view = join(ctx.cwd, 'pdf-text');
      try {
        const notes = await o.notes.file(meetingId).load();
        if (!notes) throw new Error('The meeting has no notes to plan from.');
        const project = o.projects.projectOf(meetingId);
        const materials = o.projects.rootsFor(meetingId);
        const roots = planRoots(materials);
        // The inputs as they are now, when the run is admitted (§2b "Pins"), and the PDF text of this run's own view.
        const pdfs = await ctx.wait(o.pdfText.prepare(materials, { waitMs: 60_000, view, signal: ctx.signal }));
        const stale = await ctx.wait(o.stale(meetingId).catch(() => false));
        const pins = await ctx.wait(pinRun({ notes, stale, project, memory: o.memory, roots, pdfText: o.pdfText }));
        const latest = (await this.versions(meetingId)).at(-1) ?? null;
        const base = kind === 'plan' ? latest?.version ?? null : data.base;
        const explored = kind === 'explore' ? (await this.versions(meetingId)).find(v => v.version === data.base) : undefined;
        const plan = explored?.plans.find(p => p.id === data.plan);
        if (kind === 'explore' && !plan) throw new Error('The plan to explore is no longer in its version.');
        const further = plan ? `\n\n${exploreInput(plan, explored!.evidence)}\n` : '';
        const built = await ctx.wait(Promise.resolve(buildPlanInput({ notes, title: o.store.meeting(meetingId).title, roots, pdfs,
          limit: INPUT_LIMIT - Buffer.byteLength(further), memory: project ? { brief: o.memory.brief(project)?.text ?? null, items: o.memory.items(project) } : null })));
        if ('refused' in built) throw new Error(`${built.refused}.`);
        const inputPath = join(ctx.folder, 'input.md');
        await ctx.wait(writeFile(inputPath, `${built.text}${further}`, { mode: 0o600 }));
        const evidence = new EvidenceRecorder(ctx.folder, { cwd: ctx.cwd, locate: materialLocator({ roots: built.refs.roots, view, pdfs }), eligible: o.materialEvidence });
        const tools = await this.tools(kind, ctx);
        const models = o.models ?? planModels();
        let answer: unknown;
        try {
          const result = checkCompleted(await ctx.pi(kind === 'plan' ? PLAN_PROMPT : EXPLORE_PROMPT, {
            model: models[kind], files: [inputPath], tools: tools.tools, extensions: tools.extensions, env: tools.env,
            onEvent: event => { evidence.piEvent(event); this.count(ctx.job.id, event); },
          }), kind === 'plan' ? 'The plan pass' : 'Explore further');
          try { answer = extractJson(result.text); } catch { throw new Error('The model\'s answer could not be read as plans.'); }
        } catch (error) {
          const until = o.cooldowns.pausedUntil('model');
          if (!ctx.signal.aborted && RATE_LIMIT.test((error as Error).message)) {
            throw new Error(`The model's quota is used up${until ? `; plans can be made again from ${clockTime(until)}` : ''}`);
          }
          throw error;
        }
        // Checked against what the tools returned; files whose lines changed since they were read are marked so.
        const saved = await evidence.read();
        const after = await materialsManifest(built.refs.roots, o.pdfText);
        const changed = await changedSinceRead(saved, built.refs.roots, { before: pins.materials, after, pdfText: o.pdfText });
        const moved = [...changedFiles(pins.materials, after)];
        const { materials: _manifest, ...planPins } = pins;
        const checked = checkPlans(answer, { run: ctx.job.id, refs: built.refs, evidence: saved, pins: planPins, changed });
        const doc = plansDocument(checked, { kind, base, plan: data.plan, createdAt: o.clock(), pins, finished: true, evidenceComplete: evidence.complete,
          warnings: [...(moved.length ? [`The materials changed during this run (${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}).`] : []),
            ...built.warnings, ...tools.warnings] });
        ctx.signal.throwIfAborted();
        await saveRunPlans(ctx.folder, doc);
        ctx.signal.throwIfAborted();
        const published = await o.versions.publish(meetingId, doc, ctx.commit);
        if ('published' in published) return { outcome: 'published', version: published.published.version };
        if ('conflict' in published) return { outcome: 'kept', newest: published.conflict.newest };
        return { outcome: 'refused', message: published.refused };
      } finally { await rm(view, { recursive: true, force: true }).catch(() => {}); }
    };
  }
}
