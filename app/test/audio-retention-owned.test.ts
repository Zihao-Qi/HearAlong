import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../src/store.ts';
import { AudioRetention, AUDIO_RETENTION } from '../src/audio-retention.ts';

const result = { text: 'Historical transcript stays.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };

/** Reproduce the reviewer's actual pre-feature schema, rather than just setting audioLegacy on modern rows. */
function reopenLegacy(store: MeetingStore, directory: string) {
  store.db.exec(`ALTER TABLE chunks DROP COLUMN completedAt; ALTER TABLE frames DROP COLUMN savedAt;
    DROP TABLE audio_retention; DROP TABLE audio_removals; DROP TABLE recording_sources;`);
  for (const name of ['audioDoneAt', 'audioRemovedAt', 'audioRemovedAfter', 'audioLegacy', 'audioKept', 'recordingEndedAt', 'audioGeneration', 'audioEmpty']) {
    store.db.exec(`ALTER TABLE meetings DROP COLUMN ${name}`);
  }
  store.close();
  return new MeetingStore(directory);
}

function observeCounter(retention: AudioRetention) {
  const original = retention.run.bind(retention);
  let sweeps = 0;
  let pending: Promise<void> = Promise.resolve();
  retention.run = () => { sweeps++; return pending = original(); };
  return {
    count: () => sweeps,
    async ticks() {
      for (let i = 0; i < 5; i++) { retention.observe(); await pending; }
    },
  };
}

for (const kind of ['frame', 'chunk'] as const) test(`migrated transcript-only meeting caches no owned audio across observe ticks and restart; new ${kind} clears it`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-owned-migration-'));
  let store = new MeetingStore(directory), retention: AudioRetention | undefined;
  const now = Date.now() + 2 * AUDIO_RETENTION.day;
  try {
    const m = store.createMeeting();
    const old = await store.addPcm(m.id, 'mic:historical', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(old.id, result);
    await rm(join(directory, 'audio'), { recursive: true });
    store = reopenLegacy(store, directory);
    assert.equal(store.meeting(m.id).audioLegacy, 1);
    assert.equal(store.meeting(m.id).audioDoneAt, null);
    assert.equal((store.db.prepare('SELECT completedAt FROM chunks WHERE id=?').get(old.id) as { completedAt: number | null }).completedAt, null);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now });
    const scans = observeCounter(retention);
    await retention.run(); // startup pass
    await scans.ticks();
    assert.equal(scans.count(), 1, 'five observe ticks must not start additional sweeps');
    assert.equal(store.meeting(m.id).audioEmpty, 1);
    assert.equal(store.meeting(m.id).audioRemovedAt, null);
    assert.equal(retention.notice, null);
    assert.equal(existsSync(join(directory, 'audio')), false);
    assert.match(store.markdown(m.id), /Historical transcript stays/);
    assert.equal(store.chunk(old.id)!.path, old.path, 'historical rows are not rewritten as removals');

    retention.close(); store.close(); store = new MeetingStore(directory);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now });
    const restarted = observeCounter(retention);
    await retention.run(); await restarted.ticks();
    assert.equal(restarted.count(), 1, 'the verified absence survives restart');
    assert.equal(store.meeting(m.id).audioEmpty, 1);

    if (kind === 'frame') {
      const { frame } = await store.addFrame(m.id, 'mic:fresh', 0, 1000, Buffer.alloc(64000));
      assert.equal(store.meeting(m.id).audioEmpty, 0);
      assert.ok(existsSync(store.resolvePath(frame.path)));
      const sealed = await store.sealWindow(m.id, [frame]); store.completeChunk(sealed.id, result);
    } else {
      const chunk = await store.addPcm(m.id, 'mic:fresh', 0, 1000, 16000, Buffer.alloc(64000));
      assert.equal(store.meeting(m.id).audioEmpty, 0);
      assert.ok(existsSync(store.resolvePath(chunk.path))); store.completeChunk(chunk.id, result);
    }
    retention.observe(); await retention.run();
    assert.equal(store.meeting(m.id).audioEmpty, 0, 'fresh owned audio is examined normally');
    assert.deepEqual(retention.notice, { count: 1, bytes: 64000 });
  } finally { retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('imported legacy replay caches no owned audio and imports never enter deletion or the older-audio size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-owned-import-'));
  let store = new MeetingStore(directory), retention: AudioRetention | undefined;
  const now = Date.now() + 2 * AUDIO_RETENTION.day;
  try {
    await mkdir(join(directory, 'imports'));
    const path = join(directory, 'imports', 'replay.media');
    const importedBytes = Buffer.alloc(4096, 7); await writeFile(path, importedBytes);
    const replay = store.createMeeting('Imported replay');
    const source = store.addMedia(replay.id, path, 1);
    for (const chunk of store.chunks(replay.id)) store.completeChunk(chunk.id, result);
    store.startReplay(replay.id, source, 1, Date.now() - 60_000);
    const owned = store.createMeeting('Owned audio');
    const ownedChunk = await store.addPcm(owned.id, 'mic:owned', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(ownedChunk.id, result);
    store = reopenLegacy(store, directory);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now });
    const scans = observeCounter(retention);
    await retention.run(); await scans.ticks();
    assert.equal(scans.count(), 1, 'completed replay transcript rows must not perpetuate sweeps');
    assert.equal(store.meeting(replay.id).audioEmpty, 1);
    assert.equal(store.meeting(replay.id).audioRemovedAt, null);
    assert.equal(existsSync(join(directory, 'audio', replay.id)), false);
    assert.deepEqual(retention.notice, { count: 1, bytes: 64000 }, 'only owned audio contributes to the one-time question');
    retention.answer('remove'); await retention.run();
    assert.equal(existsSync(store.resolvePath(ownedChunk.path)), false);
    assert.deepEqual(await readFile(path), importedBytes, 'the imported original is never deleted or changed');
    assert.equal(store.resolvePath(store.chunks(replay.id)[0].path), path);
    assert.equal(store.meeting(replay.id).audioRemovedAt, null);
    assert.match(store.markdown(replay.id), /Historical transcript stays/);
    retention.close(); store.close(); store = new MeetingStore(directory);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now });
    const restarted = observeCounter(retention);
    await retention.run(); await restarted.ticks();
    assert.equal(restarted.count(), 1);
    assert.deepEqual(await readFile(path), importedBytes);
  } finally { retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('verified owned-audio absence covers every generation even when transcript timestamps exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-owned-generations-'));
  const store = new MeetingStore(directory);
  let retention: AudioRetention | undefined;
  try {
    const m = store.createMeeting();
    const chunk = await store.addPcm(m.id, 'mic:old', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(chunk.id, result);
    await rm(store.resolvePath(chunk.path));
    const orphan = join(directory, 'audio', m.id, 'g7-orphan.f32');
    await writeFile(orphan, Buffer.alloc(0)); // even zero-byte audio is owned; it is not absence
    store.db.prepare('UPDATE meetings SET audioLegacy=1 WHERE id=?').run(m.id);
    retention = new AudioRetention(store, { setting: () => 'always', active: () => false });
    await retention.run();
    assert.equal(store.meeting(m.id).audioEmpty, 0, 'another generation prevents an empty marker');
    assert.ok(existsSync(orphan));
    await rm(orphan); await retention.run();
    assert.equal(store.meeting(m.id).audioEmpty, 1, 'transcript timestamps do not prevent caching verified absence');
    assert.equal(store.meeting(m.id).audioRemovedAt, null);
    assert.match(store.markdown(m.id), /Historical transcript stays/);
  } finally { retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
