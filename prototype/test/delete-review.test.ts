import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, rename } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { MeetingStore } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { Projects } from '../src/projects.ts';
import { deleteMeeting } from '../src/delete-meeting.ts';
import { parseDeleteArguments } from '../scripts/delete-meetings.ts';
import { startServer } from '../src/server.ts';

const recognized = { text: '', backend: 'test', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
async function put(directory: string, path: string, text = 'data') {
  await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), text);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-delete-review-')), store = new MeetingStore(directory);
  const removed = store.createMeeting('Delete'), kept = store.createMeeting('Keep');
  return { directory, store, removed, kept, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
function media(store: MeetingStore, id: string, path: string) {
  store.addMedia(id, path, 1);
  const chunk = store.chunks(id).at(-1)!; store.completeChunk(chunk.id, recognized); return chunk;
}
async function cli(directory: string, args: string[]) {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/delete-meetings.ts', '--data', directory, ...args],
      { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', part => { text += part; }); child.stderr.on('data', part => { text += part; });
    child.once('error', reject); child.once('close', code => resolve({ code, text }));
  });
}
function crash(store: MeetingStore, id: string) {
  assert.throws(() => deleteMeeting(store, id, { afterCommit() { throw new Error('crash'); } }), /crash/);
}
function dbRows(store: MeetingStore) {
  return (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}

for (const mode of ['store', 'CLI'] as const) test(`${mode} uses relocated paths for both removed and surviving imports`, async () => {
  const f = await fixture();
  try {
    const shared = `imports/${randomUUID()}.media`, own = `imports/${randomUUID()}.media`;
    await put(f.directory, shared, 'shared'); await put(f.directory, own, 'owned');
    media(f.store, f.removed.id, join(f.directory, shared)); media(f.store, f.kept.id, join(f.directory, shared)); media(f.store, f.removed.id, join(f.directory, own));
    f.store.db.prepare("UPDATE chunks SET path='/old-volume/moved-data/' || substr(path,1)").run();
    if (mode === 'store') f.store.deleteMeeting(f.removed.id);
    else { const result = await cli(f.directory, ['--yes', f.removed.id]); assert.equal(result.code, 0, result.text); }
    assert.equal(await readFile(join(f.directory, shared), 'utf8'), 'shared');
    assert.equal(fs.existsSync(join(f.directory, own)), false);
  } finally { await f.close(); }
});

for (const mode of ['module', 'CLI'] as const) test(`${mode} resolves imports after the actual data directory moves`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-delete-moved-')), original = join(root, 'original'), moved = join(root, 'moved');
  await mkdir(original); let store: MeetingStore | undefined = new MeetingStore(original); let db: DatabaseSync | undefined;
  try {
    const removed = store.createMeeting('Remove moved'), kept = store.createMeeting('Keep moved');
    const shared = `imports/${randomUUID()}.media`, own = `imports/${randomUUID()}.media`;
    await put(original, shared, 'shared'); await put(original, own, 'owned');
    media(store, removed.id, join(original, shared)); media(store, kept.id, join(original, shared)); media(store, removed.id, join(original, own));
    for (const chunk of store.db.prepare('SELECT id,path FROM chunks').all() as { id: string; path: string }[]) store.db.prepare('UPDATE chunks SET path=? WHERE id=?').run(join(original, chunk.path), chunk.id);
    store.close(); store = undefined; await rename(original, moved);
    if (mode === 'CLI') { const result = await cli(moved, ['--yes', removed.id]); assert.equal(result.code, 0, result.text); }
    else { db = new DatabaseSync(join(moved, 'meetings.sqlite')); db.exec('PRAGMA foreign_keys=ON'); deleteMeeting({ db, directory: moved }, removed.id); }
    assert.equal(await readFile(join(moved, shared), 'utf8'), 'shared'); assert.equal(fs.existsSync(join(moved, own)), false);
  } finally { db?.close(); store?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [table, area] of [['chunks', 'audio'], ['frames', 'plans'], ['material_roots', 'scratch']] as const) test(`surviving ${table} reference into planned ${area} refuses before changing anything`, async () => {
  const f = await fixture();
  try {
    const path = `${area}/${f.removed.id}/shared.media`; await put(f.directory, path, 'keep reference');
    if (table === 'chunks') media(f.store, f.kept.id, join(f.directory, path));
    else if (table === 'frames') {
      const { frame } = await f.store.addFrame(f.kept.id, 'mic', 0, 0, Buffer.alloc(64000));
      f.store.db.prepare('UPDATE frames SET path=? WHERE id=?').run(path, frame.id);
    } else {
      const projects = new Projects(f.store, f.directory), project = await projects.create('Retained project');
      await projects.addRoot(`project:${project.id}`, join(f.directory, path));
    }
    const before = dbRows(f.store);
    assert.throws(() => f.store.deleteMeeting(f.removed.id), /Cannot delete.*referenc/i);
    assert.deepEqual(dbRows(f.store), before); assert.equal(await readFile(join(f.directory, path), 'utf8'), 'keep reference');
  } finally { await f.close(); }
});

test('an outside material alias into a planned workspace refuses deletion', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'meeting-delete-root-alias-'));
  try {
    const target = `plans/${f.removed.id}/evidence.txt`; await put(f.directory, target);
    const alias = join(outside, 'material.txt'); await symlink(join(f.directory, target), alias);
    const projects = new Projects(f.store, f.directory), project = await projects.create('Root alias');
    const root = await projects.addRoot(`project:${project.id}`, alias);
    f.store.db.prepare('UPDATE material_roots SET path=? WHERE id=?').run(alias, root.id);
    assert.throws(() => f.store.deleteMeeting(f.removed.id), /material_roots.*references planned path/);
    assert.equal(await readFile(alias, 'utf8'), 'data');
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test('pending retry rechecks jobs and discovers newly written board/notes temporaries', async () => {
  const f = await fixture();
  try {
    await put(f.directory, `audio/${f.removed.id}/audio.f32`); crash(f.store, f.removed.id);
    await put(f.directory, `notes/${f.removed.id}.job.json`, '{"state":"running"}');
    const tmp = [`notes/${f.removed.id}.json.${randomUUID()}.tmp`, `board/${f.removed.id}.json.${randomUUID()}.tmp`];
    for (const path of tmp) await put(f.directory, path);
    assert.throws(() => f.store.deleteMeeting(f.removed.id), /agent work is running/);
    assert.equal(fs.existsSync(join(f.directory, 'audio', f.removed.id)), true);
    await rm(join(f.directory, 'notes', `${f.removed.id}.job.json`));
    f.store.deleteMeeting(f.removed.id);
    for (const path of tmp) assert.equal(fs.existsSync(join(f.directory, path)), false, path);
  } finally { await f.close(); }
});

test('CLI finishes unrelated pending cleanup in dry runs, but --keep requires a live meeting', async () => {
  const f = await fixture();
  try {
    await put(f.directory, `audio/${f.removed.id}/audio.f32`); crash(f.store, f.removed.id);
    const result = await cli(f.directory, ['--keep', f.kept.id]);
    assert.equal(result.code, 0, result.text); assert.match(result.text, /finish.*pending|pending.*finish/i);
    assert.equal(fs.existsSync(join(f.directory, 'audio', f.removed.id)), false);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []);
    const invalid = await cli(f.directory, ['--keep', f.removed.id]);
    assert.notEqual(invalid.code, 0); assert.match(invalid.text, /live meeting|Unknown meeting/);
  } finally { await f.close(); }
});

test('--keep cannot protect a pending deletion because its meeting is not live', async () => {
  const f = await fixture();
  try {
    await put(f.directory, `audio/${f.removed.id}/data.f32`); crash(f.store, f.removed.id);
    const result = await cli(f.directory, ['--keep', f.removed.id]);
    assert.notEqual(result.code, 0); assert.match(result.text, /--keep requires a live meeting/);
    assert.match(result.text, /Finishing pending deletion/); assert.equal(fs.existsSync(join(f.directory, 'audio', f.removed.id)), false);
    assert.equal(f.store.meeting(f.kept.id).id, f.kept.id);
  } finally { await f.close(); }
});

test('pending cleanup refuses newly surviving path references before any file removal', async () => {
  const f = await fixture();
  try {
    const path = `audio/${f.removed.id}/shared.media`; await put(f.directory, path); crash(f.store, f.removed.id);
    media(f.store, f.kept.id, join(f.directory, path));
    assert.throws(() => f.store.deleteMeeting(f.removed.id), /surviving chunks.*references planned path/);
    assert.equal(await readFile(join(f.directory, path), 'utf8'), 'data');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM meeting_deletions').get()!.n, 1);
  } finally { await f.close(); }
});

test('pending retries durably retain newly discovered scratch ownership across another crash', async () => {
  const f = await fixture();
  try {
    crash(f.store, f.removed.id);
    const job = randomUUID(), record = `actions/${f.removed.id}/${job}.json`, work = `scratch/actions/${job}/output.txt`;
    await put(f.directory, record, JSON.stringify({ id: job, meetingId: f.removed.id, state: 'done' })); await put(f.directory, work);
    crash(f.store, f.removed.id);
    await rm(join(f.directory, 'actions', f.removed.id), { recursive: true });
    f.store.deleteMeeting(f.removed.id);
    assert.equal(fs.existsSync(join(f.directory, work)), false);
  } finally { await f.close(); }
});

test('server finishes pending cleanup before starting recognition jobs', async () => {
  const f = await fixture(); let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await put(f.directory, `audio/${f.removed.id}/audio.f32`); crash(f.store, f.removed.id);
    await put(f.directory, `imports/${randomUUID()}.media`);
    f.store.addMedia(f.kept.id, '/outside/fixture.media', 1);
    let checked = false;
    app = await startServer({ directory: f.directory, port: 0, quick: null, heavy: null, drafts: null, recognizer: {
      async transcribe() {
        assert.equal(fs.existsSync(join(f.directory, 'audio', f.removed.id)), false);
        assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []); checked = true; return recognized;
      }, close() {},
    } });
    await app.jobs!.wait(); assert.equal(checked, true);
  } finally { await app?.close(); await f.close(); }
});

