import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';
import { Projects, meetingScope, projectScope } from '../src/projects.ts';
import { startServer } from '../src/server.ts';

const terms = [{ term: 'protein skimmer', spokenVariants: ['pro teen simmer'] }];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-projects-'));
  const store = new MeetingStore(directory);
  const projects = new Projects(store, directory);
  const folder = join(directory, 'materials');
  await mkdir(folder);
  return { directory, store, projects, folder, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('overlapping new-project requests keep the meeting and its materials together', async () => {
  const f = await fixture();
  try {
    const meeting = f.store.createMeeting('M');
    const root = await f.projects.addRoot(meetingScope(meeting.id), f.folder);
    const results = await Promise.allSettled([
      f.projects.createFromMeeting(meeting.id, 'A', null, () => []),
      f.projects.createFromMeeting(meeting.id, 'B', null, () => []),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.status, 409);
    const project = f.projects.projectOf(meeting.id)!;
    assert.equal(f.projects.list().length, 1);
    assert.deepEqual(f.projects.rootsFor(meeting.id).map(r => [r.id, r.scope]), [[root.id, projectScope(project)]]);
  } finally { await f.close(); }
});

test('the effective scope: project materials and glossary, plus the meeting\'s own materials', async () => {
  const f = await fixture();
  try {
    const meeting = f.store.createMeeting('M');
    const own = await f.projects.addRoot(meetingScope(meeting.id), f.folder);
    assert.deepEqual(f.projects.scope(meeting.id), { projectId: null, roots: [own], glossaryScope: meetingScope(meeting.id) });
    const project = await f.projects.create('Tidepool Care');
    const shared = await f.projects.addRoot(projectScope(project.id), f.folder);
    f.projects.move(meeting.id, project.id, []);
    const scope = f.projects.scope(meeting.id);
    assert.equal(scope.projectId, project.id);
    assert.deepEqual(scope.roots.map(r => r.id), [shared.id, own.id], 'project roots first, the meeting\'s own still apply');
    assert.equal(scope.glossaryScope, projectScope(project.id));
    f.projects.move(meeting.id, null, []);
    assert.deepEqual(f.projects.rootsFor(meeting.id).map(r => r.id), [own.id], 'out of the project, its materials no longer apply');
  } finally { await f.close(); }
});

test('glossary versions are global; a build is a compare-and-swap; a generated glossary never replaces a user edit', async () => {
  const f = await fixture();
  try {
    const a = f.store.createMeeting('A'), b = f.store.createMeeting('B');
    const ga = f.projects.saveGlossary(meetingScope(a.id), terms, 'generated');
    const gb = f.projects.saveGlossary(meetingScope(b.id), terms, 'generated');
    assert.notEqual(ga.version, gb.version, 'two scopes never share a version');
    assert.throws(() => f.projects.saveGlossary(meetingScope(a.id), terms, 'generated', 'sol', ga.version - 1), /changed while it was being rebuilt/);
    const edited = f.projects.saveGlossary(meetingScope(a.id), terms.slice(0, 0), 'user');
    assert.ok(edited.version > gb.version, 'versions only move forward');
    assert.throws(() => f.projects.saveGlossary(meetingScope(a.id), terms, 'generated', 'sol', edited.version), /edited by the user/);
    const c = f.store.createMeeting('C');
    assert.ok(f.projects.saveGlossary(meetingScope(c.id), terms, 'generated', 'sol', null), 'a first build expects no glossary yet');
    assert.throws(() => f.projects.saveGlossary(meetingScope(b.id), terms, 'generated', 'sol', null), /changed while/, 'a glossary saved during a first build is not replaced');
  } finally { await f.close(); }
});

test('a new project from a meeting keeps its materials and a copy of its glossary; moves wait for running work', async () => {
  const f = await fixture();
  try {
    const meeting = f.store.createMeeting('M');
    const root = await f.projects.addRoot(meetingScope(meeting.id), f.folder);
    const glossary = f.projects.saveGlossary(meetingScope(meeting.id), terms, 'user');
    await assert.rejects(f.projects.createFromMeeting(meeting.id, 'P', null, () => ['the notes']), /Wait for the notes to finish/);
    assert.equal(f.projects.list().length, 0, 'nothing is created when the move is refused');
    const project = await f.projects.createFromMeeting(meeting.id, 'Tidepool Care', f.folder, () => []);
    assert.equal(f.projects.projectOf(meeting.id), project.id);
    assert.deepEqual(f.projects.rootsFor(meeting.id).map(r => [r.id, r.scope]), [[root.id, projectScope(project.id)]], 'same root record, now the project\'s');
    const copy = f.projects.glossaryFor(meeting.id)!;
    assert.deepEqual([copy.terms, copy.origin], [terms, 'user']);
    assert.notEqual(copy.version, glossary.version, 'the copy is a new glossary');
    await assert.rejects(f.projects.create('Other', f.folder), /already belongs to the project "Tidepool Care"/);
    await assert.rejects(f.projects.create('Missing', join(f.directory, 'nope')), /does not exist/);
    assert.throws(() => f.projects.move(meeting.id, null, ['the recording']), (e: any) => e.status === 409 && /the recording/.test(e.message));
    const other = f.store.createMeeting('N');
    f.projects.saveGlossary(meetingScope(other.id), terms, 'generated');
    const empty = await f.projects.create('Empty');
    f.projects.move(other.id, empty.id, [], { useMeetingGlossary: true });
    assert.deepEqual(f.projects.glossaryFor(other.id)!.terms, terms, 'a project without a glossary can take the meeting\'s');
  } finally { await f.close(); }
});

test('pre-M6 materials.json and glossary files are imported once; a clashing version is renumbered with its marks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-migrate-'));
  try {
    let store = new MeetingStore(directory);
    const a = store.createMeeting('A'), b = store.createMeeting('B');
    const chunk = await store.addPcm(b.id, `mic:${randomUUID()}`, 0, 0, 16000, Buffer.alloc(16000 * 4));
    store.completeChunk(chunk.id, { text: 'hello there', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' } as any);
    const [segment] = store.segments(b.id);
    store.markCorrectionChecked([segment.id], 2);
    store.setCorrectionState(b.id, { glossaryVersion: 2, lastCallAt: 0, stats: {} });
    await writeFile(join(directory, 'materials.json'), JSON.stringify([{ id: 'R-old', meetingId: a.id, path: directory, kind: 'folder', label: 'data' }]));
    await mkdir(join(directory, 'glossaries'));
    await writeFile(join(directory, 'glossaries', `${a.id}.json`), JSON.stringify({ version: 2, origin: 'generated', builtAt: 1, terms }));
    await writeFile(join(directory, 'glossaries', `${b.id}.json`), JSON.stringify({ version: 2, origin: 'user', builtAt: 2, terms }));
    let projects = new Projects(store, directory);
    await projects.migrate();
    assert.deepEqual(projects.rootsFor(a.id).map(r => r.id), ['R-old'], 'root ids are kept for saved citations');
    assert.equal(projects.glossaryFor(a.id)!.version, 2, 'the first keeps its number');
    const moved = projects.glossaryFor(b.id)!.version;
    assert.notEqual(moved, 2);
    assert.equal(store.segment(segment.id)!.correctionChecked, moved, 'checked lines follow their glossary');
    assert.equal(store.correctionState<{ glossaryVersion: number }>(b.id)!.glossaryVersion, moved);
    assert.deepEqual((await readdir(directory)).filter(n => /materials|glossaries/.test(n)).sort(), ['glossaries.migrated', 'materials.json.migrated']);
    store.close();
    store = new MeetingStore(directory);
    projects = new Projects(store, directory);
    await projects.migrate();
    assert.equal(projects.glossaryFor(b.id)!.version, moved, 'a restart changes nothing');
    assert.ok(projects.saveGlossary(meetingScope(a.id), terms, 'generated', undefined, 2).version > moved, 'new versions follow the imported ones');
    store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('server: projects, materials by scope, and a move refused while recording', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-projects-server-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: {
    async transcribe() { return { text: 'Test', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; },
    close() {},
  } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, method = 'GET', body?: unknown) => fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const meeting = await (await call('/api/meetings', 'POST', {})).json();
    assert.equal((await call(`/api/meetings/${meeting.id}/materials`, 'POST', { path: directory })).status, 201);
    const created = await call('/api/projects', 'POST', { name: 'Tidepool Care', fromMeetingId: meeting.id });
    assert.equal(created.status, 201);
    const project = await created.json();
    const detail = await (await call(`/api/meetings/${meeting.id}`)).json();
    assert.equal(detail.project.id, project.id);
    assert.equal(detail.materials[0].scope, `project:${project.id}`);
    assert.equal((await call(`/api/meetings/${meeting.id}/materials`, 'POST', { path: directory, scope: 'meeting' })).status, 201);
    assert.deepEqual((await (await call(`/api/meetings/${meeting.id}`)).json()).materials.map((m: any) => m.scope.split(':')[0]), ['project', 'meeting']);
    assert.deepEqual((await (await call('/api/projects')).json()).projects.map((p: any) => [p.name, p.meetings]), [['Tidepool Care', 1]]);
    const source = `mic:${randomUUID()}`;
    await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url, 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0' }, body: Buffer.alloc(16000 * 4) });
    const refused = await call(`/api/meetings/${meeting.id}/project`, 'POST', { projectId: null });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /the recording/);
    assert.equal((await call(`/api/meetings/${meeting.id}/pcm/end`, 'POST', { source, lastSequence: 0 })).status, 200);
    const moved = await call(`/api/meetings/${meeting.id}/project`, 'POST', { projectId: null });
    assert.equal(moved.status, 200, 'after Stop the move goes through');
    assert.equal((await (await call(`/api/meetings/${meeting.id}`)).json()).project, null);
    assert.equal((await call('/api/projects', 'POST', { name: '  ' })).status, 400);
    // Memory: the user's own change, a stale view refused, Undo, the timeline.
    const base = `/api/projects/${project.id}`;
    const made = await (await call(`${base}/memory`, 'POST', { requestId: 'r1', changes: [{ op: 'create', type: 'todo', text: 'Replace the nursery air stone', source: { kind: 'meeting', meetingId: 'forged' } }] })).json();
    assert.equal(made.created['T-1'], 'T-1');
    const item = (await (await call(`${base}/memory`)).json()).items[0];
    assert.deepEqual([item.confirmed, item.version], [true, 1]);
    assert.equal((await (await call(`${base}/memory/items/T-1`)).json()).timeline[0].source.kind, 'app', 'the app records its own source');
    assert.equal((await call(`${base}/memory`, 'POST', { requestId: 'r2', changes: [{ op: 'status', item: 'T-1', to: 'done' }], expect: { 'T-1': 0 } })).status, 409);
    const done = await (await call(`${base}/memory`, 'POST', { requestId: 'r3', changes: [{ op: 'status', item: 'T-1', to: 'done' }], expect: { 'T-1': 1 } })).json();
    assert.equal((await call(`${base}/memory/undo`, 'POST', { batch: done.batch, requestId: 'r4' })).status, 200);
    assert.equal((await (await call(`${base}/memory`)).json()).items[0].status, 'open');
    assert.equal((await call(`/api/projects/${randomUUID()}/memory`)).status, 404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
