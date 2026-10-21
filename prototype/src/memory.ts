import { createHash, randomUUID } from 'node:crypto';
import type { MeetingStore } from './store.ts';

/**
 * Project memory (docs/design/M6-memory.md §3): to-dos, decisions and questions, with every change kept as an event.
 * The current state (`memory_items`) and the change list (`memory_events`) are written in one transaction per batch, and the
 * state can always be rebuilt from the events (`rebuild`), so the events are the record. Nothing is ever deleted.
 */
export type ItemType = 'todo' | 'decision' | 'question';
export type Status = 'open' | 'done' | 'dropped' | 'in force' | 'superseded' | 'reversed' | 'answered' | 'merged';
export type Source =
  | { kind: 'meeting'; meetingId: string; notesVersion?: number; inputHash?: string; section?: string; index?: number; note?: string; lines?: unknown[]; quote?: string }
  | { kind: 'chat'; text: string }
  | { kind: 'app' }
  | { kind: 'file'; file: string; captureId?: string; lines?: string[] }
  | { kind: 'agent'; note: string; cites?: string }
  | { kind: 'commit'; hash: string; subject: string; paths?: string[]; guessed?: boolean; from?: Source }
  /** A step of a meeting's plans added with Add to to-dos (M7b §2b): shown as "from the plans of <meeting>", never as a note. */
  | { kind: 'plan'; meetingId: string; run: string; version: number; step: string; payloadHash: string }
  | { kind: 'undo'; batch: string };
export type Fields = { due?: string; conditions?: string; answer?: string; supersedes?: string; supersededBy?: string; reason?: string };
export type Item = {
  project: string; id: string; type: ItemType; status: Status; text: string; owner: string | null; fields: Fields;
  confirmed: boolean; mergedInto: string | null; version: number; createdAt: number; updatedAt: number;
};
export type Actor = 'ai' | 'user' | 'file' | `agent:${string}`;
export type Change =
  | { op: 'create'; ref?: string; type: ItemType; text: string; owner?: string | null; fields?: Fields; confirmed?: boolean; source: Source }
  | { op: 'edit'; item: string; text?: string; owner?: string | null; fields?: Fields; source: Source }
  | { op: 'status'; item: string; to: Status; reason?: string; source: Source }
  | { op: 'answer'; item: string; text: string; source: Source }
  | { op: 'supersede'; item: string; by: string; source: Source }
  | { op: 'addSource'; item: string; confirmed?: boolean; source: Source }
  | { op: 'merge'; item: string; into: string; source: Source }
  | { op: 'confirm'; item: string; event?: string };
export type Batch = { requestId: string; actor: Actor; changes: Change[]; expect?: Record<string, number> };
export type BatchResult = { batch: string; created: Record<string, string>; items: Item[] };
export type MemoryEvent = {
  id: string; batch: string; seq: number; project: string; item: string; op: string; before: Partial<Item> | null; after: Partial<Item> | null;
  source: Source | null; confirmed: boolean; ref: string | null; actor: Actor; at: number; undone: boolean;
};

const PREFIX: Record<ItemType, string> = { todo: 'T', decision: 'D', question: 'Q' };
export const INITIAL: Record<ItemType, Status> = { todo: 'open', decision: 'in force', question: 'open' };
/** Allowed status changes by `status` (supersede, answer and merge have their own ops). Back to the initial status is a reopening. */
const TRANSITIONS: Record<ItemType, Partial<Record<Status, Status[]>>> = {
  todo: { open: ['done', 'dropped'], done: ['open'], dropped: ['open'] },
  decision: { 'in force': ['reversed'], reversed: ['in force'], superseded: ['in force'] },
  question: { open: ['answered', 'dropped'], answered: ['open'], dropped: ['open'] },
};
/** Whether `status` may move an item of this type from one status to another (planning uses the same table as applying). */
export const allowedStatus = (type: ItemType, from: Status, to: Status) => Boolean(TRANSITIONS[type]?.[from]?.includes(to));
const fail = (status: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, ...extra });
const TRACKED = ['type', 'status', 'text', 'owner', 'fields', 'confirmed', 'mergedInto'] as const;
/** The longest text an item keeps; a longer text is cut by `apply`, so a caller that must not cut checks it first. */
export const TEXT_LIMIT = 600;
export const cleanText = (text: unknown) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clean = (text: unknown, max = TEXT_LIMIT) => cleanText(text).slice(0, max);

