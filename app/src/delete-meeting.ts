// Permanent meeting workflow deletion. Project memory and its batch-level Undo are deliberately retained.
// The cleanup manifest commits with the deletion, so a crash after COMMIT can be retried by id.
import type { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { dataRelativeRecordingPath, repairedRecordingPath } from './recording-paths.ts';

export type DeletionStore = { db: DatabaseSync; directory: string; deletionBusy?: (id: string) => string[] };
export type MeetingDeletion = { id: string; title: string; createdAt: number; rows: Record<string, number>; paths: string[];
  imports: string[]; legacy: string[]; fileBytes: number; evidenceCopiesElsewhere: number; pending: boolean };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const validId = (id: string) => /^[\w-]{1,64}$/.test(id);
const tables = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
function missing(error: unknown) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }

/** No symlink parent is traversed, even if it points elsewhere INSIDE data. The leaf may be unlinked, never followed. */
export function ownedPath(directory: string, relative: string): string {
  const root = realpathSync(directory), path = resolve(root, relative);
  if (!relative || relative.split(/[\\/]/).includes('..') || !path.startsWith(`${root}${sep}`)) throw new Error(`Unsafe data path: ${relative}`);
  let parent = dirname(path);
  for (;;) {
    try {
      if (realpathSync(parent) !== parent) throw new Error(`Symlink parent in data path: ${relative}`);
      break;
    } catch (error) { if (!missing(error)) throw error; parent = dirname(parent); }
  }
  return path;
}
function info(directory: string, relative: string) {
  try { return lstatSync(ownedPath(directory, relative)); } catch (error) { if (missing(error)) return null; throw error; }
}
function names(directory: string, relative: string): string[] {
  const s = info(directory, relative);
  if (!s || s.isSymbolicLink()) return [];
  if (!s.isDirectory()) throw new Error(`Expected a data directory: ${relative}`);
  return readdirSync(ownedPath(directory, relative));
}
function json(directory: string, relative: string): any {
  const s = info(directory, relative);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Not a regular job/data file: ${relative}`);
  return JSON.parse(readFileSync(ownedPath(directory, relative), 'utf8'));
}
function bytes(directory: string, relative: string): number {
  const s = info(directory, relative);
  if (!s || s.isSymbolicLink()) return 0;
  return s.isDirectory() ? names(directory, relative).reduce((n, name) => n + bytes(directory, `${relative}/${name}`), 0) : s.size;
}
const legacyMaterialFiles = ['materials.json', 'materials.json.migrated'];
function legacyPaths(directory: string, id: string): string[] {
  return legacyMaterialFiles.filter(path => {
    const data = json(directory, path);
    if (data !== null && !Array.isArray(data)) throw new Error(`Invalid legacy materials: ${path}`);
    return data?.some((r: { meetingId?: string }) => r.meetingId === id);
  });
}
function legacyBytes(directory: string, paths: string[], id: string, previouslyDeleted: ReadonlySet<string>) {
  return paths.reduce((n, path) => {
    const data = json(directory, path) as { meetingId?: string }[] | null;
    if (!data) return n;
    const before = data.filter(r => !r.meetingId || !previouslyDeleted.has(r.meetingId));
    const filtered = before.filter(r => r.meetingId !== id);
    if (filtered.length === before.length) return n;
    const size = before.length === data.length ? bytes(directory, path) : Buffer.byteLength(JSON.stringify(before));
    return n + Math.max(0, size - Buffer.byteLength(JSON.stringify(filtered)));
  }, 0);
}
function pending(store: DeletionStore, id: string): MeetingDeletion | null {
  if (!tables(store.db).has('meeting_deletions')) return null;
  const row = store.db.prepare('SELECT manifest FROM meeting_deletions WHERE id=?').get(id) as { manifest: string } | undefined;
  return row ? { ...JSON.parse(row.manifest), pending: true } : null;
}
export function pendingMeetingDeletions(store: DeletionStore): MeetingDeletion[] {
  if (!tables(store.db).has('meeting_deletions')) return [];
  return (store.db.prepare('SELECT id FROM meeting_deletions ORDER BY id').all() as { id: string }[]).map(r => inspectMeetingDeletion(store, r.id));
}
function importReference(directory: string, path: string, meetingId: string): string | null {
  const repaired = repairedRecordingPath(directory, path, meetingId);
  const relative = repaired && dataRelativeRecordingPath(directory, resolve(directory, repaired));
  return relative && /^imports\/[a-f0-9-]{36}\.media$/.test(relative) ? relative : null;
}
/** Both lexical and physical in-data references matter. Outside recording references are never realpathed. */
function referencePaths(directory: string, path: string, meetingId?: string): string[] {
  if (!path) return [];
  const repaired = meetingId === undefined ? path : repairedRecordingPath(directory, path, meetingId);
  const relative = dataRelativeRecordingPath(directory, resolve(directory, repaired));
  if (relative === null) return [];
  const root = realpathSync(directory), absolute = resolve(root, relative), paths = [absolute];
  try { const real = realpathSync(absolute); if (real.startsWith(`${root}${sep}`)) paths.push(real); }
  catch (error) { if (!missing(error)) throw error; }
  return [...new Set(paths)];
}
function importUsed(store: DeletionStore, relative: string, except?: string, ignored: ReadonlySet<string> = new Set()) {
  const target = referencePaths(store.directory, relative);
  return (store.db.prepare("SELECT meetingId,path FROM chunks WHERE path <> ''").all() as { meetingId: string; path: string }[])
    .some(r => r.meetingId !== except && !ignored.has(r.meetingId) && referencePaths(store.directory, r.path, r.meetingId).some(p => target.includes(p)));
}
export function unreferencedImports(store: DeletionStore): { path: string; bytes: number }[] {
  return names(store.directory, 'imports').filter(n => /^[a-f0-9-]{36}\.media$/.test(n)).map(n => `imports/${n}`)
    .filter(path => !importUsed(store, path)).map(path => ({ path, bytes: bytes(store.directory, path) }));
}
function checkReferences(store: DeletionStore, id: string, paths: string[], ignored: ReadonlySet<string>) {
  const planned = paths.map(path => ({ relative: path, absolute: ownedPath(store.directory, path) }));
  const check = (table: string, rowId: string, references: string[]) => {
    const target = planned.find(p => references.some(r => r === p.absolute || r.startsWith(`${p.absolute}${sep}`)));
    if (target) throw fail(409, `Cannot delete meeting ${id}: surviving ${table} ${rowId} references planned path ${target.relative}.`);
  };
  for (const table of ['chunks', 'frames']) {
    for (const row of store.db.prepare(`SELECT id,meetingId,path FROM ${table} WHERE meetingId<>? AND path<>''`).all(id) as { id: string; meetingId: string; path: string }[]) {
      if (!ignored.has(row.meetingId)) check(table, row.id, referencePaths(store.directory, row.path, row.meetingId));
    }
  }
  if (tables(store.db).has('material_roots')) {
    for (const row of store.db.prepare('SELECT id,scope,path FROM material_roots WHERE scope<>?').all(`meeting:${id}`) as { id: string; scope: string; path: string }[]) {
      if (row.scope.startsWith('meeting:') && ignored.has(row.scope.slice('meeting:'.length))) continue;
      const references = referencePaths(store.directory, row.path);
      // Roots are normally canonical already, but an outside material alias may point back into owned data.
      if (!references.length) {
        try {
          const real = realpathSync(resolve(store.directory, row.path));
          if (dataRelativeRecordingPath(store.directory, real) !== null) references.push(real);
        } catch (error) { if (!missing(error) && !['EACCES', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      check('material_roots', row.id, references);
    }
  }
}
function addTemporaryFiles(directory: string, id: string, paths: Set<string>) {
  for (const folder of ['board', 'notes']) for (const name of names(directory, folder)) {
    if ((name.startsWith(`${id}.json.`) || name.startsWith(`${id}.job.json.`)) && name.endsWith('.tmp')) paths.add(`${folder}/${name}`);
  }
}
function copyCount(store: DeletionStore, id: string, createdAt: number, deleting: ReadonlySet<string>): number {
  const directory = store.directory;
  const surviving = new Set((store.db.prepare('SELECT id FROM meetings').all() as { id: string }[]).map(r => r.id).filter(m => !deleting.has(m)));
  let count = 0;
  const filename = `${new Date(createdAt).toISOString().slice(0, 10)}-${id.slice(0, 8)}.md`;
  for (const other of names(directory, 'scratch/memory-snapshots').filter(n => surviving.has(n) && n !== id)) {
    const otherFolder = info(directory, `scratch/memory-snapshots/${other}`);
    if (!otherFolder?.isDirectory() || otherFolder.isSymbolicLink()) continue;
    for (const snapshot of names(directory, `scratch/memory-snapshots/${other}`)) {
      const folder = `scratch/memory-snapshots/${other}/${snapshot}`;
      const dir = info(directory, folder);
      if (!dir?.isDirectory() || dir.isSymbolicLink() || !names(directory, `${folder}/past-notes`).includes(filename)) continue;
      const s = info(directory, `${folder}/past-notes/${filename}`);
      if (s?.isFile() && !s.isSymbolicLink()) count++;
    }
  }
  return count;
}
function checkJobs(store: DeletionStore, id: string, paths: Set<string>) {
  const active = store.deletionBusy?.(id) ?? [];
  const running = new Set(['queued', 'waiting', 'running']);
  const notes = json(store.directory, `notes/${id}.job.json`);
  if (running.has(notes?.state)) active.push('notes');
  const board = json(store.directory, `board/${id}.job.json`);
  if (running.has(board?.state)) active.push('board');
  const jobs: { id: string; state: string }[] = [];
  for (const file of names(store.directory, `actions/${id}`).filter(n => n.endsWith('.json'))) {
    const job = json(store.directory, `actions/${id}/${file}`);
    if (!job || job.meetingId !== id || !validId(job.id)) throw new Error(`Invalid action job: ${file}`);
    jobs.push(job); paths.add(`scratch/actions/${job.id}`); paths.add(`processes/${job.id}`);
  }
  for (const jobId of names(store.directory, `explorations/${id}`)) {
    const folder = info(store.directory, `explorations/${id}/${jobId}`);
    if (!folder?.isDirectory() || folder.isSymbolicLink()) continue;
    if (!validId(jobId)) throw new Error(`Invalid exploration id: ${jobId}`);
    const job = json(store.directory, `explorations/${id}/${jobId}/job.json`);
    if (job) {
      if (job.meetingId !== id || job.id !== jobId) throw new Error(`Invalid exploration job: ${jobId}`);
      jobs.push(job);
    }
    paths.add(`processes/${jobId}`);
  }
  for (const job of jobs) if (running.has(job.state)) active.push(`agent job ${job.id}`);
  // Process records are authoritative even when a terminal job was saved before process cleanup finished.
  for (const path of [...paths].filter(p => p.startsWith('processes/'))) {
    for (const file of names(store.directory, path).filter(n => n.endsWith('.json'))) {
      const record = json(store.directory, `${path}/${file}`);
      if (!Number.isInteger(record?.pgid) || record.pgid <= 1) throw new Error(`Invalid process record: ${file}`);
      try { process.kill(-record.pgid, 0); active.push(`process group ${record.pgid}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  if (tables(store.db).has('memory_runs') && store.db.prepare("SELECT 1 FROM memory_runs WHERE meetingId=? AND state='running'").get(id)) active.push('memory run');
  if (active.length) throw fail(409, `Cannot delete meeting ${id}: agent work is running or waiting (${active.join(', ')}).`);
}

