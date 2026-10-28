// Add to to-dos (M7b §1 decision 3, §2b "Add to to-dos"): a step of a published version becomes one to-do in the project's
// memory, once. The to-do and its acceptance record are written in one transaction, through Memory.apply, with a source of
// its own kind (`plan`). Acceptances have generations, so Undo and Add again work, and a delayed retry of an old operation
// returns its old result and never creates anything. A step of another version with the same payload reuses the to-do.
// These to-dos are the user's (actor "user", never in memory_effects), so notes regeneration and proposals.ts never retract them.
import { createHash } from 'node:crypto';
import { TEXT_LIMIT, cleanText, transaction, type Memory } from '../memory.ts';
import type { MeetingStore } from '../store.ts';
import type { CheckedPlan, Step } from './validate.ts';
import type { PublishedVersion } from './versions.ts';

/** What a to-do from a step says and where it goes; equal payloads are the same to-do, whatever version they come from. */
export type TodoPayload = {
  /** The plan's question and the notes it cites, so equal wording under another question never matches. */
  question: string; from: { section: string; text: string }[];
  /** The full text; a follow-on keeps its condition ("If …: …"), so it never becomes an unconditional task. */
  text: string; if: string | null;
  owner: string | null; project: string;
};
/** Why a step cannot become a to-do now; also the `code` of the refusal (status 409, 413, 400 and 409). */
export type Refusal = 'unchecked' | 'too long' | 'no project' | 'other project';
export type TodoState =
  | { state: 'add'; generation: number }
  | { state: 'in to-dos' | 'already in to-dos'; generation: number; todo: string; project: string }
  | { state: 'not eligible'; generation: number; reason: string; code: Refusal };
export type AcceptResult = {
  state: 'in to-dos' | 'already in to-dos'; todo: string; project: string; generation: number; batch: string;
  /** A new to-do was made by this operation (false: an equal payload's to-do was reused). */
  created: boolean;
  /** A repeated operation id: this is its first result, as it was; nothing was done now. */
  replayed?: boolean;
};

/** Errors carry their HTTP status and a `code` the page can act on; a generation conflict also carries the step's state now. */
const fail = (status: number, code: string, message: string, extra: object = {}) => Object.assign(new Error(message), { status, code, ...extra });
export const todoText = (step: Pick<Step, 'kind' | 'if' | 'text'>) => cleanText(step.kind === 'follow' && step.if ? `If ${step.if}: ${step.text}` : step.text);
export function stepPayload(plan: CheckedPlan, step: Step, project: string): TodoPayload {
  return { question: plan.question, from: plan.fromItems.map(f => ({ section: f.section, text: f.text })), text: todoText(step), if: step.if, owner: plan.owner, project };
}
export const payloadHash = (payload: TodoPayload) => createHash('sha256').update(JSON.stringify([payload.question, payload.from, payload.text, payload.if, payload.owner, payload.project])).digest('hex');

/**
 * Whether a step may become a to-do now, and into which project (checked by the server, for operations that would create one):
 * the step checked out (or rests on nothing quoted), its text fits the memory limit, and the meeting is in a project. Plans
 * made with no project go into the meeting's project now; plans made in project A, for a meeting now in B, need Plan again.
 */
export function eligibility(plan: CheckedPlan, step: Step, currentProject: string | null): { project: string } | { reason: string; status: number; code: Refusal } {
  if (step.check === 'unchecked') return { reason: 'This step\'s sources did not check out, so it cannot be added to to-dos.', status: 409, code: 'unchecked' };
  const text = todoText(step);
  if (text.length > TEXT_LIMIT) return { reason: `This step is too long for a to-do (${text.length} characters; at most ${TEXT_LIMIT}). Write the to-do yourself in the project.`, status: 413, code: 'too long' };
  if (!currentProject) return { reason: 'Move this meeting to a project to add its steps to to-dos.', status: 400, code: 'no project' };
  const origin = plan.originPins.project;
  if (origin && origin !== currentProject) return { reason: 'These plans were made in another project. Plan again to add steps here.', status: 409, code: 'other project' };
  return { project: currentProject };
}

type Row = { id: string; meetingId: string; version: number; step: string; generation: number; payloadHash: string; project: string; todo: string;
  batch: string; opId: string; aliasOf: string | null; result: string; createdAt: number };

