import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { MeetingStore } from '../src/store.ts';
import { AudioRetention, AUDIO_RETENTION } from '../src/audio-retention.ts';
import { deleteMeeting, finishPendingMeetingDeletions } from '../src/delete-meeting.ts';
import { startServer } from '../src/server.ts';

const pcm = (level: number) => Buffer.from(new Float32Array(16000).fill(level).buffer);
const raw = pcm(0.4), cleaned = pcm(0.2);
const result = { text: 'Fictional garden.', backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'original-audio-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional garden');
  const { frame } = await store.addFrame(meeting.id, 'mic:fictional', 0, 0, raw);
  return { directory, store, meeting, frame, folder: join(directory, 'audio', meeting.id),
    async close() { this.store.close(); await fs.rm(this.directory, { recursive: true, force: true }); } };
}
async function seal(f: Awaited<ReturnType<typeof fixture>>) {
  const chunk = await f.store.sealWindow(f.meeting.id, [f.frame], cleaned);
  f.store.completeChunk(chunk.id, result);
  return { chunk, original: f.store.originalAudio(chunk.id)! };
}

test('a cleaned window publishes a hashed original beside it; listings/integrity include both, recognition/playback do not', async () => {
  const f = await fixture();
  try {
    const { chunk, original } = await seal(f);
    assert.equal(original.path, chunk.path.replace(/\.f32$/, '.raw.f32'));
    assert.equal(original.hash, hash(raw));
    assert.equal(chunk.hash, hash(cleaned));
    assert.deepEqual(await fs.readFile(f.store.resolvePath(original.path)), raw);
    assert.deepEqual(await fs.readFile(f.store.resolvePath(chunk.path)), cleaned);
    assert.equal((await fs.stat(f.store.resolvePath(original.path))).mode & 0o777, 0o600);
    assert.deepEqual(f.store.audioFiles(f.meeting.id).map(file => file.kind).sort(), ['chunk', 'raw']);
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
    assert.equal(f.store.chunks(f.meeting.id).length, 1);
    assert.equal(f.store.nextChunk(), undefined);
    await fs.writeFile(f.store.resolvePath(original.path), pcm(0.1));
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), [{ path: original.path, problem: 'hash mismatch' }]);
    await fs.rm(f.store.resolvePath(original.path));
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), [{ path: original.path, problem: 'missing' }]);
  } finally { await f.close(); }
});

for (const mode of ['unprocessed', 'pass-through'] as const) test(`${mode} windows do not get an original sidecar`, async () => {
  const f = await fixture();
  try {
    const chunk = await f.store.sealWindow(f.meeting.id, [f.frame], mode === 'pass-through' ? Buffer.from(raw) : undefined);
    assert.equal(f.store.originalAudio(chunk.id), undefined);
    assert.equal((await fs.readdir(f.folder)).length, 1);
  } finally { await f.close(); }
});