export function inspectMeetingDeletion(store: DeletionStore, id: string, now = Date.now(), previouslyDeleted: ReadonlySet<string> = new Set(), deleting: ReadonlySet<string> = new Set([id])): MeetingDeletion {
  // Real meeting IDs are UUIDs; accepting reserved scratch names such as "memory" could erase shared workspaces.
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw fail(404, `Unknown meeting: ${id}`);
  const meeting = store.db.prepare('SELECT * FROM meetings WHERE id=?').get(id) as { title: string; createdAt: number; replay: string | null } | undefined;
  if (!meeting) {
    const saved = pending(store, id);
    if (!saved) throw fail(404, `Unknown meeting: ${id}`);
    const imports = saved.imports.filter(p => !importUsed(store, p, undefined, previouslyDeleted)), legacy = legacyPaths(store.directory, id);
    const paths = new Set(saved.paths);
    addTemporaryFiles(store.directory, id, paths);
    checkJobs(store, id, paths);
    checkReferences(store, id, [...paths, ...imports], previouslyDeleted);
    return { ...saved, paths: [...paths], imports, legacy, fileBytes: [...paths, ...imports].reduce((n, p) => n + bytes(store.directory, p), 0) + legacyBytes(store.directory, legacy, id, previouslyDeleted),
      evidenceCopiesElsewhere: copyCount(store, id, saved.createdAt, deleting) };
  }
  if (store.db.prepare("SELECT 1 FROM recording_sources WHERE meetingId=? AND state IN ('open','recovering')").get(id)) throw fail(409, `Cannot delete meeting ${id}: recording has not ended.`);
  if (meeting.replay) {
    const replay = JSON.parse(meeting.replay);
    if (Math.max(0, (now - replay.startedAt) * replay.speed) < replay.durationMs) throw fail(409, `Cannot delete meeting ${id}: replay is still playing.`);
  }
  if (store.db.prepare("SELECT 1 FROM chunks WHERE meetingId=? AND status <> 'completed'").get(id)) throw fail(409, `Cannot delete meeting ${id}: chunks are not completed.`);
  const paths = new Set(['audio', 'plans', 'actions', 'explorations', 'sessions'].map(p => `${p}/${id}`));
  for (const p of [`board/${id}.json`, `board/${id}.job.json`, `notes/${id}.json`, `notes/${id}.job.json`, `glossaries/${id}.json`, `glossaries.migrated/${id}.json`,
    `scratch/${id}`, `scratch/board/${id}`, `scratch/notes/${id}`, `scratch/explore/${id}`, `scratch/memory/${id}`, `scratch/memory-snapshots/${id}`,
    ...legacyMaterialFiles.map(p => `${p}.delete-${id}.tmp`)]) paths.add(p);
  addTemporaryFiles(store.directory, id, paths);
  checkJobs(store, id, paths);
  // Discover all meetingId tables rather than silently missing a later schema addition. FK order is determined at deletion.
  const rows: Record<string, number> = {};
  for (const table of tables(store.db)) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`Unexpected table name: ${table}`);
    if ((store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === 'meetingId')) {
      rows[table] = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE meetingId=?`).get(id)!.n);
    }
  }
  for (const table of ['material_roots', 'glossaries']) if (tables(store.db).has(table)) rows[table] = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope=?`).get(`meeting:${id}`)!.n);
  rows.meetings = 1;
  const imports = [...new Set((store.db.prepare('SELECT path FROM chunks WHERE meetingId=?').all(id) as { path: string }[])
    .map(r => importReference(store.directory, r.path, id)).filter((p): p is string => p !== null))].filter(p => !importUsed(store, p, id, previouslyDeleted));
  checkReferences(store, id, [...paths, ...imports], previouslyDeleted);
  const legacy = legacyPaths(store.directory, id);
  const fileBytes = [...paths, ...imports].reduce((n, p) => n + bytes(store.directory, p), 0) + legacyBytes(store.directory, legacy, id, previouslyDeleted);
  return { id, title: meeting.title, createdAt: meeting.createdAt, rows, paths: [...paths], imports, legacy, fileBytes,
    evidenceCopiesElsewhere: copyCount(store, id, meeting.createdAt, deleting), pending: false };
}