test('unreferenced imports are listed with sizes and never removed, including after retention cleared paths', async () => {
  const f = await fixture();
  try {
    const orphan = `imports/${randomUUID()}.media`; await put(f.directory, orphan, '1234567');
    media(f.store, f.removed.id, join(f.directory, orphan)); f.store.db.prepare("UPDATE chunks SET path='' WHERE meetingId=?").run(f.removed.id);
    const dry = await cli(f.directory, [f.removed.id]);
    assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /unreferenced imports \(not deleted\)/i);
    assert.ok(dry.text.includes(orphan)); assert.match(dry.text, /7 bytes/);
    const yes = await cli(f.directory, ['--yes', f.removed.id]); assert.equal(yes.code, 0, yes.text);
    assert.equal(await readFile(join(f.directory, orphan), 'utf8'), '1234567');
  } finally { await f.close(); }
});

test('batch evidence counts exclude all deleted meetings and already absent meeting folders', async () => {
  const f = await fixture();
  try {
    const third = f.store.createMeeting('Delete too');
    const name = `${new Date(f.removed.createdAt).toISOString().slice(0, 10)}-${f.removed.id.slice(0, 8)}.md`;
    for (const id of [f.kept.id, third.id, randomUUID()]) await put(f.directory, `scratch/memory-snapshots/${id}/snapshot/past-notes/${name}`);
    const result = await cli(f.directory, [f.removed.id, third.id]);
    assert.equal(result.code, 0, result.text);
    const section = result.text.split(`${f.removed.id} — `)[1].split(`${third.id} — `)[0];
    assert.match(section, /other meetings: 1 /);
  } finally { await f.close(); }
});