for (const file of ['primary', 'raw'] as const) for (const stage of ['open', 'write', 'sync'] as const) test(`failed ${file} ${stage} leaves only recoverable held frames`, async () => {
  const f = await fixture(), originalOpen = fs.open;
  try {
    fs.open = (async (...args: Parameters<typeof originalOpen>) => {
      const path = String(args[0]), target = args[1] === 'wx' && path.endsWith('.f32') && path.endsWith('.raw.f32') === (file === 'raw');
      if (target && stage === 'open') throw new Error('Fictional disk failure');
      const handle = await originalOpen(...args);
      if (target && stage === 'write') handle.writeFile = async () => { await handle.write(Buffer.alloc(4)); throw new Error('Fictional disk failure'); };
      if (target && stage === 'sync') handle.sync = async () => { throw new Error('Fictional disk failure'); };
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();
    await assert.rejects(() => f.store.sealWindow(f.meeting.id, [f.frame], cleaned), /Fictional disk failure/);
    fs.open = originalOpen; syncBuiltinESMExports();
    assert.deepEqual(await fs.readdir(f.folder), [basename(f.frame.path)]);
    assert.equal(f.store.chunks(f.meeting.id).length, 0);
    assert.equal(f.store.heldFrames(f.meeting.id).length, 1);
    await seal(f);
    assert.equal((await fs.readdir(f.folder)).length, 2);
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); await f.close(); }
});

for (const table of ['chunks', 'chunk_originals', 'frames']) test(`${table} publication failure rolls back the entire two-file seal`, async () => {
  const f = await fixture();
  try {
    f.store.db.exec(`CREATE TEMP TRIGGER fail_seal BEFORE ${table === 'frames' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'Fictional publication failure'); END`);
    await assert.rejects(() => f.store.sealWindow(f.meeting.id, [f.frame], cleaned), /Fictional publication failure/);
    assert.deepEqual(await fs.readdir(f.folder), [basename(f.frame.path)]);
    assert.equal(f.store.chunks(f.meeting.id).length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chunk_originals').get()!.n, 0);
    assert.equal(f.store.heldFrames(f.meeting.id).length, 1);
    f.store.db.exec('DROP TRIGGER fail_seal');
    await seal(f);
  } finally { await f.close(); }
});

for (const stage of ['primary-sync', 'raw-open', 'raw-sync', 'in-transaction', 'after-commit']) test(`process crash at ${stage}: restart reconciles an all-or-nothing seal`, async () => {
  const f = await fixture();
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('nice', ['-n', '19', 'env', '-u', 'GEMINI_API_KEY', '-u', 'OPENAI_API_KEY', '-u', 'ANTHROPIC_API_KEY', process.execPath,
        '--experimental-strip-types', 'test/fixtures/original-audio-crash.ts', f.directory, f.meeting.id, stage], { stdio: 'ignore' });
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(exit, 86);
    f.store.close(); f.store = new MeetingStore(f.directory);
    await f.store.removeOrphanAudioFiles();
    await f.store.removeSealedFrameFiles();
    if (stage === 'after-commit') {
      assert.equal(f.store.heldFrames(f.meeting.id).length, 0);
      assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
      const chunk = f.store.chunks(f.meeting.id)[0];
      assert.deepEqual(await fs.readFile(f.store.resolvePath(f.store.originalAudio(chunk.id)!.path)), raw);
      assert.equal((await fs.readdir(f.folder)).length, 2);
    } else {
      assert.equal(f.store.chunks(f.meeting.id).length, 0);
      assert.deepEqual(await fs.readdir(f.folder), [basename(f.frame.path)]);
      assert.deepEqual(await fs.readFile(f.store.resolvePath(f.frame.path)), raw);
      // Recovery has no ephemeral AEC result: reseal raw without inventing a sidecar.
      const chunk = await f.store.sealWindow(f.meeting.id, f.store.heldFrames(f.meeting.id));
      assert.equal(f.store.originalAudio(chunk.id), undefined);
      assert.deepEqual(await fs.readFile(f.store.resolvePath(chunk.path)), raw);
    }
  } finally { await f.close(); }
});

test('startup preserves committed originals, removes unpublished originals, and retains frames if an original is missing or damaged', async () => {
  const f = await fixture();
  try {
    const { original } = await seal(f), orphan = join(f.folder, `${randomUUID()}.raw.f32`);
    await fs.writeFile(orphan, raw);
    await f.store.removeOrphanAudioFiles();
    await assert.rejects(fs.access(orphan));
    await fs.access(f.store.resolvePath(original.path));
    await fs.writeFile(f.store.resolvePath(f.frame.path), raw); // crash residue
    await fs.rm(f.store.resolvePath(original.path));
    await f.store.removeSealedFrameFiles(); await fs.access(f.store.resolvePath(f.frame.path));
    await fs.writeFile(f.store.resolvePath(original.path), cleaned);
    await f.store.removeSealedFrameFiles(); await fs.access(f.store.resolvePath(f.frame.path));
    await fs.writeFile(f.store.resolvePath(original.path), raw);
    await f.store.removeSealedFrameFiles(); await assert.rejects(fs.access(f.store.resolvePath(f.frame.path)));
  } finally { await f.close(); }
});

for (const mode of ['direct', 'interrupted', 'CLI'] as const) test(`meeting deletion (${mode}) removes original metadata and every audio file`, async () => {
  const f = await fixture();
  try {
    await seal(f);
    assert.equal(f.store.inspectMeetingDeletion(f.meeting.id).fileBytes, raw.length + cleaned.length);
    if (mode === 'interrupted') {
      assert.throws(() => deleteMeeting(f.store, f.meeting.id, { afterCommit() { throw new Error('Fictional crash'); } }), /Fictional crash/);
      await fs.access(f.folder);
      f.store.close(); f.store = new MeetingStore(f.directory);
      finishPendingMeetingDeletions(f.store);
    } else if (mode === 'CLI') {
      const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('nice', ['-n', '19', 'env', '-u', 'GEMINI_API_KEY', '-u', 'OPENAI_API_KEY', '-u', 'ANTHROPIC_API_KEY', process.execPath,
          '--experimental-strip-types', 'scripts/delete-meetings.ts', '--data', f.directory, '--yes', f.meeting.id], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
        child.once('error', reject); child.once('exit', resolve);
      });
      assert.equal(exit, 0);
    } else f.store.deleteMeeting(f.meeting.id);
    await assert.rejects(fs.access(f.folder));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM chunk_originals').get()!.n, 0);
  } finally { await f.close(); }
});

