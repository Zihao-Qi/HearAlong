import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MeetingStore } from './store.ts';
import type { Glossary, GlossaryTerm } from './correction.ts';
import { excluded, type Material } from './materials.ts';
import { transaction } from './memory.ts';

/**
 * A research project: owns materials, a glossary and (M6 step 2 on) memory. A meeting is in one project or none.
 * `planAfterNotes` (M7b §1 decision 1): its meetings' plans are made once their notes are written; off by default.
 */
export type Project = { id: string; name: string; repoPath: string | null; createdAt: number; planAfterNotes: boolean };
/** What applies to a meeting: its project's materials and glossary, plus the meeting's own extra materials. */
export type EffectiveScope = { projectId: string | null; roots: Material[]; glossaryScope: string };

export const projectScope = (id: string) => `project:${id}`;
export const meetingScope = (id: string) => `meeting:${id}`;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Projects, material roots and glossaries in the meetings database (docs/design/M6-memory.md §3.1, §8).
 * Glossary versions come from one counter across all scopes, so a version number identifies one glossary everywhere
 * (correction marks, notes input hashes, board and action context) with no separate identity type.
 */
export class Projects {
  private store: MeetingStore;
  private directory: string;
  constructor(store: MeetingStore, directory: string) {
    this.store = store;
    this.directory = directory;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT UNIQUE, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS material_roots (id TEXT PRIMARY KEY, scope TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS material_scope ON material_roots(scope);
      CREATE TABLE IF NOT EXISTS glossaries (scope TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, origin TEXT NOT NULL,
        builtAt INTEGER NOT NULL, model TEXT, terms TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    const columns = (this.store.db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).map(c => c.name);
    if (!columns.includes('projectId')) this.store.db.exec('ALTER TABLE meetings ADD COLUMN projectId TEXT REFERENCES projects(id)');
    const own = (this.store.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(c => c.name);
    if (!own.includes('planAfterNotes')) this.store.db.exec('ALTER TABLE projects ADD COLUMN planAfterNotes INTEGER NOT NULL DEFAULT 0');
  }
  private get db() { return this.store.db; }
  private transaction<T>(fn: () => T): T { return transaction(this.db, fn); }

  /**
   * One-time import of the pre-M6 files: `materials.json` (roots keep their ids, so saved citations still resolve) and
   * `glossaries/<meetingId>.json`. A glossary keeps its version number unless another glossary already has it; then it gets
   * a new global version and the meeting's correction marks move with it. Already imported scopes are skipped, so a crash
   * between the database commit and the file renames is harmless.
   */
  async migrate() {
    const materialsPath = join(this.directory, 'materials.json');
    let roots: (Material & { meetingId?: string })[] = [];
    try { roots = JSON.parse(await readFile(materialsPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const glossaryDir = join(this.directory, 'glossaries');
    const glossaries: { meetingId: string; glossary: Glossary }[] = [];
    try {
      for (const file of await readdir(glossaryDir)) {
        const meetingId = file.match(/^([a-f0-9-]{36})\.json$/)?.[1];
        if (meetingId) glossaries.push({ meetingId, glossary: JSON.parse(await readFile(join(glossaryDir, file), 'utf8')) });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!roots.length && !glossaries.length) return;
    const meetings = new Set(this.store.meetings().map(m => m.id));
    this.transaction(() => {
      const insertRoot = this.db.prepare('INSERT OR IGNORE INTO material_roots (id,scope,path,kind,label,createdAt) VALUES (?,?,?,?,?,?)');
      for (const root of roots) if (root.meetingId && meetings.has(root.meetingId)) insertRoot.run(root.id, meetingScope(root.meetingId), root.path, root.kind, root.label, Date.now());
      for (const { meetingId, glossary } of glossaries.sort((a, b) => a.glossary.builtAt - b.glossary.builtAt)) {
        if (!meetings.has(meetingId) || this.glossary(meetingScope(meetingId))) continue;
        const taken = this.db.prepare('SELECT 1 FROM glossaries WHERE version=?').get(glossary.version);
        const version = taken ? this.nextVersion() : glossary.version;
        this.bumpCounter(version);
        this.db.prepare('INSERT INTO glossaries (scope,version,origin,builtAt,model,terms) VALUES (?,?,?,?,?,?)')
          .run(meetingScope(meetingId), version, glossary.origin, glossary.builtAt, glossary.model ?? null, JSON.stringify(glossary.terms));
        if (version !== glossary.version) {
          this.db.prepare('UPDATE segments SET correctionChecked=? WHERE meetingId=? AND correctionChecked=?').run(version, meetingId, glossary.version);
          const state = this.store.correctionState<{ glossaryVersion?: number }>(meetingId);
          if (state?.glossaryVersion === glossary.version) this.store.setCorrectionState(meetingId, { ...state, glossaryVersion: version });
        }
      }
    });
    if (roots.length) await rename(materialsPath, `${materialsPath}.migrated`);
    if (glossaries.length) await rename(glossaryDir, `${glossaryDir}.migrated`);
  }

  list(): (Project & { meetings: number; hasGlossary: boolean })[] {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM meetings m WHERE m.projectId = p.id) AS meetings,
      EXISTS (SELECT 1 FROM glossaries g WHERE g.scope = 'project:' || p.id) AS hasGlossary FROM projects p ORDER BY p.createdAt`).all()
      .map(row => { const { hasGlossary, meetings, ...project } = row as unknown as Project & { meetings: number; hasGlossary: number }; return { ...projectOf(project), meetings: Number(meetings), hasGlossary: Boolean(hasGlossary) }; });
  }
  get(id: string): Project {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project | undefined;
    if (!project) throw fail(404, 'Project not found.');
    return projectOf(project);
  }
  /** A repo folder must exist, be a folder, and belong to one project only. */
  private async checkRepo(path: string | null | undefined, exceptId?: string): Promise<string | null> {
    if (!path) return null;
    const real = await realpath(path).catch(() => { throw fail(400, 'That folder does not exist.'); });
    if (!(await stat(real)).isDirectory()) throw fail(400, 'The repo must be a folder.');
    const other = this.db.prepare('SELECT id, name FROM projects WHERE repoPath=?').get(real) as { id: string; name: string } | undefined;
    if (other && other.id !== exceptId) throw fail(409, `That folder already belongs to the project "${other.name}".`);
    return real;
  }
  async create(name: string, repoPath?: string | null): Promise<Project> {
    const project: Project = { id: randomUUID(), name: cleanName(name), repoPath: await this.checkRepo(repoPath), createdAt: Date.now(), planAfterNotes: false };
    this.db.prepare('INSERT INTO projects (id,name,repoPath,createdAt) VALUES (?,?,?,?)').run(project.id, project.name, project.repoPath, project.createdAt);
    return project;
  }
  async update(id: string, change: { name?: string; repoPath?: string | null; planAfterNotes?: boolean }): Promise<Project> {
    this.get(id);
    if (change.planAfterNotes !== undefined && typeof change.planAfterNotes !== 'boolean') throw fail(400, 'planAfterNotes is true or false.');
    const repoPath = change.repoPath === undefined ? undefined : await this.checkRepo(change.repoPath, id);
    const name = change.name === undefined ? undefined : cleanName(change.name);
    // Validation yields; read unchanged fields only afterwards, in the same transaction as the write.
    return this.transaction(() => {
      const project = this.get(id);
      this.db.prepare('UPDATE projects SET name=?, repoPath=?, planAfterNotes=? WHERE id=?')
        .run(name ?? project.name, repoPath === undefined ? project.repoPath : repoPath, (change.planAfterNotes ?? project.planAfterNotes) ? 1 : 0, id);
      return this.get(id);
    });
  }

  projectOf(meetingId: string): string | null {
    const row = this.db.prepare('SELECT projectId FROM meetings WHERE id=?').get(meetingId) as { projectId: string | null } | undefined;
    if (!row) throw fail(404, 'Meeting not found.');
    return row.projectId;
  }
  /** The one resolver for what applies to a meeting (§8.3). */
  scope(meetingId: string): EffectiveScope {
    const projectId = this.projectOf(meetingId);
    const roots = [...(projectId ? this.roots(projectScope(projectId)) : []), ...this.roots(meetingScope(meetingId))];
    return { projectId, roots, glossaryScope: projectId ? projectScope(projectId) : meetingScope(meetingId) };
  }
  rootsFor(meetingId: string): Material[] { return this.scope(meetingId).roots; }
  roots(scope: string): Material[] {
    // Plain objects (SQLite rows have no prototype), so they serialise and compare like any other value.
    return this.db.prepare('SELECT id, scope, path, kind, label FROM material_roots WHERE scope=? ORDER BY createdAt, rowid').all(scope).map(row => ({ ...row }) as Material);
  }
  async addRoot(scope: string, path: string): Promise<Material> {
    const real = await realpath(path).catch(() => { throw fail(400, 'That file or folder does not exist.'); });
    if (excluded(basename(real))) throw fail(400, 'Hidden/credential material roots are excluded.');
    const info = await stat(real);
    if (!info.isFile() && !info.isDirectory()) throw fail(400, 'Select a regular file or folder.');
    const root: Material = { id: randomUUID(), scope, path: real, kind: info.isDirectory() ? 'folder' : 'file', label: basename(real) };
    this.db.prepare('INSERT INTO material_roots (id,scope,path,kind,label,createdAt) VALUES (?,?,?,?,?,?)').run(root.id, scope, root.path, root.kind, root.label, Date.now());
    return root;
  }
  /** Removes a root only from a scope that applies to the meeting. */
  removeRoot(meetingId: string, rootId: string) {
    const scopes = [meetingScope(meetingId), ...(this.projectOf(meetingId) ? [projectScope(this.projectOf(meetingId)!)] : [])];
    const result = this.db.prepare(`DELETE FROM material_roots WHERE id=? AND scope IN (${scopes.map(() => '?').join(',')})`).run(rootId, ...scopes);
    if (!Number(result.changes)) throw fail(404, 'No such material for this meeting.');
  }

  glossary(scope: string): Glossary | null {
    const row = this.db.prepare('SELECT * FROM glossaries WHERE scope=?').get(scope) as { version: number; origin: Glossary['origin']; builtAt: number; model: string | null; terms: string } | undefined;
    return row ? { version: row.version, origin: row.origin, builtAt: row.builtAt, terms: JSON.parse(row.terms), ...(row.model ? { model: row.model } : {}) } : null;
  }
  glossaryFor(meetingId: string): Glossary | null { return this.glossary(this.scope(meetingId).glossaryScope); }
  private nextVersion(): number {
    const counter = (this.db.prepare("SELECT value FROM counters WHERE name='glossary'").get() as { value: number } | undefined)?.value ?? 0;
    const used = (this.db.prepare('SELECT MAX(version) AS v FROM glossaries').get() as { v: number | null }).v ?? 0;
    return Math.max(counter, used) + 1;
  }
  private bumpCounter(version: number) {
    this.db.prepare("INSERT INTO counters (name,value) VALUES ('glossary',?) ON CONFLICT(name) DO UPDATE SET value=MAX(value, excluded.value)").run(version);
  }
  /**
   * Saves a scope's glossary under a new global version. A generated glossary never overwrites a user's edit, and a build
   * passes the version it started from, so a glossary changed meanwhile is not replaced (compare-and-swap).
   */
  saveGlossary(scope: string, terms: GlossaryTerm[], origin: Glossary['origin'], model?: string, expectedVersion?: number | null): Glossary {
    return this.transaction(() => {
      const current = this.glossary(scope);
      if (origin === 'generated' && current?.origin === 'user') throw fail(409, 'The glossary was edited by the user; rebuild would overwrite it.');
      if (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion) throw fail(409, 'The glossary changed while it was being rebuilt.');
      const version = this.nextVersion();
      this.bumpCounter(version);
      const builtAt = Date.now();
      this.db.prepare(`INSERT INTO glossaries (scope,version,origin,builtAt,model,terms) VALUES (?,?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET version=excluded.version, origin=excluded.origin, builtAt=excluded.builtAt, model=excluded.model, terms=excluded.terms`)
        .run(scope, version, origin, builtAt, model ?? null, JSON.stringify(terms));
      return this.glossary(scope)!;
    });
  }
  /** A copy into another scope is a new glossary: new global version, same terms and origin. */
  private copyGlossary(from: string, to: string) {
    const source = this.glossary(from);
    if (!source) return;
    const version = this.nextVersion();
    this.bumpCounter(version);
    this.db.prepare(`INSERT INTO glossaries (scope,version,origin,builtAt,model,terms) VALUES (?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET version=excluded.version, origin=excluded.origin, builtAt=excluded.builtAt, model=excluded.model, terms=excluded.terms`)
      .run(to, version, source.origin, source.builtAt, source.model ?? null, JSON.stringify(source.terms));
  }

  /**
   * Moves a meeting into a project (or out of one). Refused while anything is running for the meeting (`busy`, worked out
   * by the caller right before this synchronous call), so no job can capture one scope and publish under another (§8.2).
   * `useMeetingGlossary`: a project without a glossary takes a copy of the meeting's own. `also` runs in the same
   * transaction (the meeting's changes still waiting for an OK in the old project are withdrawn).
   */
  move(meetingId: string, projectId: string | null, busy: string[], options: { useMeetingGlossary?: boolean; also?: () => void } = {}) {
    if (busy.length) throw fail(409, `Wait for ${busy.join(', ')} to finish before moving this meeting.`);
    if (projectId) this.get(projectId);
    this.transaction(() => {
      if (projectId && options.useMeetingGlossary && !this.glossary(projectScope(projectId))) this.copyGlossary(meetingScope(meetingId), projectScope(projectId));
      this.db.prepare('UPDATE meetings SET projectId=? WHERE id=?').run(projectId, meetingId);
      options.also?.();
    });
  }
  /**
   * "Put this meeting in a project… → New project": the project starts with the meeting's materials (the same root records,
   * so saved citations still resolve) and a copy of its glossary, so nothing built for the meeting is lost (§8.1).
   */
  async createFromMeeting(meetingId: string, name: string, repoPath: string | null | undefined, busy: () => string[]): Promise<Project> {
    if (this.projectOf(meetingId)) throw fail(409, 'This meeting is already in a project.');
    const repo = await this.checkRepo(repoPath);
    const pending = busy(); // after the last await: nothing can start between this check and the transaction
    if (pending.length) throw fail(409, `Wait for ${pending.join(', ')} to finish before moving this meeting.`);
    const project: Project = { id: randomUUID(), name: cleanName(name), repoPath: repo, createdAt: Date.now(), planAfterNotes: false };
    this.transaction(() => {
      if (this.projectOf(meetingId)) throw fail(409, 'This meeting is already in a project.');
      this.db.prepare('INSERT INTO projects (id,name,repoPath,createdAt) VALUES (?,?,?,?)').run(project.id, project.name, project.repoPath, project.createdAt);
      this.db.prepare('UPDATE material_roots SET scope=? WHERE scope=?').run(projectScope(project.id), meetingScope(meetingId));
      this.copyGlossary(meetingScope(meetingId), projectScope(project.id));
      this.db.prepare('UPDATE meetings SET projectId=? WHERE id=?').run(project.id, meetingId);
    });
    return project;
  }
}

/** A row as a Project: SQLite keeps the setting as 0 or 1. */
const projectOf = (row: Project): Project => ({ ...row, planAfterNotes: Boolean(row.planAfterNotes) });

function cleanName(name: string) {
  const clean = String(name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  if (!clean) throw fail(400, 'A project needs a name.');
  return clean;
}
