import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { Memory } from '../src/memory.ts';
import { Projects } from '../src/projects.ts';
import { Proposals } from '../src/proposals.ts';
import { MemoryFiles } from '../src/memory-files.ts';
import { PlanTodos, AutoPlanning, type PublishedVersion } from '../src/plans/index.ts';
import { deleteMeeting } from '../src/delete-meeting.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { startServer } from '../src/server.ts';
import { JobManager } from '../src/jobs.ts';
import { Boards } from '../src/board.ts';
import { NotesJobs } from '../src/notes.ts';
import { ActionJobs } from '../src/actions.ts';

const recognition = { text: 'The other meeting still decodes.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
async function file(directory: string, path: string, content = 'saved meeting data') {
  const target = join(directory, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function visit(path: string) {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && !child.startsWith('meetings.sqlite')) out[child] = (await readFile(join(directory, child))).toString('base64');
    }
  }
  await visit(''); return out;
}
function rows(store: MeetingStore) {
  return Object.fromEntries((store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
async function richFixture() {
  const f = await setup(), { store, directory, meeting } = f;
  const other = store.createMeeting('Keep this meeting'), projects = new Projects(store, directory), project = await projects.create('Keep project knowledge');
  projects.move(meeting.id, project.id, []); projects.move(other.id, project.id, []);
  const memory = new Memory(store), todos = new PlanTodos(store, memory);
  new AutoPlanning(store);
  const proposals = new Proposals(store, memory, { directory, runner: null, clock: Date.now, projectOf: () => project.id, notesFor: async () => null });
  const memoryFiles = new MemoryFiles(store, memory, proposals, { directory, interpreter: null, guesser: null, clock: Date.now, project: id => projects.get(id), projects: () => projects.list(), meetingTitle: id => store.meeting(id).title });
  memory.saveBrief(project.id, 'Preserved project summary', 'user', null, null);
  store.db.prepare("INSERT INTO memory_files VALUES (?,'todos.md','h','preserved',1,1,1)").run(project.id);
  store.db.prepare("INSERT INTO memory_captures VALUES ('capture',?,'todos.md','preserved','h',NULL,'resolved',NULL,1)").run(project.id);
  store.db.prepare("INSERT INTO memory_inbox VALUES (?,'note.md','h','preserved','done',NULL,1)").run(project.id);
  store.db.prepare("INSERT INTO memory_repo VALUES (?,'head',1)").run(project.id);
  const shared = `imports/${randomUUID()}.media`, own = `imports/${randomUUID()}.media`;
  await file(directory, shared, 'shared media'); await file(directory, own, 'owned media');
  await file(directory, `imports/${randomUUID()}.media`, 'orphan import (kept)');
  store.addMedia(meeting.id, join(directory, shared), 1); store.addMedia(meeting.id, join(directory, own), 1);
  const source = store.addMedia(other.id, join(directory, shared), 1);
  for (const chunk of [...store.chunks(meeting.id), ...store.chunks(other.id)]) store.completeChunk(chunk.id, recognition);
  const frame = await store.addFrame(meeting.id, 'mic', 0, 0, Buffer.alloc(16000 * 4));
  const pcm = await store.addPcm(meeting.id, 'them', 0, 1000, 16000, Buffer.alloc(16000 * 4)); store.completeChunk(pcm.id, recognition);
  store.db.prepare('INSERT INTO recording_sources VALUES (?,?,?,?)').run(meeting.id, 'mic', null, 'ended');
  store.db.prepare('INSERT INTO source_settings VALUES (?,?,?)').run(meeting.id, 'mic', '{}');
  store.db.prepare('INSERT INTO capture_gaps VALUES (?,?,?,?,?,?)').run(meeting.id, 'mic', 1, 2, 3, 'test');
  store.db.prepare('INSERT INTO audio_removals VALUES (?,?)').run(meeting.id, 99);
  store.db.prepare('INSERT INTO plan_auto_attempts (meetingId,notesVersion,at) VALUES (?,?,?)').run(meeting.id, 1, 1);
  await projects.addRoot(`meeting:${meeting.id}`, directory); await projects.addRoot(`project:${project.id}`, directory);
  projects.saveGlossary(`meeting:${meeting.id}`, [], 'user'); projects.saveGlossary(`project:${project.id}`, [], 'user');
  const version = { meetingId: meeting.id, version: 1, plans: [{ id: 'p1', question: 'What next?', fromItems: [], owner: null,
    originPins: { project: project.id }, origin: { run: 'run1', version: 1 },
    steps: [{ id: 'p1.s1', text: 'Keep this project to-do', kind: 'next', if: null, check: 'proposal', basis: [] }] }] } as unknown as PublishedVersion;
  const accepted = todos.accept(version, 'p1.s1', { opId: randomUUID(), expect: 0, project: project.id });
  const run = randomUUID(), exploration = randomUUID(), action = randomUUID();
  store.db.prepare("INSERT INTO memory_runs(id,project,meetingId,state,startedAt) VALUES (?,?,?,'done',1)").run(run, project.id, meeting.id);
  store.db.prepare("INSERT INTO memory_proposals(id,project,run,meetingId,sourceKey,payload,status,createdAt) VALUES (?,?,?,?,?,'{}','pending',1)").run(randomUUID(), project.id, run, meeting.id, 's1');
  store.db.prepare("INSERT INTO memory_effects VALUES (?,?,?,?,?,?)").run(project.id, meeting.id, 's1', 'ref', 'proposed', 1);
  const paths = [`board/${meeting.id}.json`, `notes/${meeting.id}.json`, `plans/${meeting.id}/1.json`, `sessions/${meeting.id}/session.json`,
    `scratch/${meeting.id}/input.md`, `scratch/notes/${meeting.id}/input.md`, `scratch/board/${meeting.id}/scan.md`, `scratch/memory/${meeting.id}/input.md`,
    `scratch/memory-snapshots/${meeting.id}/snapshot/past-notes/kept.md`, `scratch/explore/${meeting.id}/${exploration}/work.py`, `scratch/actions/${action}/work.py`,
    `processes/${action}/old.txt`, `processes/${exploration}/old.txt`, `glossaries.migrated/${meeting.id}.json`];
  for (const path of paths) await file(directory, path);
  await file(directory, `plans/${meeting.id}/1.json`, JSON.stringify(version));
  await file(directory, `actions/${meeting.id}/${action}.json`, JSON.stringify({ id: action, meetingId: meeting.id, state: 'done' }));
  await file(directory, `actions/${meeting.id}/${action}.evidence`);
  await file(directory, `explorations/${meeting.id}/${exploration}/job.json`, JSON.stringify({ id: exploration, meetingId: meeting.id, state: 'done', kind: 'explore' }));
  const copiedNote = `scratch/memory-snapshots/${other.id}/snapshot/past-notes/${new Date(meeting.createdAt).toISOString().slice(0, 10)}-${meeting.id.slice(0, 8)}.md`;
  await file(directory, copiedNote, 'The deleted meeting\'s notes saved as another action\'s evidence.');
  for (const path of [`notes/${other.id}.json`, 'logs/launcher.log', 'pdf-text/files/shared.pdf.txt', 'transcripts/separate/transcript.md', `projects/${project.id}/project-memory/todos.md`]) await file(directory, path, 'keep');
  await file(directory, 'materials.json.migrated', JSON.stringify([{ meetingId: meeting.id, id: 'delete' }, { meetingId: other.id, id: 'keep' }]));
  return { ...f, other, projects, project, memory, proposals, accepted, paths, copiedNote, shared, own, frame, source,
    async close() { await memoryFiles.close(); await proposals.close(); await f.close(); } };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-delete-'));
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Remove this meeting');
  return { directory, store, meeting, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('deleteMeeting removes its meeting and audio, leaving another meeting intact', async () => {
  const f = await setup();
  try {
    const other = f.store.createMeeting('Keep this meeting');
    await mkdir(join(f.directory, 'audio', f.meeting.id), { recursive: true });
    await writeFile(join(f.directory, 'audio', f.meeting.id, 'test.f32'), 'audio');
    f.store.deleteMeeting(f.meeting.id);
    assert.throws(() => f.store.meeting(f.meeting.id), /not found/i);
    assert.equal(existsSync(join(f.directory, 'audio', f.meeting.id)), false);
    assert.equal(f.store.meeting(other.id).title, 'Keep this meeting');
  } finally { await f.close(); }
});


test('complete deletion keeps project memory, its Undo, shared imports and other meeting evidence/decoding', async () => {
  const f = await richFixture();
  try {
    const before = rows(f.store), beforeFiles = await snapshot(f.directory), preview = f.store.inspectMeetingDeletion(f.meeting.id);
    assert.equal(preview.evidenceCopiesElsewhere, 1);
    for (const table of ['chunks', 'segments', 'frames', 'source_settings', 'recording_sources', 'capture_gaps', 'audio_removals', 'plan_acceptances', 'plan_operations', 'plan_auto_attempts', 'memory_runs', 'memory_proposals', 'memory_effects', 'material_roots', 'glossaries', 'meetings']) assert.ok(preview.rows[table] > 0, table);
    assert.deepEqual(preview.imports, [f.own]);
    assert.ok(preview.fileBytes >= 128000);
    const evidence = await readFile(join(f.directory, f.copiedNote), 'utf8');
    f.store.deleteMeeting(f.meeting.id);
    for (const [table, records] of Object.entries(rows(f.store))) {
      assert.equal(records.some(r => r.meetingId === f.meeting.id || (table === 'meetings' && r.id === f.meeting.id) || r.scope === `meeting:${f.meeting.id}`), false, table);
    }
    for (const table of ['memory_items', 'memory_events', 'memory_batches', 'memory_brief', 'memory_files', 'memory_captures', 'memory_inbox', 'memory_repo', 'projects', 'counters']) assert.deepEqual(rows(f.store)[table], before[table], table);
    for (const path of preview.paths) assert.equal(existsSync(join(f.directory, path)), false, path);
    assert.equal(existsSync(join(f.directory, f.own)), false);
    const fileBytes = (files: Record<string, string>) => Object.values(files).reduce((n, content) => n + Buffer.from(content, 'base64').length, 0);
    assert.equal(preview.fileBytes, fileBytes(beforeFiles) - fileBytes(await snapshot(f.directory)));
    assert.equal(await readFile(join(f.directory, f.shared), 'utf8'), 'shared media');
    assert.equal(await readFile(join(f.directory, f.copiedNote), 'utf8'), evidence);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'materials.json.migrated'), 'utf8')), [{ meetingId: f.other.id, id: 'keep' }]);
    for (const path of ['logs/launcher.log', 'pdf-text/files/shared.pdf.txt', 'transcripts/separate/transcript.md', `projects/${f.project.id}/project-memory/todos.md`]) assert.equal(await readFile(join(f.directory, path), 'utf8'), 'keep');
    assert.equal(f.projects.roots(`project:${f.project.id}`).length, 1);
    assert.ok(f.projects.glossary(`project:${f.project.id}`));
    assert.equal(f.memory.item(f.project.id, f.accepted.todo)!.status, 'open');
    f.memory.undo(f.project.id, f.accepted.batch, randomUUID());
    assert.equal(f.memory.item(f.project.id, f.accepted.todo)!.status, 'dropped');
    assert.equal(f.memory.batch(f.project.id, f.accepted.batch)!.undone, true);
    const chunk = f.store.chunks(f.other.id)[0];
    f.store.setStatus(chunk.id, 'queued');
    const jobs = new JobManager(f.store, { async transcribe(c) { assert.equal(await readFile(c.path, 'utf8'), 'shared media'); return recognition; }, close() {} });
    jobs.kick(); await jobs.wait(); await jobs.close();
    assert.equal(f.store.chunks(f.other.id)[0].status, 'completed');
    assert.match(f.store.markdown(f.other.id), /other meeting still decodes/);
  } finally { await f.close(); }
});

const refusalCases: [string, (f: Awaited<ReturnType<typeof setup>>) => Promise<void> | void][] = [
  ['recording', f => f.store.claimRecording(f.meeting.id, 'mic', null)],
  ['recovering recording', f => { f.store.claimRecording(f.meeting.id, 'mic', null); f.store.recoverRecordings(); }],
  ['playing replay', f => { f.store.db.prepare('UPDATE meetings SET replay=? WHERE id=?').run(JSON.stringify({ startedAt: Date.now(), speed: 1, durationMs: 60000, baseMs: 0, sourceId: 'file' }), f.meeting.id); }],
  ...(['queued', 'running', 'failed', 'cancelled'] as const).map(status => [`${status} chunk`, (f: Awaited<ReturnType<typeof setup>>) => {
    f.store.addMedia(f.meeting.id, '/external/not-deleted.media', 1); f.store.setStatus(f.store.chunks(f.meeting.id)[0].id, status);
  }] as [string, (f: Awaited<ReturnType<typeof setup>>) => void]),
  ['notes job', f => file(f.directory, `notes/${f.meeting.id}.job.json`, JSON.stringify({ state: 'running' }))],
  ['board job', f => file(f.directory, `board/${f.meeting.id}.job.json`, JSON.stringify({ state: 'running' }))],
  ['action job', f => file(f.directory, `actions/${f.meeting.id}/action-id.json`, JSON.stringify({ id: 'action-id', meetingId: f.meeting.id, state: 'running' }))],
  ['queued action', f => file(f.directory, `actions/${f.meeting.id}/action-id.json`, JSON.stringify({ id: 'action-id', meetingId: f.meeting.id, state: 'queued' }))],
  ['plan job', f => file(f.directory, `explorations/${f.meeting.id}/plan-id/job.json`, JSON.stringify({ id: 'plan-id', meetingId: f.meeting.id, state: 'running', kind: 'plan' }))],
  ['exploration job', f => file(f.directory, `explorations/${f.meeting.id}/explore-id/job.json`, JSON.stringify({ id: 'explore-id', meetingId: f.meeting.id, state: 'running', kind: 'explore' }))],
  ['waiting exploration', f => file(f.directory, `explorations/${f.meeting.id}/explore-id/job.json`, JSON.stringify({ id: 'explore-id', meetingId: f.meeting.id, state: 'waiting', kind: 'explore' }))],
  ['memory run', f => {
    const memory = new Memory(f.store);
    new Proposals(f.store, memory, { directory: f.directory, runner: null, clock: Date.now, projectOf: () => 'p', notesFor: async () => null });
    f.store.db.prepare("INSERT INTO memory_runs (id,project,meetingId,state,startedAt) VALUES ('run','p',?,'running',1)").run(f.meeting.id);
  }],
  ['live process record', async f => {
    await file(f.directory, `actions/${f.meeting.id}/action-id.json`, JSON.stringify({ id: 'action-id', meetingId: f.meeting.id, state: 'done' }));
    const pgid = Number((await import('node:child_process')).execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    await file(f.directory, 'processes/action-id/pi.json', JSON.stringify({ pgid }));
  }],
];
for (const [name, arrange] of refusalCases) test(`refuses ${name} without changing rows or files`, async () => {
  const f = await setup();
  try {
    await arrange(f);
    await file(f.directory, `audio/${f.meeting.id}/keep.f32`);
    const beforeRows = rows(f.store), beforeFiles = await snapshot(f.directory);
    assert.throws(() => f.store.deleteMeeting(f.meeting.id), (e: Error & { status?: number }) => e.status === 409 && /Cannot delete/.test(e.message));
    assert.deepEqual(rows(f.store), beforeRows); assert.deepEqual(await snapshot(f.directory), beforeFiles);
  } finally { await f.close(); }
});

test('unknown id refuses without any change', async () => {
  const f = await setup();
  try {
    const before = rows(f.store), files = await snapshot(f.directory);
    assert.throws(() => f.store.deleteMeeting(randomUUID()), /Unknown meeting/);
    assert.deepEqual(rows(f.store), before); assert.deepEqual(await snapshot(f.directory), files);
  } finally { await f.close(); }
});

test('crash after COMMIT retains cleanup manifest: reopen and retry removes files, never resurrects meeting', async () => {
  const f = await richFixture();
  let reopened: MeetingStore | undefined;
  try {
    assert.throws(() => deleteMeeting(f.store, f.meeting.id, { afterCommit() { throw new Error('simulated crash'); } }), /simulated crash/);
    assert.throws(() => f.store.meeting(f.meeting.id), /not found/i);
    assert.equal(existsSync(join(f.directory, f.own)), true);
    reopened = new MeetingStore(f.directory);
    assert.equal(reopened.inspectMeetingDeletion(f.meeting.id).pending, true);
    reopened.deleteMeeting(f.meeting.id);
    assert.equal(existsSync(join(f.directory, 'audio', f.meeting.id)), false);
    assert.equal(existsSync(join(f.directory, f.own)), false);
    assert.equal(existsSync(join(f.directory, f.shared)), true);
    assert.deepEqual(reopened.db.prepare('SELECT * FROM meeting_deletions').all(), []);
    assert.throws(() => reopened!.meeting(f.meeting.id), /not found/i);
  } finally { reopened?.close(); await f.close(); }
});

test('a database deletion failure rolls back every table and the cleanup manifest', async () => {
  const f = await richFixture();
  try {
    f.store.db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON meetings BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END");
    const before = rows(f.store), files = await snapshot(f.directory);
    assert.throws(() => f.store.deleteMeeting(f.meeting.id), /test deletion failure/);
    assert.deepEqual(rows(f.store), before); assert.deepEqual(await snapshot(f.directory), files);
  } finally { await f.close(); }
});

test('symlinks in and at meeting folders never remove their outside targets', async () => {
  const f = await setup(), outside = await mkdtemp(join(tmpdir(), 'meeting-delete-outside-'));
  try {
    await file(outside, 'keep.txt', 'outside target');
    await mkdir(join(f.directory, 'audio', f.meeting.id), { recursive: true });
    await symlink(outside, join(f.directory, 'audio', f.meeting.id, 'outside'));
    await mkdir(join(f.directory, 'plans'), { recursive: true });
    await symlink(outside, join(f.directory, 'plans', f.meeting.id));
    f.store.deleteMeeting(f.meeting.id);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside target');
    assert.equal(existsSync(join(f.directory, 'plans', f.meeting.id)), false);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test('a symlink parent escaping data refuses before changing anything', async () => {
  const f = await setup(), outside = await mkdtemp(join(tmpdir(), 'meeting-delete-outside-'));
  try {
    await file(outside, `${f.meeting.id}/keep.txt`, 'outside'); await symlink(outside, join(f.directory, 'audio'));
    const before = rows(f.store);
    assert.throws(() => f.store.deleteMeeting(f.meeting.id), /Symlink parent/);
    assert.deepEqual(rows(f.store), before);
    assert.equal(await readFile(join(outside, f.meeting.id, 'keep.txt'), 'utf8'), 'outside');
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test('in-process board, notes, actions and memory preparation are refused before their job files exist', async () => {
  for (const kind of ['board', 'notes', 'actions', 'memory'] as const) {
    const f = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let work: Promise<unknown> | undefined, close: (() => Promise<void>) | undefined;
    try {
      if (kind === 'board') {
        const boards = new Boards({ store: f.store, directory: f.directory, clock: Date.now, ask: async () => { throw new Error('not reached'); }, actions: null,
          glossaryFor: async () => { await gate; return null; }, hasMaterials: () => false });
        work = boards.requestScan(f.meeting.id); close = () => boards.close();
      } else if (kind === 'notes') {
        const jobs = new NotesJobs({ store: f.store, directory: f.directory, clock: Date.now, runner: async () => { throw new Error('not reached'); },
          glossaryFor: async () => { await gate; return null; } });
        // start() claims its running map before awaiting the glossary/input snapshot.
        work = jobs.start(f.meeting.id).catch(() => {}); close = () => jobs.close();
      } else if (kind === 'actions') {
        const jobs = new ActionJobs({ store: f.store, directory: f.directory, clock: Date.now, runner: async () => { throw new Error('not reached'); },
          glossaryFor: async () => { await gate; return null; }, rootsFor: () => [] });
        work = jobs.submit(f.meeting.id, { action: 'other', prompt: 'Explain', selection: { text: 'Something said', segmentIds: [] } }).catch(() => {});
        close = () => jobs.close();
      } else {
        const proposals = new Proposals(f.store, new Memory(f.store), { directory: f.directory, runner: async () => { throw new Error('not reached'); }, clock: Date.now,
          projectOf: () => 'p', notesFor: async () => { await gate; return null; } });
        work = proposals.start(f.meeting.id).catch(() => {}); close = () => proposals.close();
      }
      const before = rows(f.store), files = await snapshot(f.directory);
      assert.throws(() => f.store.deleteMeeting(f.meeting.id), /agent work is running or waiting/, kind);
      assert.deepEqual(rows(f.store), before); assert.deepEqual(await snapshot(f.directory), files);
    } finally { release(); await work; await close?.(); await f.close(); }
  }
});

test('realpath aliases from another meeting keep an import alive', async () => {
  const f = await setup();
  try {
    const other = f.store.createMeeting('Alias user'), owned = `imports/${randomUUID()}.media`, alias = `imports/${randomUUID()}.media`;
    await file(f.directory, owned, 'keep shared target'); await symlink(join(f.directory, owned), join(f.directory, alias));
    for (const [id, path] of [[f.meeting.id, owned], [other.id, alias]]) {
      f.store.addMedia(id, join(f.directory, path), 1); f.store.completeChunk(f.store.chunks(id)[0].id, recognition);
    }
    f.store.deleteMeeting(f.meeting.id);
    assert.equal(await readFile(join(f.directory, alias), 'utf8'), 'keep shared target');
    assert.equal(existsSync(join(f.directory, owned)), true);
  } finally { await f.close(); }
});

test('file cleanup rerun tolerates already removed files and rechecks newly shared imports', async () => {
  const f = await richFixture();
  try {
    assert.throws(() => deleteMeeting(f.store, f.meeting.id, { afterCommit() { throw new Error('crash'); } }), /crash/);
    await rm(join(f.directory, 'audio', f.meeting.id), { recursive: true });
    f.store.addMedia(f.other.id, join(f.directory, f.own), 1);
    f.store.completeChunk(f.store.chunks(f.other.id).at(-1)!.id, recognition);
    f.store.deleteMeeting(f.meeting.id);
    assert.equal(await readFile(join(f.directory, f.own), 'utf8'), 'owned media');
    assert.equal(existsSync(join(f.directory, 'plans', f.meeting.id)), false);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []);
  } finally { await f.close(); }
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function cli(args: string[], env: NodeJS.ProcessEnv = {}, npm = false) {
  const port = await availablePort();
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(npm ? 'npm' : process.execPath, npm ? ['run', 'delete-meetings', '--', ...args] : ['--experimental-strip-types', 'scripts/delete-meetings.ts', ...args],
      { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, text }));
  });
}

test('CLI --keep dry run lists exactly the others, reports saved evidence copies, and unknown ids change nothing', async () => {
  const f = await richFixture();
  try {
    const third = f.store.createMeeting('Also kept');
    const before = rows(f.store), files = await snapshot(f.directory);
    const result = await cli(['--data', f.directory, '--keep', f.other.id, third.id], {}, true);
    assert.equal(result.code, 0, result.text); assert.match(result.text, /DRY RUN/);
    const listed = [...result.text.matchAll(/^([a-f0-9-]{36}) — /gm)].map(m => m[1]);
    assert.deepEqual(listed, [f.meeting.id]); assert.match(result.text, /Saved past-notes copies in other meetings: 1/);
    assert.match(result.text, /plan_acceptances: 1 rows/); assert.match(result.text, /Total: 1 meeting/);
    if (process.env.DELETE_EVIDENCE_DIR) await writeFile(join(process.env.DELETE_EVIDENCE_DIR, 'temporary-data-dry-run.txt'), `Temporary fixture created by test: ${f.directory}\n${result.text}`);
    for (const args of [[f.meeting.id, randomUUID(), '--yes'], ['--keep', randomUUID()]]) {
      const failed = await cli(['--data', f.directory, ...args]); assert.notEqual(failed.code, 0); assert.match(failed.text, /Unknown meeting/);
    }
    assert.deepEqual(rows(f.store), before); assert.deepEqual(await snapshot(f.directory), files);
  } finally { await f.close(); }
});

test('CLI finishes pending cleanup by id even during a dry run', async () => {
  const f = await richFixture();
  try {
    assert.throws(() => deleteMeeting(f.store, f.meeting.id, { afterCommit() { throw new Error('crash'); } }), /crash/);
    const dry = await cli(['--data', f.directory, f.meeting.id]);
    assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /Finishing pending deletion/);
    assert.match(dry.text, /Total: 0 meeting\(s\), 0 rows/);
    const result = await cli(['--data', f.directory, '--yes', '--keep', f.other.id]);
    assert.equal(result.code, 0, result.text);
    assert.equal(existsSync(join(f.directory, 'audio', f.meeting.id)), false);
    assert.equal(existsSync(join(f.directory, f.own)), false);
    assert.equal(f.store.meeting(f.other.id).title, 'Keep this meeting');
    assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []);
  } finally { await f.close(); }
});

test('CLI respects MEETING_DATA_DIR, accounts for imports shared within selection, and --yes deletes', async () => {
  const f = await setup();
  try {
    const other = f.store.createMeeting('Also delete'), third = f.store.createMeeting('Keep');
    const media = `imports/${randomUUID()}.media`; await file(f.directory, media, '12345');
    for (const id of [f.meeting.id, other.id]) { f.store.addMedia(id, join(f.directory, media), 1); f.store.completeChunk(f.store.chunks(id)[0].id, recognition); }
    const dry = await cli([f.meeting.id, other.id], { MEETING_DATA_DIR: f.directory });
    assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /5 file bytes/);
    const result = await cli(['--yes', '--keep', third.id], { MEETING_DATA_DIR: f.directory });
    assert.equal(result.code, 0, result.text); assert.equal(existsSync(join(f.directory, media)), false);
    assert.deepEqual(f.store.meetings().map(m => m.id), [third.id]);
  } finally { await f.close(); }
});

test('CLI refuses an IPv6 listener on the configured port', async () => {
  const f = await setup(), listener = createServer();
  try {
    await new Promise<void>(resolve => listener.listen({ port: 0, host: '::1', ipv6Only: true }, resolve));
    const port = (listener.address() as { port: number }).port;
    const result = await cli(['--data', f.directory, f.meeting.id, '--yes'], { PORT: String(port) });
    assert.notEqual(result.code, 0); assert.match(result.text, /port .*in use or unavailable/);
    assert.equal(f.store.meeting(f.meeting.id).title, f.meeting.title);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); await f.close(); }
});

test('CLI refuses an occupied configured port, a live server.lock, and a SQLite writer', async () => {
  const f = await setup(), listener = createServer();
  try {
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    const occupied = await cli(['--data', f.directory, f.meeting.id, '--yes'], { PORT: String(port) });
    assert.notEqual(occupied.code, 0); assert.match(occupied.text, /port .*in use or unavailable/);
    await file(f.directory, 'server.lock', String(process.pid));
    const locked = await cli(['--data', f.directory, f.meeting.id, '--yes']); assert.notEqual(locked.code, 0); assert.match(locked.text, /data folder is in use/);
    await rm(join(f.directory, 'server.lock'));
    f.store.db.exec('BEGIN IMMEDIATE');
    try {
      const busy = await cli(['--data', f.directory, f.meeting.id, '--yes']); assert.notEqual(busy.code, 0); assert.match(busy.text, /database is locked/);
    } finally { f.store.db.exec('ROLLBACK'); }
    assert.equal(f.store.meeting(f.meeting.id).title, f.meeting.title);
    assert.equal(existsSync(join(f.directory, 'server.lock')), false);
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); await f.close(); }
});

test('deleted plan-step Undo and Add/retry APIs return a clear 404', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-delete-api-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null });
  try {
    const meeting = app.store.createMeeting('Remove workflow');
    app.store.deleteMeeting(meeting.id);
    const page = await fetch(app.url), cookie = page.headers.get('set-cookie')!.split(';')[0];
    for (const verb of ['undo', 'todo']) {
      const response = await fetch(`${app.url}/api/meetings/${meeting.id}/plans/1/steps/p1.s1/${verb}`, {
        method: 'POST', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ opId: randomUUID(), expect: 1 }),
      });
      assert.equal(response.status, 404); assert.match((await response.json()).error, /Meeting not found/);
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
