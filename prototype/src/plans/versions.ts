// Stored plans (M7b §2b "Runs, versions, pins"): a run's checked result is its `plans.json`; a meeting has a sequence of
// published versions (1, 2, …), each published by compare-and-swap on the version it was based on. Plan again replaces the
// newest version; Explore further replaces one plan in a new version and carries the others over unchanged, each with its
// origin, its origin's pins and its evidence. Freshness and project eligibility are per plan, from its origin's pins.
import { createHash, randomUUID } from 'node:crypto';
import { linkSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materialManifest } from '../actions.ts';
import type { Memory } from '../memory.ts';
import type { PdfText } from '../pdf-text.ts';
import { isPdf } from '../pdf-text.ts';
import { blockHash, type LineBlock, type MaterialEvidence, type SavedEvidence } from './evidence.ts';
import { PLAN_PROMPT_VERSION } from './prompt.ts';
import { notesWarnings, type RootRef } from './input.ts';
import type { NotesRecord } from '../notes.ts';
import { entriesOf, type CheckedPlan, type CheckedRun, type PlanPins, type Registry, type RunStatus } from './validate.ts';

export const PLANS_SCHEMA = 1;
export type ExplorationKind = 'plan' | 'explore';
/** The materials when a run was admitted: each root's short id, and each file's size and time (and a PDF's extraction). */
export type Manifest = { roots: Pick<RootRef, 'ref' | 'id' | 'path' | 'kind'>[]; files: Record<string, string>; complete: boolean; digest: string };
/** A run's pins: each plan keeps these but the full manifest, which stays with the run. */
export type RunPins = PlanPins & { materials: Manifest };
/** A run's `plans.json`. `complete`: Pi finished normally, its answer parsed and was checked, and its evidence was saved. */
export type PlansDocument = Omit<CheckedRun, 'run'> & {
  schema: typeof PLANS_SCHEMA; run: string; kind: ExplorationKind; prompt: string;
  /** The version it was based on (null: none yet); for Explore further, the plan it replaces. */
  base: number | null; plan: string | null;
  createdAt: number; complete: boolean; pins: RunPins; warnings: string[];
};
export type PublishedVersion = {
  schema: typeof PLANS_SCHEMA; meetingId: string; version: number; base: number | null; publishedAt: number;
  /** The run that made this version, and what it did. */
  run: string; kind: ExplorationKind; plan: string | null;
  status: RunStatus; warnings: string[];
  plans: CheckedPlan[]; evidence: Registry;
  deferred: CheckedRun['deferred']; notCovered: CheckedRun['notCovered']; dropped: CheckedRun['dropped']; review: string[];
};
export type PublishResult = { published: PublishedVersion } | { conflict: { newest: number | null } } | { refused: string };

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