for (const mode of ['expiry', 'legacy-remove', 'interrupted', 'new-generation'] as const) test(`audio removal (${mode}) clears original references and leaves no old audio`, async () => {
  const f = await fixture();
  const now = Date.now() + 10 * AUDIO_RETENTION.day;
  let retention: AudioRetention | undefined;
  try {
    const { original } = await seal(f);
    f.store.db.prepare('UPDATE meetings SET audioDoneAt=?,audioLegacy=? WHERE id=?').run(now - 2 * AUDIO_RETENTION.day, mode === 'legacy-remove' ? 1 : 0, f.meeting.id);
    retention = new AudioRetention(f.store, { clock: () => now, setting: () => 'day', active: () => false,
      ...(mode === 'interrupted' || mode === 'new-generation' ? { removeFiles: async () => { throw new Error('Fictional crash'); } } : {}) });
    await retention.run();
    if (mode === 'legacy-remove') {
      assert.deepEqual(retention.notice, { count: 1, bytes: raw.length + cleaned.length });
      retention.answer('remove'); await retention.run();
    }
    assert.equal(f.store.originalAudio(f.store.chunks(f.meeting.id)[0].id)!.path, '');
    assert.deepEqual(f.store.audioFiles(f.meeting.id), []);
    if (mode === 'interrupted' || mode === 'new-generation') {
      await fs.access(f.store.resolvePath(original.path));
      retention.close(); f.store.close(); f.store = new MeetingStore(f.directory);
      let newer: Awaited<ReturnType<MeetingStore['sealWindow']>> | undefined;
      if (mode === 'new-generation') {
        const { frame } = await f.store.addFrame(f.meeting.id, 'mic:new', 0, 1000, raw);
        newer = await f.store.sealWindow(f.meeting.id, [frame], cleaned);
        assert.match(newer.path, /\/g1-/);
      }
      retention = new AudioRetention(f.store, { clock: () => now, setting: () => 'always', active: () => false });
      await retention.run();
      await assert.rejects(fs.access(f.store.resolvePath(original.path)));
      if (newer) {
        assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
        assert.equal((await fs.readdir(f.folder)).length, 2);
        return;
      }
    }
    await assert.rejects(fs.access(f.folder));
  } finally { retention?.close(); await f.close(); }
});

test('legacy Keep and Always retain both files and count originals in the audio notice', async () => {
  const f = await fixture(), now = Date.now() + 10 * AUDIO_RETENTION.day;
  let retention: AudioRetention | undefined;
  try {
    await seal(f);
    f.store.db.prepare('UPDATE meetings SET audioDoneAt=?,audioLegacy=1 WHERE id=?').run(now - 2 * AUDIO_RETENTION.day, f.meeting.id);
    retention = new AudioRetention(f.store, { clock: () => now, setting: () => 'day', active: () => false });
    await retention.run(); retention.answer('keep'); await retention.run();
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
    assert.equal((await fs.readdir(f.folder)).length, 2);
    retention.close();
    f.store.db.prepare('UPDATE meetings SET audioKept=0,audioLegacy=0 WHERE id=?').run(f.meeting.id);
    retention = new AudioRetention(f.store, { clock: () => now, setting: () => 'always', active: () => false });
    await retention.run();
    assert.equal(f.store.audioFiles(f.meeting.id).length, 2);
  } finally { retention?.close(); await f.close(); }
});

test('surviving original references block deletion of another meeting audio directory', async () => {
  const f = await fixture();
  try {
    const { original } = await seal(f), kept = f.store.createMeeting('Keep fictional original');
    const chunk = await f.store.addPcm(kept.id, 'mic:kept', 0, 0, 16000, raw);
    f.store.db.prepare('INSERT INTO chunk_originals (id,meetingId,path,hash) VALUES (?,?,?,?)').run(chunk.id, kept.id, original.path, original.hash);
    assert.throws(() => f.store.deleteMeeting(f.meeting.id), /surviving chunk_originals.*references planned path/);
    assert.deepEqual(await fs.readFile(f.store.resolvePath(original.path)), raw);
  } finally { await f.close(); }
});