/** Recovery is mandatory in the offline CLI and in server startup before any jobs are loaded. */
export function finishPendingMeetingDeletions(store: DeletionStore, report: (message: string) => void = () => {}): string[] {
  const pending = pendingMeetingDeletions(store);
  for (const meeting of pending) {
    report(`Finishing pending deletion ${meeting.id} (previously committed; cleanup also runs during dry runs).`);
    deleteMeeting(store, meeting.id);
  }
  return pending.map(m => m.id);
}
/** Sync the nearest surviving parent: a prior interrupted removal may already have removed intermediate directories. */
function syncRemovalParents(directory: string, paths: string[]) {
  const root = realpathSync(directory), synced = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    for (;;) {
      if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error(`Unsafe sync directory: ${parent}`);
      try {
        if (realpathSync(parent) !== parent) throw new Error(`Symlink sync directory: ${parent}`);
        if (!synced.has(parent)) {
          const fd = openSync(parent, 'r');
          try { fsyncSync(fd); }
          catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          finally { closeSync(fd); }
          synced.add(parent);
        }
        break;
      } catch (error) { if (!missing(error) || parent === root) throw error; parent = dirname(parent); }
    }
  }
}

/** A small test seam models power loss after the durable deletion, before any file is removed. */
export function deleteMeeting(store: DeletionStore, id: string, options: { afterCommit?: () => void } = {}): MeetingDeletion {
  let manifest: MeetingDeletion;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    manifest = inspectMeetingDeletion(store, id);
    if (!manifest.pending) {
      store.db.exec('CREATE TABLE IF NOT EXISTS meeting_deletions (id TEXT PRIMARY KEY, manifest TEXT NOT NULL)');
      store.db.prepare('INSERT INTO meeting_deletions VALUES (?,?)').run(id, JSON.stringify(manifest));
      const remaining = new Set(Object.keys(manifest.rows).filter(t => !['meetings', 'material_roots', 'glossaries'].includes(t)));
      // Children first, including frames.windowChunkId and segments.chunkId. Cycles fail closed (ROLLBACK).
      while (remaining.size) {
        const parents = new Set<string>();
        for (const t of remaining) for (const fk of store.db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[]) if (fk.table !== t) parents.add(fk.table);
        const leaves = [...remaining].filter(t => !parents.has(t));
        if (!leaves.length) throw new Error('Cannot delete meeting: cyclic database dependencies.');
        for (const t of leaves) { store.db.prepare(`DELETE FROM ${t} WHERE meetingId=?`).run(id); remaining.delete(t); }
      }
      for (const t of ['material_roots', 'glossaries']) if (t in manifest.rows) store.db.prepare(`DELETE FROM ${t} WHERE scope=?`).run(`meeting:${id}`);
      store.db.prepare('DELETE FROM meetings WHERE id=?').run(id);
    } else {
      // Persist newly discovered job/scratch paths before cleanup can remove the records that identify their ownership.
      store.db.prepare('UPDATE meeting_deletions SET manifest=? WHERE id=?').run(JSON.stringify(manifest), id);
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  options.afterCommit?.();
  const removed: string[] = [];
  for (const path of manifest.paths) {
    const target = ownedPath(store.directory, path); rmSync(target, { recursive: true, force: true }); removed.push(target);
  }
  for (const path of manifest.imports) if (!importUsed(store, path)) {
    const target = ownedPath(store.directory, path); rmSync(target, { force: true }); removed.push(target);
  }
  for (const path of legacyMaterialFiles) {
    const target = ownedPath(store.directory, path), tmp = `${target}.delete-${id}.tmp`;
    // Clean prior temporary writes even if startup migration moved the original file after a crash.
    rmSync(tmp, { force: true }); removed.push(tmp);
    const data = json(store.directory, path);
    if (!data) continue;
    const filtered = data.filter((r: { meetingId?: string }) => r.meetingId !== id);
    if (filtered.length === data.length) continue;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(filtered)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target); removed.push(target);
  }
  syncRemovalParents(store.directory, removed);
  store.db.prepare('DELETE FROM meeting_deletions WHERE id=?').run(id);
  return manifest;
}