/** One row per acceptance (a generation of a step), in the meetings database beside memory. */
export class PlanTodos {
  private store: MeetingStore;
  private memory: Memory;
  private clock: () => number;
  constructor(store: MeetingStore, memory: Memory, clock: () => number = Date.now) {
    this.store = store; this.memory = memory; this.clock = clock;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_acceptances (id TEXT PRIMARY KEY, meetingId TEXT NOT NULL, version INTEGER NOT NULL, step TEXT NOT NULL,
        generation INTEGER NOT NULL, payloadHash TEXT NOT NULL, payload TEXT NOT NULL, project TEXT NOT NULL, todo TEXT NOT NULL, batch TEXT NOT NULL,
        opId TEXT NOT NULL, aliasOf TEXT, result TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE (meetingId, version, step, generation));
      CREATE INDEX IF NOT EXISTS plan_acceptances_payload ON plan_acceptances(meetingId, payloadHash);
      -- Every Add to to-dos that succeeded, by its operation id, with its result: creations, reuses and those that found the
      -- to-do already there. A repeated id returns this result and does nothing, whatever happened since (an Undo, a move).
      CREATE TABLE IF NOT EXISTS plan_operations (opId TEXT PRIMARY KEY, meetingId TEXT NOT NULL, version INTEGER NOT NULL, step TEXT NOT NULL,
        result TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }
  private get db() { return this.store.db; }
  private latest(meetingId: string, version: number, step: string): Row | undefined {
    return this.db.prepare('SELECT * FROM plan_acceptances WHERE meetingId=? AND version=? AND step=? ORDER BY generation DESC LIMIT 1').get(meetingId, version, step) as Row | undefined;
  }
  /** An acceptance stands while the memory batch that made its to-do is not undone (an alias follows the batch it reuses). */
  private active(row: Row) {
    const batch = this.db.prepare('SELECT undoneBy FROM memory_batches WHERE id=? AND project=?').get(row.batch, row.project) as { undoneBy: string | null } | undefined;
    return Boolean(batch) && !batch!.undoneBy;
  }
  /** A standing acceptance of an equal payload from this meeting, made by another step (another version, another tab). */
  private equal(meetingId: string, hash: string, except?: { version: number; step: string }): Row | undefined {
    const rows = this.db.prepare('SELECT * FROM plan_acceptances WHERE meetingId=? AND payloadHash=? ORDER BY createdAt').all(meetingId, hash) as Row[];
    return rows.find(r => !(except && r.version === except.version && r.step === except.step) && this.active(r));
  }
  private find(version: PublishedVersion, stepId: string) {
    const plan = version.plans.find(p => p.steps.some(s => s.id === stepId));
    const step = plan?.steps.find(s => s.id === stepId);
    return plan && step ? { plan, step } : null;
  }

  /** The to-dos made from this version's steps (not reused ones): the memory stamp leaves them out while nobody changed them. */
  addedFrom(meetingId: string, version: number, project: string): Set<string> {
    return new Set((this.db.prepare('SELECT DISTINCT todo FROM plan_acceptances WHERE meetingId=? AND version=? AND project=? AND aliasOf IS NULL')
      .all(meetingId, version, project) as { todo: string }[]).map(r => r.todo));
  }
  /** What each step of a version shows: Add to to-dos, In to-dos, Already in to-dos (an equal step of another version), or why not. */
  states(version: PublishedVersion, currentProject: string | null): Record<string, TodoState> {
    const out: Record<string, TodoState> = {};
    for (const plan of version.plans) for (const step of plan.steps) {
      const row = this.latest(version.meetingId, version.version, step.id);
      const generation = row?.generation ?? 0;
      if (row && this.active(row)) { out[step.id] = { state: row.aliasOf ? 'already in to-dos' : 'in to-dos', generation, todo: row.todo, project: row.project }; continue; }
      const ok = eligibility(plan, step, currentProject);
      if ('reason' in ok) { out[step.id] = { state: 'not eligible', generation, reason: ok.reason, code: ok.code }; continue; }
      const same = this.equal(version.meetingId, payloadHash(stepPayload(plan, step, ok.project)), { version: version.version, step: step.id });
      out[step.id] = same ? { state: 'already in to-dos', generation, todo: same.todo, project: same.project } : { state: 'add', generation };
    }
    return out;
  }

  /**
   * Add to to-dos on a step. `expect` is the generation the page saw (0 when never added); `opId` identifies this operation.
   * A repeated `opId` returns its first result, even after a move or an Undo. Otherwise, against a current generation that
   * stands, nothing is made (its to-do is returned); against one that was undone (or none), the step is checked and either
   * an equal standing payload is reused (recorded as an alias) or one to-do is made, as generation n+1.
   */
  accept(version: PublishedVersion, stepId: string, request: { opId: string; expect: number; project: string | null }): AcceptResult {
    if (typeof request.opId !== 'string' || !/^[\w:-]{8,100}$/.test(request.opId)) throw fail(400, 'bad request', 'An Add to to-dos needs an operation id.');
    if (!Number.isInteger(request.expect) || request.expect < 0) throw fail(400, 'bad request', 'Say which generation of the step you saw.');
    const meetingId = version.meetingId;
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM plan_operations WHERE opId=?').get(request.opId) as { meetingId: string; version: number; step: string; result: string } | undefined;
      if (previous) {
        if (previous.meetingId !== meetingId || previous.version !== version.version || previous.step !== stepId) throw fail(409, 'op reused', 'This operation id was already used for another step.');
        return { ...JSON.parse(previous.result), replayed: true } as AcceptResult;
      }
      const done = (result: AcceptResult) => {
        this.db.prepare('INSERT INTO plan_operations (opId,meetingId,version,step,result,at) VALUES (?,?,?,?,?,?)')
          .run(request.opId, meetingId, version.version, stepId, JSON.stringify(result), this.clock());
        return result;
      };
      const found = this.find(version, stepId);
      if (!found) throw fail(404, 'no step', 'No such step in this version of the plans.');
      const row = this.latest(meetingId, version.version, stepId);
      const generation = row?.generation ?? 0;
      if (generation !== request.expect) throw fail(409, 'generation', 'This step changed since you saw it.', { current: this.states(version, request.project)[stepId] });
      if (row && this.active(row)) {
        return done({ state: row.aliasOf ? 'already in to-dos' : 'in to-dos', todo: row.todo, project: row.project, generation, batch: row.batch, created: false });
      }
      const ok = eligibility(found.plan, found.step, request.project);
      if ('reason' in ok) throw fail(ok.status, ok.code, ok.reason);
      const payload = stepPayload(found.plan, found.step, ok.project);
      const hash = payloadHash(payload);
      const at = this.clock();
      const insert = (result: AcceptResult, aliasOf: string | null) => {
        this.db.prepare('INSERT INTO plan_acceptances (id,meetingId,version,step,generation,payloadHash,payload,project,todo,batch,opId,aliasOf,result,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(`${meetingId}:${version.version}:${stepId}:${result.generation}`, meetingId, version.version, stepId, result.generation, hash, JSON.stringify(payload),
            result.project, result.todo, result.batch, request.opId, aliasOf, JSON.stringify(result), at);
        return done(result);
      };
      // Two tabs adding equal steps of different versions: the second reuses the first's to-do instead of making another.
      const same = this.equal(meetingId, hash);
      if (same) return insert({ state: 'already in to-dos', todo: same.todo, project: same.project, generation: generation + 1, batch: same.batch, created: false }, same.id);
      const made = this.memory.apply(ok.project, {
        requestId: `plan-todo:${request.opId}`, actor: 'user',
        changes: [{ op: 'create', type: 'todo', text: payload.text, owner: payload.owner, confirmed: true,
          source: { kind: 'plan', meetingId, run: found.plan.origin.run, version: version.version, step: stepId, payloadHash: hash } }],
      });
      const todo = Object.values(made.created)[0];
      return insert({ state: 'in to-dos', todo, project: ok.project, generation: generation + 1, batch: made.batch, created: true }, null);
    });
  }

  /**
   * Undo on a step that is in to-dos: the memory batch that made its to-do is undone (Memory.undo: refused if the to-do changed
   * since). The step then shows Add to to-dos again at the same generation. A repeated `opId` returns the first result. A step
   * that reused another step's to-do has no Undo of its own.
   */
  undo(version: PublishedVersion, stepId: string, request: { opId: string; expect: number; project: string | null }) {
    if (typeof request.opId !== 'string' || !/^[\w:-]{8,100}$/.test(request.opId)) throw fail(400, 'bad request', 'An Undo needs an operation id.');
    return transaction(this.db, () => {
      const requestId = `plan-undo:${request.opId}`;
      const row = this.latest(version.meetingId, version.version, stepId);
      const repeat = this.db.prepare('SELECT project, undoOf FROM memory_batches WHERE requestId=?').get(requestId) as { project: string; undoOf: string } | undefined;
      if (repeat) {
        const own = this.db.prepare('SELECT 1 FROM plan_acceptances WHERE meetingId=? AND version=? AND step=? AND batch=? AND aliasOf IS NULL')
          .get(version.meetingId, version.version, stepId, repeat.undoOf);
        if (!own) throw fail(409, 'op reused', 'This operation id was already used for another step.');
        return this.memory.undo(repeat.project, repeat.undoOf, requestId);
      }
      // Replay above precedes eligibility, including the generation the original page saw.
      if (!Number.isInteger(request.expect) || request.expect < 0) throw fail(400, 'bad request', 'Say which generation of the step you saw.');
      if ((row?.generation ?? 0) !== request.expect) throw fail(409, 'generation', 'This step changed since you saw it.', { current: this.states(version, request.project)[stepId] });
      if (!row || !this.active(row)) throw fail(409, 'not in to-dos', 'This step is not in to-dos.');
      // An equal step of another version made this to-do: its Undo is there, so this one cannot take it away from under it.
      if (row.aliasOf) throw fail(409, 'alias', `${row.todo} was added from another version of these plans; undo it there or in the project.`);
      return this.memory.undo(row.project, row.batch, requestId, 'user');
    });
  }
}