test('original paths survive relocation and old absolute-path repair', async () => {
  const f = await fixture(), moved = `${f.directory}-moved`;
  try {
    const { chunk, original } = await seal(f);
    f.store.db.prepare('UPDATE chunk_originals SET path=? WHERE id=?').run(f.store.resolvePath(original.path), chunk.id);
    f.store.close(); await fs.rename(f.directory, moved); f.directory = moved;
    f.store = new MeetingStore(moved);
    assert.equal(f.store.originalAudio(chunk.id)!.path, original.path);
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
  } finally { await f.close(); await fs.rm(moved, { recursive: true, force: true }); }
});

test('startup does not read originals with no leftover frames; hashes a leftover window only once', async () => {
  const f = await fixture(), readFile = fs.readFile;
  try {
    const { frame: second } = await f.store.addFrame(f.meeting.id, f.frame.source, 1, 1000, raw);
    const chunk = await f.store.sealWindow(f.meeting.id, [f.frame, second], Buffer.concat([cleaned, cleaned]));
    const original = f.store.originalAudio(chunk.id)!;
    const reads: string[] = [];
    fs.readFile = (async (...args: Parameters<typeof readFile>) => {
      reads.push(String(args[0])); return readFile(...args);
    }) as typeof readFile;
    syncBuiltinESMExports();
    await f.store.removeSealedFrameFiles();
    assert.deepEqual(reads, [], 'retained originals are not scanned at startup after normal frame cleanup');
    await fs.writeFile(f.store.resolvePath(f.frame.path), raw);
    await fs.writeFile(f.store.resolvePath(second.path), raw);
    await f.store.removeSealedFrameFiles();
    assert.deepEqual(reads, [f.store.resolvePath(original.path)], 'one hash for the window, not one per leftover frame');
    await assert.rejects(fs.access(f.store.resolvePath(second.path)));
    await assert.rejects(fs.access(f.store.resolvePath(f.frame.path)));
  } finally { fs.readFile = readFile; syncBuiltinESMExports(); await f.close(); }
});

test('opening after older-version audio removal clears stale original paths, preserving retained meetings', async () => {
  const f = await fixture();
  try {
    const { chunk, original } = await seal(f);
    const kept = f.store.createMeeting('Retained fictional lanterns');
    const { frame } = await f.store.addFrame(kept.id, 'mic:kept', 0, 0, raw);
    const other = await f.store.sealWindow(kept.id, [frame], cleaned);
    const keep = f.store.originalAudio(other.id);
    // Simulate the pre-sidecar binary: it clears only paths it knows, then erases all owned f32 files.
    f.store.db.prepare("UPDATE chunks SET path='' WHERE meetingId=?").run(f.meeting.id);
    f.store.db.prepare("UPDATE frames SET path='' WHERE meetingId=?").run(f.meeting.id);
    f.store.db.prepare('UPDATE meetings SET audioRemovedAt=1 WHERE id=?').run(f.meeting.id);
    await fs.rm(f.folder, { recursive: true });
    assert.equal(f.store.originalAudio(chunk.id)!.path, original.path);
    f.store.close(); f.store = new MeetingStore(f.directory);
    assert.equal(f.store.originalAudio(chunk.id)!.path, '');
    assert.deepEqual(f.store.audioFiles(f.meeting.id), []);
    assert.deepEqual(await f.store.verifyAudioFiles(f.meeting.id), []);
    assert.deepEqual(f.store.originalAudio(other.id), keep);
    assert.deepEqual(await f.store.verifyAudioFiles(kept.id), []);
  } finally { await f.close(); }
});

test('HTTP audio reads only cleaned chunks, even if the original sidecar is missing', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'original-http-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null });
  try {
    const meeting = app.store.createMeeting('Fictional garden');
    const { frame } = await app.store.addFrame(meeting.id, 'mic:fictional', 0, 0, raw);
    const chunk = await app.store.sealWindow(meeting.id, [frame], cleaned); app.store.completeChunk(chunk.id, result);
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    await fs.rm(app.store.resolvePath(app.store.originalAudio(chunk.id)!.path));
    const response = await fetch(`${app.url}/api/meetings/${meeting.id}/audio`, { headers: { Cookie: cookie, Origin: app.url, Range: 'bytes=44-45' } });
    assert.equal(response.status, 206);
    assert.equal(Buffer.from(await response.arrayBuffer()).readInt16LE(), Math.round(0.2 * 32767));
    app.store.setStatus(chunk.id, 'queued');
    assert.equal(app.store.nextChunk()!.path, chunk.path, 'recognition still reads the cleaned chunk only');
    app.store.completeChunk(chunk.id, result); app.store.deleteMeeting(meeting.id);
    await assert.rejects(fs.access(join(directory, 'audio', meeting.id)));
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
