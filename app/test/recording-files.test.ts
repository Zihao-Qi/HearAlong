import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeetingStore } from '../src/store.ts';

for (const operation of ['frame', 'window', 'pcm'] as const) for (const stage of ['write', 'sync', 'insert'] as const) {
  test(`${operation} cleans its new audio file after a failed ${stage}, and retry conserves the bytes`, async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'recording-files-'));
    const store = new MeetingStore(directory), meeting = store.createMeeting(), source = 'mic:fictional';
    const pcm = Buffer.from(new Float32Array(16000).fill(0.1).buffer);
    const dir = join(directory, 'audio', meeting.id);
    const originalOpen = fs.open;
    let injected = false;
    try {
      if (operation === 'window') await store.addFrame(meeting.id, source, 0, 0, pcm);
      const before = operation === 'window' ? (await fs.readdir(dir)).sort() : [];
      const table = operation === 'frame' ? 'frames' : 'chunks';
      if (stage === 'insert') store.db.exec(`CREATE TRIGGER fictional_disk_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'Fictional storage failure'); END`);
      else {
        fs.open = (async (...args: Parameters<typeof originalOpen>) => {
          const handle = await originalOpen(...args);
          if (!injected && String(args[0]).endsWith('.f32') && args[1] === 'wx') {
            injected = true;
            if (stage === 'write') handle.writeFile = async () => { await handle.write(Buffer.alloc(16)); throw Object.assign(new Error('Fictional storage failure'), { code: 'ENOSPC' }); };
            else handle.sync = async () => { throw Object.assign(new Error('Fictional storage failure'), { code: 'EIO' }); };
          }
          return handle;
        }) as typeof originalOpen;
        syncBuiltinESMExports();
      }
      const run = () => operation === 'frame' ? store.addFrame(meeting.id, source, 0, 0, pcm)
        : operation === 'pcm' ? store.addPcm(meeting.id, source, 0, 0, 16000, pcm) : store.sealWindow(meeting.id, store.heldFrames(meeting.id));
      await assert.rejects(run, /Fictional storage failure/);
      assert.deepEqual((await fs.readdir(dir)).sort(), before, 'no partial/unpublished file remains');
      fs.open = originalOpen; syncBuiltinESMExports();
      if (stage === 'insert') store.db.exec('DROP TRIGGER fictional_disk_failure');
      await run();
      if (operation === 'frame') await store.sealWindow(meeting.id, store.heldFrames(meeting.id));
      const chunks = store.chunks(meeting.id);
      assert.equal(chunks.length, 1);
      assert.deepEqual(await fs.readFile(store.resolvePath(chunks[0].path)), pcm);
      assert.equal((await fs.readdir(dir)).length, 1);
    } finally { fs.open = originalOpen; syncBuiltinESMExports(); store.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
}

test('startup reconciliation removes only generated unreferenced audio, preserving committed frames/windows and outside files', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'recording-orphans-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting();
  try {
    const { frame } = await store.addFrame(meeting.id, 'mic:held', 0, 0, Buffer.alloc(64000));
    const chunk = await store.addPcm(meeting.id, 'mic:chunk', 0, 1000, 16000, Buffer.alloc(64000));
    const dir = join(directory, 'audio', meeting.id), orphan = join(dir, `${randomUUID()}.frame.f32`);
    const window = join(dir, `g2-${randomUUID()}.f32`);
    await fs.writeFile(orphan, Buffer.alloc(16)); await fs.writeFile(window, Buffer.alloc(32000));
    const unexpected = join(dir, 'user-file.f32'); await fs.writeFile(unexpected, 'keep');
    const outside = join(directory, 'outside'); await fs.mkdir(outside);
    const outsideFile = join(outside, `${randomUUID()}.f32`); await fs.writeFile(outsideFile, 'keep outside');
    await fs.symlink(outside, join(directory, 'audio', randomUUID()));
    const link = join(dir, `${randomUUID()}.f32`); await fs.symlink(outsideFile, link);
    await (store as MeetingStore & { removeOrphanAudioFiles(): Promise<void> }).removeOrphanAudioFiles();
    await assert.rejects(fs.access(orphan)); await assert.rejects(fs.access(window));
    for (const path of [store.resolvePath(frame.path), store.resolvePath(chunk.path), unexpected, outsideFile, link]) await fs.access(path);
  } finally { store.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('reconciliation through a data-folder alias preserves relative recording references', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'recording-alias-'));
  const data = join(directory, 'real-data'), alias = join(directory, 'data-alias');
  await fs.mkdir(data); await fs.symlink(data, alias);
  const store = new MeetingStore(alias), meeting = store.createMeeting();
  try {
    const { frame } = await store.addFrame(meeting.id, 'mic:fictional', 0, 0, Buffer.alloc(64000));
    const chunk = await store.addPcm(meeting.id, 'mic:other', 0, 0, 16000, Buffer.alloc(64000));
    await store.removeOrphanAudioFiles();
    await fs.access(store.resolvePath(frame.path)); await fs.access(store.resolvePath(chunk.path));
  } finally { store.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
