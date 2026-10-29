import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, symlink, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MeetingStore, type Chunk } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';
import { LiveCapture } from '../src/live.ts';
import type { LiveDrafts } from '../src/drafts.ts';
import { decodeChunk, readRecordingChunk } from '../src/audio.ts';
import { AudioRetention, AUDIO_RETENTION } from '../src/audio-retention.ts';
import type { Recognition } from '../src/recognizer.ts';

const result: Recognition = { text: 'Relocated recording.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
const pcm = (value = 0.25) => Buffer.from(new Float32Array(16000).fill(value).buffer);
// A self-contained PCM WAV: imports exercise the real media decoder without models or user audio.
function wav(seconds = 1) {
  const samples = 16000 * seconds, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(8192, 44 + i * 2);
  return bytes;
}
function paths(store: MeetingStore) {
  return Object.fromEntries(['frames', 'chunks'].map(table => [table, store.db.prepare(`SELECT id,path FROM ${table} ORDER BY id`).all()]));
}
/** Seed the exact old representation, even when this test runs with the new store. */
function makeLegacy(store: MeetingStore, directory = store.directory) {
  for (const table of ['frames', 'chunks']) {
    for (const row of store.db.prepare(`SELECT id,path FROM ${table}`).all() as { id: string; path: string }[]) {
      if (row.path && !isAbsolute(row.path)) store.db.prepare(`UPDATE ${table} SET path=? WHERE id=?`).run(join(directory, row.path), row.id);
    }
  }
  store.db.exec('PRAGMA user_version=2');
}
async function decode(store: MeetingStore, chunk: Chunk) {
  const samples = await (chunk.sampleRate ? readRecordingChunk : decodeChunk)(store.resolvePath(chunk.path), chunk.decodeStart, chunk.seconds);
  assert.equal(samples.length, Math.round(chunk.seconds * 16000));
  assert.ok(samples.every(sample => Math.abs(sample - 0.25) < 0.0001));
}

test('new recording rows are data-relative; outside imports remain absolute and empty paths resolve to empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-new-'));
  const directory = join(root, 'data with spaces');
  await mkdir(directory);
  const store = new MeetingStore(`${directory}/`);
  try {
    const m = store.createMeeting();
    const frame = (await store.addFrame(m.id, 'mic:frame', 0, 0, pcm())).frame;
    const direct = await store.addPcm(m.id, 'mic:pcm', 0, 0, 16000, pcm());
    const sealed = await store.sealWindow(m.id, [frame]);
    await mkdir(join(directory, 'imports'));
    const media = join(directory, 'imports', 'take.media');
    await writeFile(media, wav());
    store.addMedia(m.id, media, 1);
    const outside = `${root}//outside.wav`; // Preserve even the spelling of an external absolute path.
    await writeFile(outside, wav());
    const source = store.addMedia(m.id, outside, 1);
    assert.equal(isAbsolute(frame.path), false, 'frame rows must not contain the data folder');
    for (const c of [direct, sealed, ...store.chunks(m.id).filter(c => c.source !== source)]) {
      assert.equal(isAbsolute(c.path), false);
      assert.match(c.path, /^(audio|imports)\//);
      assert.equal(c.path.includes('\\'), false);
      await decode(store, c);
    }
    assert.equal(store.chunks(m.id).find(c => c.source === source)!.path, outside);
    assert.equal(store.resolvePath(outside), outside);
    assert.equal(store.resolvePath(''), '');
    assert.equal(store.resolvePath('imports/take.media'), media);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy paths repair idempotently, decode before and after rename, seal, replay and retain audio at the new location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-move-'));
  const old = join(root, 'data %_ with spaces 🎙'), moved = join(root, 'moved data');
  await mkdir(old);
  let store = new MeetingStore(`${old}/`);
  let retention: AudioRetention | undefined;
  try {
    const m = store.createMeeting('Owned audio');
    const direct = await store.addPcm(m.id, 'mic:pcm', 0, 0, 16000, pcm());
    const held = (await store.addFrame(m.id, 'mic:held', 0, 1000, pcm())).frame;
    const sealedFrame = (await store.addFrame(m.id, 'mic:sealed', 0, 2000, pcm())).frame;
    const window = await store.sealWindow(m.id, [sealedFrame]);
    // Simulate a crash between a committed seal and cleanup.
    const frameFile = isAbsolute(sealedFrame.path) ? sealedFrame.path : join(old, sealedFrame.path);
    await writeFile(frameFile, pcm());
    const imported = store.createMeeting('Imported replay');
    await mkdir(join(old, 'imports'));
    const media = join(old, 'imports', 'take.media');
    await writeFile(media, wav(21));
    const importedSource = store.addMedia(imported.id, media, 21);
    // Prefix lookalike is outside, even with SQL wildcard characters in the data directory.
    const outsideFolder = `${old}-outside`;
    await mkdir(outsideFolder);
    const outside = join(outsideFolder, 'external.wav');
    await writeFile(outside, wav());
    const externalMeeting = store.createMeeting('External audio');
    store.addMedia(externalMeeting.id, outside, 1);
    const externalFrame = (await store.addFrame(externalMeeting.id, 'mic:external', 0, 0, pcm())).frame;
    const outsideFrame = join(outsideFolder, 'external.f32');
    await writeFile(outsideFrame, pcm());
    store.db.prepare('UPDATE frames SET path=? WHERE id=?').run(outsideFrame, externalFrame.id);
    const removed = store.createMeeting('Already removed');
    const removedChunk = await store.addPcm(removed.id, 'mic:removed', 0, 0, 16000, pcm());
    const removedFrame = (await store.addFrame(removed.id, 'mic:removed-frame', 0, 0, pcm())).frame;
    store.db.prepare("UPDATE chunks SET path='' WHERE id=?").run(removedChunk.id);
    store.db.prepare("UPDATE frames SET path='' WHERE id=?").run(removedFrame.id);
    store.db.prepare('UPDATE meetings SET audioRemovedAt=1 WHERE id=?').run(removed.id);
    // Historical provenance is explicitly outside this migration.
    const provenance = join(old, 'historical.json');
    const savedProvenance = JSON.stringify({ abs: frameFile, worker: { dir: join(old, 'processes', 'old') } });
    await writeFile(provenance, savedProvenance);
    makeLegacy(store);
    store.close();
    store = new MeetingStore(`${old}/`);
    assert.equal(store.chunk(direct.id)!.path, relative(old, join(old, 'audio', m.id, `${direct.id}.f32`)).split(sep).join('/'), 'old absolute PCM path migrates');
    assert.equal(store.heldFrames(m.id).find(f => f.id === held.id)!.path.startsWith('audio/'), true);
    assert.equal(store.chunks(imported.id)[0].path, 'imports/take.media');
    assert.equal(store.chunks(externalMeeting.id)[0].path, outside);
    assert.equal(store.heldFrames(externalMeeting.id)[0].path, outsideFrame);
    for (const id of [m.id, imported.id, externalMeeting.id]) for (const chunk of store.chunks(id)) await decode(store, chunk);
    assert.deepEqual(await readFile(store.resolvePath(store.heldFrames(m.id)[0].path)), pcm());
    const migrated = paths(store);
    store.close();
    store = new MeetingStore(old);
    assert.deepEqual(paths(store), migrated, 'second migration is a no-op');
    store.close();
    await rename(old, moved);
    store = new MeetingStore(`${moved}/`);
    assert.deepEqual(paths(store), migrated, 'moving never rewrites relative or external paths');
    assert.equal(await readFile(join(moved, 'historical.json'), 'utf8'), savedProvenance);
    assert.equal(store.chunk(removedChunk.id)!.path, '');
    assert.equal(store.heldFrames(removed.id)[0].path, '');
    assert.equal(store.meeting(removed.id).audioRemovedAt, 1);
    await assert.rejects(store.sealWindow(removed.id, store.heldFrames(removed.id)), /Audio removed/);
    assert.equal(store.resolvePath(outside), outside);
    assert.deepEqual(await readFile(store.resolvePath(outsideFrame)), pcm());
    for (const id of [m.id, imported.id, externalMeeting.id]) for (const chunk of store.chunks(id)) await decode(store, chunk);
    await store.removeSealedFrameFiles();
    await assert.rejects(access(join(moved, relative(old, frameFile))), /ENOENT/);
    await access(store.resolvePath(window.path));
    const newlySealed = await store.sealWindow(m.id, store.heldFrames(m.id));
    assert.ok(newlySealed.path.startsWith('audio/'));
    await decode(store, newlySealed);
    store.startReplay(imported.id, importedSource, 2, 1);
    const seen: string[] = [];
    const manager = new JobManager(store, {
      async transcribe(chunk) {
        // This is the same boundary LocalRecognizer forwards to stt-worker.
        assert.ok(isAbsolute(chunk.path), 'recognizer receives resolved paths');
        await decode(store, chunk); seen.push(chunk.id); return result;
      }, close() {},
    });
    try { manager.kick(); await manager.wait(); } finally { await manager.close(); }
    for (const id of [m.id, imported.id, externalMeeting.id]) assert.ok(store.chunks(id).every(c => c.status === 'completed'));
    assert.equal(seen.length, 6);
    assert.match(store.markdown(m.id), /Relocated recording/);
    assert.ok(store.visibleSegments(imported.id, 20_000).length > 0);
    const now = Date.now() + 3 * AUDIO_RETENTION.day;
    store.recordingEnded(m.id, now - 2 * AUDIO_RETENTION.day);
    store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(now - 2 * AUDIO_RETENTION.day, m.id);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now, log: message => assert.fail(message) });
    await retention.run();
    assert.equal(store.meeting(m.id).audioRemovedAt, now);
    assert.ok(store.chunks(m.id).every(c => c.path === ''));
    assert.ok((store.db.prepare('SELECT path FROM frames WHERE meetingId=?').all(m.id) as { path: string }[]).every(f => f.path === ''));
    await assert.rejects(access(join(moved, 'audio', m.id)), /ENOENT/);
    assert.equal(store.chunks(imported.id)[0].path, 'imports/take.media', 'imports are never owned by retention');
    assert.deepEqual(await readFile(join(moved, 'imports', 'take.media')), wav(21));
    assert.deepEqual(await readFile(outside), wav());
    retention.close(); store.close(); store = new MeetingStore(moved);
    assert.ok(store.chunks(m.id).every(c => c.path === ''));
    assert.equal(store.chunk(removedChunk.id)!.path, '');
  } finally { retention?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a symlinked data directory migrates both its spelling and realpath with spaces and a trailing slash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-alias-'));
  const actual = join(root, 'actual data'), alias = join(root, 'data alias');
  await mkdir(actual); await symlink(actual, alias, 'dir');
  let store = new MeetingStore(`${alias}/`);
  try {
    const m = store.createMeeting();
    const chunk = await store.addPcm(m.id, 'mic:alias', 0, 0, 16000, pcm());
    const frame = (await store.addFrame(m.id, 'mic:actual', 0, 1000, pcm())).frame;
    makeLegacy(store, alias);
    const frameName = isAbsolute(frame.path) ? relative(alias, frame.path) : frame.path;
    store.db.prepare('UPDATE frames SET path=? WHERE id=?').run(join(await realpath(actual), frameName), frame.id);
    store.close(); store = new MeetingStore(`${alias}/`);
    assert.ok(!isAbsolute(store.chunk(chunk.id)!.path), 'symlink spelling is migrated');
    assert.ok(!isAbsolute(store.heldFrames(m.id)[0].path), 'canonical spelling is migrated');
    await decode(store, store.chunk(chunk.id)!);
    store.close(); await rename(actual, join(root, 'moved'));
    store = new MeetingStore(join(root, 'moved'));
    await decode(store, store.chunk(chunk.id)!);
    await decode(store, await store.sealWindow(m.id, store.heldFrames(m.id)));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('repair rolls back both columns on failure even at version 3 and skips already repaired rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relpaths-atomic-'));
  let store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    await store.addPcm(m.id, 'mic:pcm', 0, 0, 16000, pcm());
    await store.addFrame(m.id, 'mic:frame', 0, 1000, pcm());
    makeLegacy(store);
    store.db.exec('PRAGMA user_version=3');
    const before = paths(store);
    store.db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE OF path ON chunks BEGIN SELECT RAISE(ABORT, 'injected path migration failure'); END");
    store.close();
    // A separate process owns the intentionally failed constructor's connection until it exits.
    execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { MeetingStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      assert.throws(() => new MeetingStore(${JSON.stringify(directory)}), /injected path migration failure/);
    `], { stdio: 'pipe' });
    const db = new DatabaseSync(join(directory, 'meetings.sqlite'));
    try {
      for (const table of ['frames', 'chunks']) assert.deepEqual(db.prepare(`SELECT id,path FROM ${table} ORDER BY id`).all(), before[table]);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
      db.exec('DROP TRIGGER fail_migration');
    } finally { db.close(); }
    store = new MeetingStore(directory);
    assert.ok(store.chunks(m.id).every(c => !isAbsolute(c.path)));
    assert.ok(store.heldFrames(m.id).every(f => !isAbsolute(f.path)));
    for (const table of ['frames', 'chunks']) store.db.exec(`CREATE TRIGGER no_repeat_${table} BEFORE UPDATE OF path ON ${table} BEGIN SELECT RAISE(ABORT, 'path migration ran twice'); END`);
    const after = paths(store);
    store.close(); store = new MeetingStore(directory);
    assert.deepEqual(paths(store), after);
  } finally { try { store.close(); } catch { /* failed constructor left the prior store closed */ } await rm(directory, { recursive: true, force: true }); }
});

test('moved-before-repair recordings recover from old symlink and canonical spellings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-before-repair-'));
  const old = join(root, 'old data'), alias = join(root, 'old alias'), moved = join(root, 'moved data');
  await mkdir(old); await symlink(old, alias, 'dir');
  let store = new MeetingStore(alias);
  try {
    const m = store.createMeeting();
    const chunk = await store.addPcm(m.id, 'mic:pcm', 0, 0, 16000, pcm());
    const frame = (await store.addFrame(m.id, 'mic:frame', 0, 1000, pcm())).frame;
    await mkdir(join(old, 'imports')); await writeFile(join(old, 'imports', 'take.media'), wav());
    const imported = store.addMedia(m.id, join(alias, 'imports', 'take.media'), 1);
    const canonicalChunk = join(await realpath(old), chunk.path);
    makeLegacy(store, alias);
    store.db.prepare('UPDATE chunks SET path=? WHERE id=?').run(canonicalChunk, chunk.id);
    store.close();
    // No repaired store has opened yet, and neither old spelling survives the move.
    await rename(old, moved); await rm(alias);
    store = new MeetingStore(`${moved}/`);
    assert.equal(store.chunk(chunk.id)!.path, chunk.path);
    assert.equal(store.heldFrames(m.id)[0].path, frame.path);
    assert.equal(store.chunks(m.id).find(c => c.source === imported)!.path, 'imports/take.media');
    for (const c of store.chunks(m.id)) await decode(store, c);
    await decode(store, await store.sealWindow(m.id, store.heldFrames(m.id)));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('older-build absolute rows are repaired on later opens despite version 3, with exact tail and existence checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-later-repair-'));
  const directory = join(root, 'current data'), stale = join(root, 'old data'); await mkdir(directory);
  let store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    const chunk = await store.addPcm(m.id, 'mic:pcm', 0, 0, 16000, pcm());
    const frame = (await store.addFrame(m.id, 'mic:frame', 0, 1000, pcm())).frame;
    await mkdir(join(directory, 'imports')); await writeFile(join(directory, 'imports', 'take.media'), wav());
    const imported = store.addMedia(m.id, join(directory, 'imports', 'take.media'), 1);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    store.db.prepare('UPDATE chunks SET path=? WHERE id=?').run(join(stale, chunk.path), chunk.id);
    store.db.prepare('UPDATE chunks SET path=? WHERE source=?').run(join(stale, 'imports', 'take.media'), imported);
    store.db.prepare('UPDATE frames SET path=? WHERE id=?').run(join(directory, frame.path), frame.id);
    // These are not recoverable: missing file, wrong meeting, nested import, or a directory instead of a file.
    await mkdir(join(directory, 'imports', 'not-a-file'));
    const keep = [join(stale, 'imports', 'missing.media'), join(stale, 'audio', 'wrong-meeting', chunk.path.split('/').at(-1)!),
      join(stale, 'imports', 'nested', 'take.media'), join(stale, 'imports', 'not-a-file')];
    const sources = keep.map(path => store.addMedia(m.id, path, 1));
    store.close(); store = new MeetingStore(directory);
    assert.equal(store.chunk(chunk.id)!.path, chunk.path);
    assert.equal(store.heldFrames(m.id)[0].path, frame.path);
    assert.equal(store.chunks(m.id).find(c => c.source === imported)!.path, 'imports/take.media');
    sources.forEach((source, i) => assert.equal(store.chunks(m.id).find(c => c.source === source)!.path, keep[i]));
    await decode(store, store.chunk(chunk.id)!);
    await decode(store, store.chunks(m.id).find(c => c.source === imported)!);
    for (const table of ['frames', 'chunks']) store.db.exec(`CREATE TRIGGER unchanged_${table} BEFORE UPDATE OF path ON ${table} BEGIN SELECT RAISE(ABORT, 'unchanged row was written'); END`);
    const before = paths(store);
    store.close(); store = new MeetingStore(directory);
    assert.deepEqual(paths(store), before, 'repair does not update relative or unrecoverable absolute paths');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('new writes and repairs normalize double separators and dot segments without making outside paths relative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-normalize-'));
  const directory = join(root, 'data'); await mkdir(directory);
  let store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    await mkdir(join(directory, 'imports')); await writeFile(join(directory, 'imports', 'take.media'), wav());
    const outside = `${directory}/../external.wav`; await writeFile(outside, wav());
    const insidePaths = [`${directory}//imports/take.media`, `/${directory}//imports/../imports//take.media`];
    const sources = insidePaths.map(path => store.addMedia(m.id, path, 1));
    const externalSource = store.addMedia(m.id, outside, 1);
    sources.forEach(source => assert.equal(store.chunks(m.id).find(c => c.source === source)!.path, 'imports/take.media'));
    assert.equal(store.chunks(m.id).find(c => c.source === externalSource)!.path, outside, 'outside spelling is preserved exactly');
    // Reproduce older rows independently of storedPath's new-write behavior.
    sources.forEach((source, i) => store.db.prepare('UPDATE chunks SET path=? WHERE source=?').run(insidePaths[i], source));
    store.db.prepare('UPDATE chunks SET path=? WHERE source=?').run(outside, externalSource);
    const frame = (await store.addFrame(m.id, 'mic:frame', 0, 0, pcm())).frame;
    store.db.prepare('UPDATE frames SET path=? WHERE id=?').run(`/${directory}//${frame.path}`, frame.id);
    store.close(); store = new MeetingStore(directory);
    sources.forEach(source => assert.equal(store.chunks(m.id).find(c => c.source === source)!.path, 'imports/take.media'));
    assert.equal(store.chunks(m.id).find(c => c.source === externalSource)!.path, outside);
    assert.equal(store.heldFrames(m.id)[0].path, frame.path);
    for (const c of store.chunks(m.id)) {
      if (c.path !== outside) { assert.equal(isAbsolute(c.path), false); assert.equal(c.path.split('/').includes('..'), false); }
      await decode(store, c);
    }
    await decode(store, await store.sealWindow(m.id, store.heldFrames(m.id)));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a crash after repairing frames but before chunks rolls back the whole repair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relpaths-crash-'));
  let store = new MeetingStore(directory);
  try {
    const m = store.createMeeting();
    await store.addFrame(m.id, 'mic:frame', 0, 0, pcm());
    await store.addPcm(m.id, 'mic:pcm', 0, 1000, 16000, pcm());
    makeLegacy(store); store.db.exec('PRAGMA user_version=3');
    const before = paths(store); store.close();
    assert.throws(() => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { MeetingStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (/UPDATE frames SET path/.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = (...args) => { run(...args); process.kill(process.pid, 'SIGKILL'); };
        }
        return statement;
      };
      new MeetingStore(${JSON.stringify(directory)}).close();
    `], { stdio: 'pipe' }), (error: unknown) => (error as { signal?: string }).signal === 'SIGKILL');
    const db = new DatabaseSync(join(directory, 'meetings.sqlite'));
    try { for (const table of ['frames', 'chunks']) assert.deepEqual(db.prepare(`SELECT id,path FROM ${table} ORDER BY id`).all(), before[table]); }
    finally { db.close(); }
    store = new MeetingStore(directory);
    assert.ok(store.chunks(m.id).every(c => !isAbsolute(c.path)));
    assert.ok(store.heldFrames(m.id).every(f => !isAbsolute(f.path)));
  } finally { try { store.close(); } catch { /* closed before the crash */ } await rm(directory, { recursive: true, force: true }); }
});

test('read-only room comparison reports audio levels before and after moving the folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-room-'));
  const old = join(root, 'old'), moved = join(root, 'moved'); await mkdir(old);
  const store = new MeetingStore(old);
  try {
    const m = store.createMeeting();
    const chunk = await store.addPcm(m.id, 'mic:room', 0, 0, 16000, pcm());
    store.completeChunk(chunk.id, result);
    const script = fileURLToPath(new URL('../scripts/room-compare.ts', import.meta.url));
    const compare = (directory: string) => JSON.parse(execFileSync(process.execPath,
      ['--experimental-strip-types', script, m.id, directory], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const before = compare(old);
    assert.equal(before.audio, 'Available');
    assert.equal(before.takes[0].levelDbfs.median, -12);
    assert.deepEqual(before.takes[0].unavailableAudio, []);
    store.close(); await rename(old, moved);
    assert.deepEqual(compare(moved), before);
  } finally { try { store.close(); } catch { /* already closed before move */ } await rm(root, { recursive: true, force: true }); }
});

test('moved live frames support quiet-boundary selection and replay into the next draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relpaths-live-'));
  const old = join(root, 'old'), moved = join(root, 'moved'); await mkdir(old);
  let store = new MeetingStore(old);
  let capture: LiveCapture | undefined;
  try {
    const m = store.createMeeting(), source = 'mic:live';
    for (let i = 0; i < 23; i++) await store.addFrame(m.id, source, i, i * 1000, pcm(i === 20 ? 0 : 0.25));
    makeLegacy(store); store.close(); store = new MeetingStore(old); store.close(); await rename(old, moved); store = new MeetingStore(moved);
    const fed: number[] = [];
    const drafts = { begin() { return true; }, feed(_window: string, samples: Float32Array) { fed.push(samples.length); }, seal() {}, drop() { assert.fail('moved draft frames must be readable'); }, release() {} };
    capture = new LiveCapture(store, { drafts: drafts as unknown as LiveDrafts });
    await capture.accept(m.id, source, 23, 23_000, pcm());
    assert.equal(store.chunks(m.id)[0].seconds, 21);
    assert.equal(store.heldFrames(m.id).length, 3);
    assert.equal(fed.length, 4, 'new frame plus all three frames replayed to the next draft');
    await capture.end(m.id, source, 23);
    assert.deepEqual(store.chunks(m.id).map(c => c.seconds), [21, 3]);
    const all = Buffer.concat(await Promise.all(store.chunks(m.id).map(c => readFile(store.resolvePath(c.path)))));
    assert.deepEqual(all, Buffer.concat(Array.from({ length: 24 }, (_, i) => pcm(i === 20 ? 0 : 0.25))));
  } finally { await capture?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