test('option values starting with any dash are rejected', () => {
  for (const flag of ['--data', '--keep']) for (const value of ['-x', '-']) assert.throws(() => parseDeleteArguments([flag, value]), /requires a value|Invalid value/);
});

test('outside unresolvable recording paths are not realpathed during import reference checks', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'meeting-delete-external-'));
  try {
    const loop = join(outside, 'loop.media'); await symlink(loop, loop);
    const own = `imports/${randomUUID()}.media`; await put(f.directory, own);
    media(f.store, f.removed.id, join(f.directory, own)); media(f.store, f.kept.id, loop);
    f.store.deleteMeeting(f.removed.id);
    assert.equal(fs.existsSync(join(f.directory, own)), false);
    assert.equal((await readdir(outside)).includes('loop.media'), true);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test('outside EACCES recording references are never probed by importUsed', async () => {
  const f = await fixture(), realpath = fs.realpathSync;
  try {
    const external = join(f.directory, '..', 'inaccessible-recording.media'), own = `imports/${randomUUID()}.media`;
    await put(f.directory, own); media(f.store, f.removed.id, join(f.directory, own)); media(f.store, f.kept.id, external);
    let probes = 0;
    fs.realpathSync = new Proxy(realpath, { apply(target, receiver, args) {
      if (String(args[0]) === external) { probes++; throw Object.assign(new Error('inaccessible'), { code: 'EACCES' }); }
      return Reflect.apply(target, receiver, args);
    } });
    syncBuiltinESMExports(); f.store.deleteMeeting(f.removed.id);
    assert.equal(probes, 0); assert.equal(fs.existsSync(join(f.directory, own)), false);
  } finally { fs.realpathSync = realpath; syncBuiltinESMExports(); await f.close(); }
});

test('a directory fsync failure leaves the manifest available for a safe retry', async () => {
  const f = await fixture(), sync = fs.fsyncSync;
  try {
    await put(f.directory, `audio/${f.removed.id}/audio.f32`);
    fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' }); sync(fd); };
    syncBuiltinESMExports();
    assert.throws(() => f.store.deleteMeeting(f.removed.id), /directory fsync failed/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM meeting_deletions').get()!.n, 1);
    fs.fsyncSync = sync; syncBuiltinESMExports(); f.store.deleteMeeting(f.removed.id);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []);
  } finally { fs.fsyncSync = sync; syncBuiltinESMExports(); await f.close(); }
});

test('replacement file and removal parents are fsynced while the cleanup manifest still exists', async () => {
  const f = await fixture();
  const sync = fs.fsyncSync, rename = fs.renameSync;
  try {
    await put(f.directory, `audio/${f.removed.id}/audio.f32`);
    await put(f.directory, 'materials.json.migrated', JSON.stringify([{ meetingId: f.removed.id }, { meetingId: f.kept.id }]));
    const events: string[] = [];
    fs.fsyncSync = fd => {
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM meeting_deletions').get()!.n, 1);
      events.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync'); sync(fd);
    };
    fs.renameSync = (from, to) => { assert.ok(events.includes('file-sync'), 'replacement bytes synced before rename'); events.push('rename'); rename(from, to); };
    syncBuiltinESMExports();
    f.store.deleteMeeting(f.removed.id);
    assert.ok(events.indexOf('file-sync') < events.indexOf('rename'));
    assert.ok(events.lastIndexOf('directory-sync') > events.indexOf('rename'));
    assert.deepEqual(f.store.db.prepare('SELECT * FROM meeting_deletions').all(), []);
  } finally { fs.fsyncSync = sync; fs.renameSync = rename; syncBuiltinESMExports(); await f.close(); }
});