export class Memory {
  private store: MeetingStore;
  private clock: () => number;
  constructor(store: MeetingStore, clock: () => number = Date.now) {
    this.store = store;
    this.clock = clock;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (project TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL,
        owner TEXT, fields TEXT NOT NULL, confirmed INTEGER NOT NULL, mergedInto TEXT, version INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY (project, id));
      CREATE TABLE IF NOT EXISTS memory_batches (id TEXT PRIMARY KEY, project TEXT NOT NULL, requestId TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
        actor TEXT NOT NULL, reads TEXT NOT NULL, writes TEXT NOT NULL, result TEXT NOT NULL, undoOf TEXT, undoneBy TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events (id TEXT PRIMARY KEY, batch TEXT NOT NULL REFERENCES memory_batches(id), seq INTEGER NOT NULL,
        project TEXT NOT NULL, item TEXT NOT NULL, op TEXT NOT NULL, before TEXT, after TEXT, source TEXT, confirmed INTEGER NOT NULL DEFAULT 0,
        ref TEXT, at INTEGER NOT NULL, UNIQUE (batch, seq));
      CREATE INDEX IF NOT EXISTS memory_events_item ON memory_events(project, item);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_brief (project TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, actor TEXT NOT NULL,
        source TEXT, basedOn INTEGER, at INTEGER NOT NULL, PRIMARY KEY (project, version));
    `);
  }
  private get db() { return this.store.db; }

  items(project: string): Item[] {
    return (this.db.prepare('SELECT * FROM memory_items WHERE project=? ORDER BY type, CAST(substr(id, 3) AS INTEGER)').all(project) as Record<string, unknown>[]).map(row);
  }
  item(project: string, id: string): Item | undefined {
    const found = this.db.prepare('SELECT * FROM memory_items WHERE project=? AND id=?').get(project, id) as Record<string, unknown> | undefined;
    return found ? row(found) : undefined;
  }
  /** Every event of one item, oldest first: the item's timeline. */
  timeline(project: string, id: string): MemoryEvent[] {
    return (this.db.prepare(`SELECT e.*, b.actor AS actor, b.undoneBy AS undoneBy FROM memory_events e JOIN memory_batches b ON b.id = e.batch
      WHERE e.project=? AND e.item=? ORDER BY b.at, b.rowid, e.seq`).all(project, id) as Record<string, unknown>[]).map(eventRow);
  }
  events(project: string): MemoryEvent[] {
    return (this.db.prepare(`SELECT e.*, b.actor AS actor, b.undoneBy AS undoneBy FROM memory_events e JOIN memory_batches b ON b.id = e.batch
      WHERE e.project=? ORDER BY b.at, b.rowid, e.seq`).all(project) as Record<string, unknown>[]).map(eventRow);
  }

  /** One batch with its events (a proposal run checks whether what it recorded is still unconfirmed). */
  batch(project: string, id: string): { actor: Actor; undone: boolean; events: MemoryEvent[] } | null {
    const found = this.db.prepare('SELECT actor, undoneBy FROM memory_batches WHERE id=? AND project=?').get(id, project) as { actor: Actor; undoneBy: string | null } | undefined;
    if (!found) return null;
    const events = (this.db.prepare('SELECT e.*, b.actor AS actor, b.undoneBy AS undoneBy FROM memory_events e JOIN memory_batches b ON b.id = e.batch WHERE e.batch=? ORDER BY e.seq')
      .all(id) as Record<string, unknown>[]).map(eventRow);
    return { actor: found.actor, undone: Boolean(found.undoneBy), events };
  }
  /**
   * The user's own changes since `since` that are still standing (not undone, not an undo, not only confirmations), per item
   * with whether it closed the item: the Project tab keeps their Undo for its 15 s window across a reload.
   */
  recentUserChanges(project: string, since: number, exclude: Set<string>) {
    const batches = this.db.prepare("SELECT id, at FROM memory_batches WHERE project=? AND actor='user' AND undoOf IS NULL AND undoneBy IS NULL AND at>=? ORDER BY at").all(project, since) as { id: string; at: number }[];
    return batches.filter(b => !exclude.has(b.id)).flatMap(b => {
      const events = this.batch(project, b.id)?.events.filter(e => e.op !== 'confirm') ?? [];
      if (!events.length) return [];
      const ids = [...new Set(events.map(e => e.item))];
      return [{ batch: b.id, at: b.at, items: ids.map(id => ({ id, closing: !['open', 'in force'].includes(this.item(project, id)?.status ?? 'open') })) }];
    });
  }
  /** Whether a "raised again" link was confirmed. */
  linkConfirmed(project: string, eventId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM memory_events WHERE project=? AND op='addSource' AND id=? AND confirmed=1").get(project, eventId)
      || this.db.prepare("SELECT 1 FROM memory_events e JOIN memory_batches b ON b.id = e.batch WHERE e.project=? AND e.op='confirm' AND e.ref=? AND b.undoneBy IS NULL").get(project, eventId));
  }

  /**
   * Applies a batch of changes atomically. `expect` holds the version of every item the user saw; if any changed, nothing is
   * applied (409, "changed since"). A repeated request id returns the first result; the same id with other content is refused.
   */
  apply(project: string, batch: Batch): BatchResult {
    if (!batch.requestId || typeof batch.requestId !== 'string') throw fail(400, 'A change needs a request id.');
    if (!batch.changes?.length) throw fail(400, 'Nothing to change.');
    const digest = createHash('sha256').update(JSON.stringify([project, batch.actor, batch.changes, batch.expect ?? {}])).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM memory_batches WHERE requestId=?').get(batch.requestId) as { digest: string; result: string } | undefined;
      if (previous) {
        if (previous.digest !== digest) throw fail(409, 'This request id was already used for a different change.');
        return JSON.parse(previous.result) as BatchResult;
      }
      for (const [id, version] of Object.entries(batch.expect ?? {})) {
        const current = this.item(project, id);
        if (!current || current.version !== version) throw fail(409, `${id} changed since you saw it; review it again.`, { stale: id, current: current ?? null });
      }
      const at = this.clock();
      const batchId = randomUUID();
      const reads: Record<string, number> = {};
      const created: Record<string, string> = {};
      const work = new Map<string, Item>();
      const get = (ref: string): Item => {
        const id = created[ref] ?? ref;
        if (!work.has(id)) {
          const found = this.item(project, id);
          if (!found) throw fail(400, `No item ${ref} in this project.`);
          reads[id] = found.version;
          work.set(id, found);
        }
        return work.get(id)!;
      };
      // Creates first, so a change may refer to an item made in the same batch by its ref ("supersede D-4 by new1").
      for (const change of batch.changes) {
        if (change.op !== 'create') continue;
        if (!PREFIX[change.type]) throw fail(400, 'Unknown item type.');
        const id = `${PREFIX[change.type]}-${this.nextNumber(project, change.type)}`;
        if (change.ref) { if (created[change.ref]) throw fail(400, `Two new items share the name ${change.ref}.`); created[change.ref] = id; }
        else created[id] = id;
      }
      this.db.prepare('INSERT INTO memory_batches (id,project,requestId,digest,actor,reads,writes,result,at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(batchId, project, batch.requestId, digest, batch.actor, '{}', '{}', '{}', at);
      let seq = 0;
      const createdIds = Object.values(created);
      let createIndex = 0;
      // One event per change to an item. The version goes up only when the item's state changes (a "raised again" link or a
      // confirmation leaves it), so those never make a view stale or block an Undo; a rebuild applies the same rule.
      const event = (next: Item, op: string, before: Item | null, source: Source | null, extra: { confirmed?: boolean; ref?: string | null } = {}) => {
        const changed = before ? diff(before, next) : null;
        const after: Item = before && !changesState(changed!.after) ? { ...next, version: before.version, updatedAt: before.updatedAt } : { ...next, version: (before?.version ?? 0) + 1, updatedAt: at };
        this.db.prepare('INSERT INTO memory_events (id,batch,seq,project,item,op,before,after,source,confirmed,ref,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), batchId, seq++, project, after.id, op, changed ? JSON.stringify(changed.before) : null, JSON.stringify(changed ? changed.after : pick(after)),
            source ? JSON.stringify(source) : null, extra.confirmed ? 1 : 0, extra.ref ?? null, at);
        work.set(after.id, after);
        return after;
      };
      for (const change of batch.changes) {
        if (change.op !== 'confirm' && !change.source?.kind) throw fail(400, 'Every change needs a source.');
        switch (change.op) {
          case 'create': {
            const id = createdIds[createIndex++];
            const text = clean(change.text);
            if (!text) throw fail(400, 'A new item needs text.');
            const item: Item = { project, id, type: change.type, status: INITIAL[change.type], text, owner: change.owner ? clean(change.owner, 80) : null,
              fields: cleanFields(change.fields), confirmed: change.confirmed ?? batch.actor === 'user', mergedInto: null, version: 0, createdAt: at, updatedAt: at };
            event(item, 'create', null, change.source, { ref: change.ref ?? null });
            break;
          }
          case 'edit': {
            const item = live(get(change.item));
            const next = { ...item, text: change.text === undefined ? item.text : clean(change.text), owner: change.owner === undefined ? item.owner : change.owner ? clean(change.owner, 80) : null,
              fields: change.fields ? { ...item.fields, ...cleanFields(change.fields) } : item.fields };
            if (!next.text) throw fail(400, 'An item needs text.');
            event(next, 'edit', item, change.source);
            break;
          }
          case 'status': {
            const item = live(get(change.item));
            if (!TRANSITIONS[item.type][item.status]?.includes(change.to)) throw fail(400, `${item.id} cannot go from ${item.status} to ${change.to}.`);
            const reopening = change.to === INITIAL[item.type];
            if (reopening && !clean(change.reason)) throw fail(400, `Reopening ${item.id} needs a reason.`);
            event({ ...item, status: change.to, fields: { ...item.fields, ...(change.reason ? { reason: clean(change.reason, 300) } : {}) } }, 'status', item, change.source);
            break;
          }
          case 'answer': {
            const item = live(get(change.item));
            if (item.type !== 'question') throw fail(400, `${item.id} is not a question.`);
            if (item.status !== 'open') throw fail(400, `${item.id} is not open.`);
            const text = clean(change.text);
            if (!text) throw fail(400, 'An answer needs text.');
            event({ ...item, status: 'answered', fields: { ...item.fields, answer: text } }, 'answer', item, change.source);
            break;
          }
          case 'supersede': {
            const old = live(get(change.item));
            const by = live(get(change.by));
            if (old.type !== 'decision' || by.type !== 'decision') throw fail(400, 'Only a decision supersedes a decision.');
            if (old.id === by.id) throw fail(400, 'A decision cannot supersede itself.');
            if (old.status !== 'in force') throw fail(400, `${old.id} is not in force.`);
            event({ ...old, status: 'superseded', fields: { ...old.fields, supersededBy: by.id } }, 'supersede', old, change.source);
            const current = work.get(by.id)!;
            event({ ...current, fields: { ...current.fields, supersedes: old.id } }, 'supersede', current, change.source);
            break;
          }
          case 'addSource': {
            const item = live(get(change.item));
            // A "raised again" attachment: the item's own state does not change.
            event(item, 'addSource', item, change.source, { confirmed: change.confirmed ?? batch.actor === 'user' });
            break;
          }
          case 'merge': {
            const from = live(get(change.item));
            const into = live(get(change.into));
            if (from.id === into.id || from.type !== into.type) throw fail(400, 'Merge two different items of the same type.');
            event({ ...from, status: 'merged', mergedInto: into.id }, 'merge', from, change.source);
            break;
          }
          case 'confirm': {
            const item = get(change.item);
            if (change.event) {
              const attachment = this.db.prepare("SELECT 1 FROM memory_events WHERE id=? AND project=? AND item=? AND op='addSource'").get(change.event, project, item.id);
              if (!attachment) throw fail(400, 'No such source on this item.');
              event(item, 'confirm', item, null, { ref: change.event });
            } else event({ ...item, confirmed: true }, 'confirm', item, null);
            break;
          }
          default: throw fail(400, 'Unknown change.');
        }
      }
      for (const [id, item] of work) {
        this.db.prepare(`INSERT INTO memory_items (project,id,type,status,text,owner,fields,confirmed,mergedInto,version,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project,id) DO UPDATE SET type=excluded.type, status=excluded.status, text=excluded.text, owner=excluded.owner, fields=excluded.fields,
          confirmed=excluded.confirmed, mergedInto=excluded.mergedInto, version=excluded.version, updatedAt=excluded.updatedAt`)
          .run(project, id, item.type, item.status, item.text, item.owner, JSON.stringify(item.fields), item.confirmed ? 1 : 0, item.mergedInto, item.version, item.createdAt, item.updatedAt);
      }
      const writes = Object.fromEntries([...work].map(([id, item]) => [id, item.version]));
      const result: BatchResult = { batch: batchId, created, items: [...work.values()] };
      this.db.prepare('UPDATE memory_batches SET reads=?, writes=?, result=? WHERE id=?').run(JSON.stringify(reads), JSON.stringify(writes), JSON.stringify(result), batchId);
      return result;
    });
  }

  /**
   * Undoes a whole batch, as a new batch. Only if every item whose state it changed is still at the version it left (links
   * and confirmations neither count nor block; otherwise the user edits instead), and an item it created is not used by any
   * other item. An undone create becomes "dropped", reason "undone".
   */
  undo(project: string, batchId: string, requestId: string, actor: Actor = 'user'): BatchResult {
    return this.transaction(() => {
      const repeat = this.db.prepare('SELECT result, undoOf FROM memory_batches WHERE requestId=?').get(requestId) as { result: string; undoOf: string | null } | undefined;
      if (repeat) { if (repeat.undoOf !== batchId) throw fail(409, 'This request id was already used for a different change.'); return JSON.parse(repeat.result); }
      const batch = this.db.prepare('SELECT * FROM memory_batches WHERE id=? AND project=?').get(batchId, project) as { writes: string; undoneBy: string | null; undoOf: string | null } | undefined;
      if (!batch) throw fail(404, 'No such change.');
      if (batch.undoneBy) throw fail(409, 'This change was already undone.');
      const writes = JSON.parse(batch.writes) as Record<string, number>;
      const events = (this.db.prepare('SELECT * FROM memory_events WHERE batch=? ORDER BY seq DESC').all(batchId) as Record<string, unknown>[]).map(r => eventRow({ ...r, actor: 'user' }));
      // Only what the batch changed must be as it left it; a link or a confirmation is taken back whatever happened since.
      for (const [id, version] of Object.entries(writes)) {
        if (!events.some(e => e.item === id && (e.op === 'create' || changesState(e.after)))) continue;
        if (this.item(project, id)?.version !== version) throw fail(409, `${id} changed since; edit it instead.`, { stale: id });
      }
      const createdHere = new Set(events.filter(e => e.op === 'create').map(e => e.item));
      for (const id of createdHere) {
        // Check pointers after restoration: a source attachment alone does not undo a later merge or supersede.
        const users = this.items(project).filter(i => {
          const restored = events.filter(e => e.item === i.id && e.op !== 'create').reduce((item, e) => ({ ...item, ...e.before }), i);
          return restored.mergedInto === id || restored.fields.supersedes === id || restored.fields.supersededBy === id;
        });
        if (users.length) throw fail(409, `${id} is used by ${users.map(u => u.id).join(', ')}; undo that first.`);
      }
      const at = this.clock();
      const undoId = randomUUID();
      this.db.prepare('INSERT INTO memory_batches (id,project,requestId,digest,actor,reads,writes,result,undoOf,at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(undoId, project, requestId, 'undo', actor, batch.writes, '{}', '{}', batchId, at);
      const work = new Map<string, Item>();
      let seq = 0;
      for (const e of events) {
        const current = work.get(e.item) ?? this.item(project, e.item)!;
        const restored: Item = e.op === 'create'
          ? { ...current, status: 'dropped', fields: { ...current.fields, reason: 'undone' } }
          : { ...current, ...(e.before as Partial<Item>), project, id: current.id };
        const changed = diff(current, restored);
        const next = changesState(changed.after) ? { ...restored, version: current.version + 1, updatedAt: at } : restored;
        this.db.prepare('INSERT INTO memory_events (id,batch,seq,project,item,op,before,after,source,confirmed,ref,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(randomUUID(), undoId, seq++, project, e.item, 'undo', JSON.stringify(changed.before), JSON.stringify(changed.after), JSON.stringify({ kind: 'undo', batch: batchId }), 0, e.id, at);
        work.set(e.item, next);
      }
      for (const item of work.values()) {
        this.db.prepare('UPDATE memory_items SET status=?, text=?, owner=?, fields=?, confirmed=?, mergedInto=?, version=?, updatedAt=? WHERE project=? AND id=?')
          .run(item.status, item.text, item.owner, JSON.stringify(item.fields), item.confirmed ? 1 : 0, item.mergedInto, item.version, item.updatedAt, project, item.id);
      }
      const result: BatchResult = { batch: undoId, created: {}, items: [...work.values()] };
      this.db.prepare('UPDATE memory_batches SET writes=?, result=? WHERE id=?').run(JSON.stringify(Object.fromEntries([...work].map(([id, i]) => [id, i.version]))), JSON.stringify(result), undoId);
      this.db.prepare('UPDATE memory_batches SET undoneBy=? WHERE id=?').run(undoId, batchId);
      return result;
    });
  }

  /** The state replayed from the events alone; equal to `items()` unless something wrote around the change list. */
  rebuild(project: string): Item[] {
    const state = new Map<string, Item>();
    for (const e of this.events(project)) {
      const current = state.get(e.item);
      if (e.op === 'create' && !current) { state.set(e.item, { ...(e.after as Item), project }); continue; }
      if (!current) throw new Error(`Event for ${e.item} before its creation.`);
      state.set(e.item, changesState(e.after) ? { ...current, ...(e.after as Partial<Item>), version: current.version + 1, updatedAt: e.at } : { ...current, ...(e.after as Partial<Item>) });
    }
    return [...state.values()].sort((a, b) => a.type.localeCompare(b.type) || Number(a.id.slice(2)) - Number(b.id.slice(2)));
  }

  brief(project: string): { version: number; text: string; actor: Actor; source: Source | null; basedOn: number | null; at: number } | null {
    const found = this.db.prepare('SELECT * FROM memory_brief WHERE project=? ORDER BY version DESC LIMIT 1').get(project) as Record<string, unknown> | undefined;
    return found ? { version: Number(found.version), text: String(found.text), actor: found.actor as Actor, source: found.source ? JSON.parse(String(found.source)) : null,
      basedOn: found.basedOn === null ? null : Number(found.basedOn), at: Number(found.at) } : null;
  }
  briefVersions(project: string) {
    return (this.db.prepare('SELECT version, actor, text, at FROM memory_brief WHERE project=? ORDER BY version DESC').all(project) as Record<string, unknown>[]).map(r => ({ ...r }));
  }
  /** A new brief version; `basedOn` is the version the writer started from (an AI rewrite must not replace a newer edit). */
  saveBrief(project: string, text: string, actor: Actor, source: Source | null, basedOn: number | null) {
    return this.transaction(() => {
      const current = this.brief(project);
      if ((current?.version ?? null) !== basedOn) throw fail(409, 'The brief changed meanwhile.', { current });
      const body = String(text ?? '').trim().slice(0, 4000);
      const version = (current?.version ?? 0) + 1;
      this.db.prepare('INSERT INTO memory_brief (project,version,text,actor,source,basedOn,at) VALUES (?,?,?,?,?,?,?)')
        .run(project, version, body, actor, source ? JSON.stringify(source) : null, basedOn, this.clock());
      return this.brief(project)!;
    });
  }

  /** An earlier version back as the newest, with its own author and source (so an AI text stays labelled AI). */
  restoreBrief(project: string, version: number, basedOn: number | null) {
    const found = this.db.prepare('SELECT text, actor, source FROM memory_brief WHERE project=? AND version=?').get(project, version) as { text: string; actor: Actor; source: string | null } | undefined;
    if (!found) throw fail(404, 'No such brief version.');
    return this.saveBrief(project, found.text, found.actor, found.source ? JSON.parse(found.source) : null, basedOn);
  }

  private nextNumber(project: string, type: ItemType): number {
    const name = `memory:${project}:${PREFIX[type]}`;
    this.db.prepare('INSERT INTO counters (name,value) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET value=value+1').run(name);
    return Number((this.db.prepare('SELECT value FROM counters WHERE name=?').get(name) as { value: number }).value);
  }
  private transaction<T>(fn: () => T): T { return transaction(this.db, fn); }
}

let savepoints = 0;
/** One transaction, or a savepoint inside the caller's (a proposal run records many batches and its outcomes together). */
export function transaction<T>(db: MeetingStore['db'], fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  }
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function live(item: Item) {
  if (item.status === 'merged') throw fail(400, `${item.id} was merged into ${item.mergedInto}.`);
  return item;
}
function cleanFields(fields: Fields | undefined): Fields {
  const out: Fields = {};
  for (const key of ['due', 'conditions', 'answer', 'reason'] as const) if (fields?.[key]) out[key] = clean(fields[key], 300);
  return out;
}
function pick(item: Item): Partial<Item> {
  const { project: _p, ...rest } = item;
  return rest;
}
/** A change to anything but the confirmed flag is a change of state (it bumps the version). */
function changesState(after: Partial<Item> | null) { return Object.keys(after ?? {}).some(key => key !== 'confirmed'); }
/** The tracked fields that differ, before and after (plus the new version), for an event row. */
function diff(before: Item, after: Item) {
  const b: Partial<Record<string, unknown>> = {}, a: Partial<Record<string, unknown>> = {};
  for (const key of TRACKED) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) { b[key] = before[key]; a[key] = after[key]; }
  return { before: b as Partial<Item>, after: a as Partial<Item> };
}
function row(r: Record<string, unknown>): Item {
  return { project: String(r.project), id: String(r.id), type: r.type as ItemType, status: r.status as Status, text: String(r.text), owner: (r.owner as string | null) ?? null,
    fields: JSON.parse(String(r.fields)), confirmed: Boolean(r.confirmed), mergedInto: (r.mergedInto as string | null) ?? null, version: Number(r.version),
    createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) };
}
function eventRow(r: Record<string, unknown>): MemoryEvent {
  return { id: String(r.id), batch: String(r.batch), seq: Number(r.seq), project: String(r.project), item: String(r.item), op: String(r.op),
    before: r.before ? JSON.parse(String(r.before)) : null, after: r.after ? JSON.parse(String(r.after)) : null, source: r.source ? JSON.parse(String(r.source)) : null,
    confirmed: Boolean(r.confirmed), ref: (r.ref as string | null) ?? null, actor: r.actor as Actor, at: Number(r.at), undone: Boolean(r.undoneBy) };
}