/** The roots' files as `R1/path` → size:time (with a PDF's extraction version), bounded as the actions' manifest is. */
export async function materialsManifest(roots: RootRef[], pdfText?: PdfText): Promise<Manifest> {
  const files: Record<string, string> = {};
  let complete = true;
  for (const root of roots) {
    const listed = await materialManifest([{ id: root.id, scope: '', path: root.path, kind: root.kind, label: root.label }]);
    complete &&= listed.complete;
    for (const [abs, sig] of listed.files) {
      const key = `${root.ref}/${root.kind === 'file' ? root.label : abs.slice(root.path.length + 1)}`;
      const pdf = pdfText && isPdf(abs) ? (await pdfText.meta(abs).catch(() => null))?.version ?? 'no text' : null;
      files[key] = pdf ? `${sig}:${pdf}` : sig;
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const rootList = roots.map(r => ({ ref: r.ref, id: r.id, path: r.path, kind: r.kind }));
  return { roots: rootList, files: sorted, complete, digest: sha([rootList, sorted, complete]) };
}
/** Files whose entry changed or that are gone since `before` ("R1/path"): their quotes are marked "changed since it was read". */
export function changedFiles(before: Manifest, after: Manifest): Set<string> {
  return new Set(Object.keys(before.files).filter(key => after.files[key] !== before.files[key]));
}

/**
 * After a run: the files ("R1/path") whose lines as read differ now from what the run saved, whatever their size and time
 * say (an edit of the same length with its time put back is caught), plus any whose manifest entry changed. Each read's saved
 * text is compared with the live text at the same lines (a line a grep shortened, by its start). Change detection only: quotes
 * are always checked against the saved evidence. A PDF's live text is its current extraction, when `pdfText` is given.
 */
export async function changedSinceRead(evidence: SavedEvidence, roots: RootRef[], options: { before?: Manifest; after?: Manifest; pdfText?: PdfText; waitMs?: number } = {}): Promise<Set<string>> {
  const changed = options.before && options.after ? changedFiles(options.before, options.after) : new Set<string>();
  const live = new Map<string, Promise<string[] | null>>();
  const linesOf = (item: MaterialEvidence): Promise<string[] | null> => {
    const root = roots.find(r => r.ref === item.root);
    const key = `${item.root}/${item.path}`;
    if (!live.has(key)) live.set(key, (async () => {
      if (item.pdf) {
        if (!root || !options.pdfText) return null;
        const read = await options.pdfText.read(root.kind === 'file' ? root.path : join(root.path, item.path), { waitMs: options.waitMs ?? 10_000 });
        return 'problem' in read ? [] : read.text.split('\n');
      }
      return readFile(item.abs, 'utf8').then(t => t.split('\n'), () => []);
    })());
    return live.get(key)!;
  };
  for (const item of evidence.items) {
    if (item.tool !== 'read' && item.tool !== 'grep') continue;
    const key = `${item.root}/${item.path}`;
    if (changed.has(key)) continue;
    const now = await linesOf(item);
    if (now === null) continue; // a PDF without its live text: the manifest says whether it changed
    const cut = new Set(item.cutLines ?? []);
    const nowBlocks = item.blocks.map(b => ({ from: b.from, lines: b.lines.map((_, i) => now[b.from + i - 1]) }));
    const same = cut.size
      ? item.blocks.every((b, j) => b.lines.every((l, i) => { const n = nowBlocks[j].lines[i]; return n !== undefined && (cut.has(b.from + i) ? n.startsWith(l) : n === l); }))
      : nowBlocks.every(b => b.lines.every(l => l !== undefined)) && blockHash(nowBlocks as LineBlock[]) === item.hash;
    if (!same) changed.add(key);
  }
  return changed;
}

/**
 * The project memory's stamp: what a plans run reads of it, every open item (its id, version, status, text and owner) and the
 * brief's version. A run pins it at admission. To compare a published version with memory now, pass the to-dos added from that
 * very version (PlanTodos.addedFrom): while nobody has changed them, adding a step does not make its own plans out of date.
 * Nothing else is left out, so a to-do another version added, which a later run read, counts like any other item.
 */
export function memoryStamp(memory: Memory, project: string, exempt: ReadonlySet<string> = new Set()): string {
  const items = memory.items(project).filter(i => (i.status === 'open' || i.status === 'in force') && !(exempt.has(i.id) && i.version === 1))
    .map(i => [i.id, i.version, i.status, i.text, i.owner]);
  return sha([items, memory.brief(project)?.version ?? null]).slice(0, 32);
}

/**
 * A run's pins, taken when it is admitted (§2b "Pins"): the notes version and their warnings, the memory's stamp, the materials
 * manifest, and the project the meeting belongs to then (none: no project).
 */
export async function pinRun(options: { notes: Pick<NotesRecord, 'version' | 'input'>; stale?: boolean; project: string | null; memory: Memory | null;
  roots: RootRef[]; pdfText?: PdfText }): Promise<RunPins> {
  const materials = await materialsManifest(options.roots, options.pdfText);
  return { notesVersion: options.notes.version, notesWarnings: notesWarnings(options.notes, options.stale), project: options.project,
    memoryStamp: options.project && options.memory ? memoryStamp(options.memory, options.project) : null, manifest: materials.digest, materials };
}

/**
 * The inputs now, to compare plans with. `memoryStamps` is the memory's stamp per origin run (currentPins): a version carries
 * plans of several runs (Explore further), and each run read memory at its own time.
 */
export type CurrentPins = { notesVersion: number | null; memoryStamp: string | null; memoryStamps?: Record<string, string | null>; manifest: string };

/**
 * The inputs now for a meeting's plans. The memory's stamp is made per origin run: each leaves out the to-dos added (and not
 * changed since) from the versions that carry that run's plans, which its run cannot have read; every other to-do counts, so a
 * plan whose run read a to-do sees it complete. `versions`: the meeting's published versions (PlanVersions.get).
 */
export function currentPins(options: { notesVersion: number | null; manifest: string; memory: Memory | null; project: string | null; meetingId: string;
  todos: { addedFrom(meetingId: string, version: number, project: string): Set<string> }; versions: PublishedVersion[] }): CurrentPins {
  const { memory, project } = options;
  if (!memory || !project) return { notesVersion: options.notesVersion, manifest: options.manifest, memoryStamp: null };
  const runs = new Set(options.versions.flatMap(v => v.plans.map(p => p.origin.run)));
  const memoryStamps: Record<string, string | null> = {};
  for (const run of runs) {
    const exempt = new Set(options.versions.filter(v => v.plans.some(p => p.origin.run === run)).flatMap(v => [...options.todos.addedFrom(options.meetingId, v.version, project)]));
    memoryStamps[run] = memoryStamp(memory, project, exempt);
  }
  return { notesVersion: options.notesVersion, manifest: options.manifest, memoryStamp: memoryStamp(memory, project), memoryStamps };
}
const CHANGED = { notes: 'the notes', memory: 'the memory', materials: 'the materials' } as const;
/**
 * Whether a plan was made from the current inputs; otherwise what changed since, and its label (with Plan again). `current` is
 * now's (currentPins): the notes version, the memory's stamp for the plan's own origin run, and the manifest's digest.
 */
export function freshness(plan: Pick<CheckedPlan, 'originPins' | 'origin'>, current: CurrentPins) {
  const pins = plan.originPins;
  const memoryNow = current.memoryStamps && plan.origin.run in current.memoryStamps ? current.memoryStamps[plan.origin.run] : current.memoryStamp;
  const changed = (Object.keys(CHANGED) as (keyof typeof CHANGED)[]).filter(k =>
    k === 'notes' ? pins.notesVersion !== current.notesVersion : k === 'memory' ? pins.memoryStamp !== memoryNow : pins.manifest !== current.manifest);
  const words = changed.map(k => CHANGED[k]);
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return { current: !changed.length, changed, label: changed.length ? `Made before ${list} changed` : null };
}

/** The checked result of a run as its `plans.json`. */
export function plansDocument(checked: CheckedRun, meta: {
  kind: ExplorationKind; base: number | null; plan?: string | null; createdAt: number; pins: RunPins; warnings?: string[];
  /** Pi finished normally (checkCompleted) and the evidence was saved in full (EvidenceRecorder.complete). */
  finished: boolean; evidenceComplete: boolean;
}): PlansDocument {
  return { ...checked, schema: PLANS_SCHEMA, prompt: PLAN_PROMPT_VERSION, kind: meta.kind, base: meta.base, plan: meta.plan ?? null, createdAt: meta.createdAt,
    complete: meta.finished && meta.evidenceComplete, pins: meta.pins,
    warnings: [...(meta.warnings ?? []), ...meta.pins.notesWarnings, ...(meta.evidenceComplete ? [] : ['Not all evidence could be saved.'])] };
}
export async function saveRunPlans(folder: string, doc: PlansDocument) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeAtomic(join(folder, 'plans.json'), JSON.stringify(doc));
}
export async function loadRunPlans(folder: string): Promise<PlansDocument | null> {
  try { return JSON.parse(await readFile(join(folder, 'plans.json'), 'utf8')); } catch { return null; }
}

/** Renames a plan and its steps (Explore further's result takes the id of the plan it replaces). */
function renamed(plan: CheckedPlan, id: string): CheckedPlan {
  return { ...plan, id, steps: plan.steps.map(s => ({ ...s, id: s.id.replace(/^[^.]+/, id) })) };
}

/**
 * A meeting's published versions, one immutable file each (<data>/plans/<meeting>/<n>.json). Publishing is compare-and-swap:
 * one at a time per meeting here, and the new file is linked into place, so a version number is never written twice.
 */
export class PlanVersions {
  private directory: string;
  private clock: () => number;
  private chains = new Map<string, Promise<unknown>>();
  constructor(directory: string, clock: () => number = Date.now) { this.directory = directory; this.clock = clock; }
  private folder(meetingId: string) {
    if (!/^[\w-]{1,64}$/.test(meetingId)) throw fail(400, 'Unknown meeting.');
    return join(this.directory, 'plans', meetingId);
  }
  /** The published version numbers, oldest first. */
  async list(meetingId: string): Promise<number[]> {
    const names = await readdir(this.folder(meetingId)).catch(() => [] as string[]);
    return names.map(n => /^(\d+)\.json$/.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b);
  }
  async get(meetingId: string, version: number): Promise<PublishedVersion | null> {
    if (!Number.isInteger(version) || version < 1) return null;
    try { return JSON.parse(await readFile(join(this.folder(meetingId), `${version}.json`), 'utf8')); } catch { return null; }
  }
  async latest(meetingId: string): Promise<PublishedVersion | null> {
    const n = (await this.list(meetingId)).at(-1);
    return n === undefined ? null : this.get(meetingId, n);
  }

  /**
   * Publishes a complete run's plans as the next version, if the newest version is still the one it was based on; otherwise
   * nothing changes ("a newer version exists"; the run stays in the history). Plan again replaces every plan; Explore
   * further replaces plan `doc.plan` of its base version with its own first plan and carries the others over.
   */
  publish(meetingId: string, doc: PlansDocument, commit: <T>(write: () => T) => T = write => write()): Promise<PublishResult> {
    const folder = this.folder(meetingId);
    const work = (this.chains.get(meetingId) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<PublishResult> => {
      if (doc.schema !== PLANS_SCHEMA) return { refused: 'These plans were saved in a format this version does not read.' };
      if (!doc.complete) return { refused: 'The run did not complete; its plans are kept for the record but not published.' };
      const newest = (await this.list(meetingId)).at(-1) ?? null;
      if (newest !== doc.base) return { conflict: { newest } };
      const version = (newest ?? 0) + 1;
      let plans: CheckedPlan[], evidence: Registry, rest: Pick<PublishedVersion, 'status' | 'deferred' | 'notCovered' | 'dropped' | 'review' | 'warnings'>;
      const own = (p: CheckedPlan): CheckedPlan => ({ ...p, origin: { run: doc.run, version } });
      if (doc.kind === 'explore') {
        const base = doc.base === null ? null : await this.get(meetingId, doc.base);
        if (!base || !doc.plan || !base.plans.some(p => p.id === doc.plan)) return { refused: 'The plan this run explored is not in its version.' };
        const result = doc.plans[0];
        if (!result) return { refused: 'Explore further found no plan that passed its checks; the plan stays as it was.' };
        const fresh = own(renamed(result, doc.plan));
        plans = base.plans.map(p => p.id === doc.plan ? fresh : p);
        // Carried plans bring their own entries; the new plan's come from its run (ids are run-qualified, so none collide).
        evidence = Object.assign({}, ...base.plans.filter(p => p.id !== doc.plan).map(p => entriesOf(p, base.evidence)),
          Object.fromEntries(Object.entries(entriesOf(result, doc.evidence)).map(([id, e]) => [id, { ...e, plan: doc.plan! }])));
        rest = { status: 'plans', deferred: base.deferred, notCovered: base.notCovered, dropped: base.dropped,
          review: [...base.review, ...doc.review, ...(doc.plans.length > 1 ? [`Explore further returned ${doc.plans.length} plans; the first replaced ${doc.plan}.`] : [])],
          warnings: [...new Set([...base.warnings, ...doc.warnings])] };
      } else {
        plans = doc.plans.map(own);
        evidence = Object.assign({}, ...plans.map(p => entriesOf(p, doc.evidence)));
        rest = { status: doc.status, deferred: doc.deferred, notCovered: doc.notCovered, dropped: doc.dropped, review: doc.review, warnings: doc.warnings };
      }
      const published: PublishedVersion = { schema: PLANS_SCHEMA, meetingId, version, base: doc.base, publishedAt: this.clock(), run: doc.run, kind: doc.kind, plan: doc.plan,
        ...rest, plans, evidence };
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const tmp = join(folder, `.${version}.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(published), { mode: 0o600 });
      // The only visibility boundary. The run checks cancellation here, inside this meeting's publication queue.
      // linkSync keeps that check and the irreversible link in one JS turn; cancellation after it is a published run.
      try { commit(() => linkSync(tmp, join(folder, `${version}.json`))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { conflict: { newest: (await this.list(meetingId)).at(-1) ?? null } };
        throw error;
      } finally { await rm(tmp, { force: true }).catch(() => {}); }
      return { published };
    });
    this.chains.set(meetingId, work);
    return work;
  }
}
