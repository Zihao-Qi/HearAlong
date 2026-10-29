import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer } from '../src/server.ts';
import { MeetingStore } from '../src/store.ts';
import { AudioRetention, AUDIO_RETENTION } from '../src/audio-retention.ts';

const result = { text: 'The transcript remains.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
async function serverFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'audio-fixes-http-'));
  let now = Date.now();
  const serve = () => startServer({ directory, port: 0, clock: () => now, quick: null, heavy: null,
    recognizer: { async transcribe() { return result; }, close() {} } });
  let app = await serve();
  let cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const page = randomUUID();
  const request = (path: string, options: RequestInit = {}, owner: string = page) => fetch(app.url + path, {
    ...options, headers: { Cookie: cookie, Origin: app.url, 'X-Page': owner, ...options.headers },
  });
  const frame = (id: string, source: string, sequence = 0, owner: string = page) => request(`/api/meetings/${id}/pcm`, {
    method: 'POST', body: Buffer.alloc(64000), headers: { 'X-Audio-Source': source, 'X-Sequence': String(sequence),
      'X-Start-Ms': String(sequence * 1000), 'X-Sample-Rate': '16000' },
  }, owner);
  const end = (id: string, source: string, lastSequence = 0) => request(`/api/meetings/${id}/pcm/end`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, lastSequence }),
  });
  return {
    directory, page, get app() { return app; }, request, frame, end, now: () => now,
    advance(ms: number) { now += ms; },
    async restart() { await app.close(); app = await serve(); cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0]; },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('HTTP unended recording survives 61 seconds, idle sealing and a day; next frame resumes', async () => {
  const f = await serverFixture();
  try {
    const m = f.app.store.createMeeting(), source = `mic:${randomUUID()}`;
    assert.equal((await f.frame(m.id, source)).status, 201);
    f.advance(61_000); await f.app.capture.sweep(); await f.app.jobs!.wait();
    assert.equal(f.app.store.heldFrames(m.id).length, 0);
    assert.equal(f.app.store.chunks(m.id)[0].status, 'completed');
    f.app.audioRetention.observe();
    f.advance(AUDIO_RETENTION.day + 1); await f.app.audioRetention.run();
    assert.equal(f.app.store.meeting(m.id).audioRemovedAt, null);
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, null, 'no Stop or abandonment means no retention clock');
    assert.ok(existsSync(f.app.store.resolvePath(f.app.store.chunks(m.id)[0].path)));
    assert.equal((await f.frame(m.id, source, 1)).status, 201);
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, null);
    assert.equal((await f.end(m.id, source, 1)).status, 200);
    await f.app.jobs!.wait(); f.app.audioRetention.observe();
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, f.now());
    f.advance(AUDIO_RETENTION.day + 1); await f.app.audioRetention.run();
    assert.ok(f.app.store.meeting(m.id).audioRemovedAt);
  } finally { await f.close(); }
});

test('goodbye abandons only its page recording durably and only after sources are sealed', async () => {
  const f = await serverFixture();
  try {
    const departed = f.app.store.createMeeting(), stillHere = f.app.store.createMeeting();
    assert.equal((await f.frame(departed.id, `mic:${randomUUID()}`)).status, 201);
    assert.equal((await f.frame(stillHere.id, `mic:${randomUUID()}`, 0, 'other-page')).status, 201);
    assert.equal((await f.request(`/api/bye?page=${f.page}`, { method: 'POST' })).status, 204);
    await f.app.jobs!.wait(); f.advance(61_000); f.app.audioRetention.observe();
    assert.equal(f.app.store.heldFrames(departed.id).length, 0);
    assert.equal(f.app.store.recordingUnended(departed.id), false);
    assert.ok(f.app.store.meeting(departed.id).audioDoneAt);
    f.advance(AUDIO_RETENTION.day + 1); await f.app.capture.sweep(); await f.app.jobs!.wait(); await f.app.audioRetention.run();
    assert.ok(f.app.store.meeting(departed.id).audioRemovedAt);
    assert.equal(f.app.store.meeting(stillHere.id).audioRemovedAt, null);
  } finally { await f.close(); }
});

for (const reconnect of [false, true]) test(`restart abandonment waits for sealing and no capture reconnect: reconnect=${reconnect}`, async () => {
  const f = await serverFixture();
  try {
    const m = f.app.store.createMeeting(), source = `mic:${randomUUID()}`;
    assert.equal((await f.frame(m.id, source)).status, 201);
    await f.restart();
    await f.app.jobs!.wait(); await f.app.audioRetention.run();
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, null, 'a restart alone must not declare Stop');
    if (reconnect) assert.equal((await f.frame(m.id, source, 1)).status, 201, 'a real frame, not a page heartbeat, reclaims the source');
    f.advance(61_000); await f.app.capture.sweep(); await f.app.jobs!.wait(); f.app.audioRetention.observe();
    assert.equal(f.app.store.heldFrames(m.id).length, 0);
    assert.equal(f.app.store.recordingUnended(m.id), reconnect);
    if (reconnect) {
      f.advance(AUDIO_RETENTION.day + 1); await f.app.audioRetention.run();
      assert.equal(f.app.store.meeting(m.id).audioRemovedAt, null);
      assert.equal((await f.frame(m.id, source, 2)).status, 201);
    } else {
      assert.equal(f.app.store.meeting(m.id).audioDoneAt, f.now());
      await f.restart(); // abandonment and its done clock survive another restart
      f.advance(AUDIO_RETENTION.day + 1); await f.app.audioRetention.run();
      assert.ok(f.app.store.meeting(m.id).audioRemovedAt);
    }
  } finally { await f.close(); }
});

test('HTTP removal allows a fresh recording generation with its own completion and expiry', async () => {
  const f = await serverFixture();
  try {
    const m = f.app.store.createMeeting(), first = `mic:${randomUUID()}`, second = `mic:${randomUUID()}`;
    assert.equal((await f.frame(m.id, first)).status, 201);
    assert.equal((await f.end(m.id, first)).status, 200);
    await f.app.jobs!.wait(); f.app.audioRetention.observe();
    const old = f.app.store.chunks(m.id)[0];
    f.advance(AUDIO_RETENTION.day + 1); await f.app.audioRetention.run();
    assert.equal(existsSync(f.app.store.resolvePath(old.path)), false); assert.ok(f.app.store.meeting(m.id).audioRemovedAt);
    const retry = await f.request(`/api/meetings/${m.id}/retry`, { method: 'POST' });
    assert.equal(retry.status, 409); assert.match((await retry.json()).error, /transcription cannot be retried/);
    const resumed = await f.frame(m.id, second);
    assert.equal(resumed.status, 201, await resumed.text());
    assert.equal(f.app.store.meeting(m.id).audioRemovedAt, null, 'quiet line disappears once new capture starts');
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, null);
    assert.throws(() => f.app.store.setStatus(old.id, 'queued'), /transcription cannot be retried/);
    assert.equal((await f.end(m.id, second)).status, 200);
    await f.app.jobs!.wait(); f.app.audioRetention.observe();
    const fresh = f.app.store.chunks(m.id).find(c => c.source === second)!;
    assert.ok(existsSync(f.app.store.resolvePath(fresh.path))); assert.match(fresh.path, /g1-/);
    assert.equal(f.app.store.meeting(m.id).audioDoneAt, f.now());
    await f.app.audioRetention.run(); assert.ok(existsSync(f.app.store.resolvePath(fresh.path)));
    f.advance(AUDIO_RETENTION.day - 1); await f.app.audioRetention.run(); assert.ok(existsSync(f.app.store.resolvePath(fresh.path)));
    f.advance(2); await f.app.audioRetention.run(); assert.equal(existsSync(f.app.store.resolvePath(fresh.path)), false);
    assert.equal(f.app.store.segments(m.id).length, 2);
  } finally { await f.close(); }
});

test('pending and restarted old-generation cleanup cannot delete a resumed recording', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-generation-'));
  let store = new MeetingStore(directory);
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), disk = new Promise<void>(resolve => { release = resolve; });
  let retention: AudioRetention | undefined;
  const now = Date.now();
  try {
    const m = store.createMeeting(), old = await store.addPcm(m.id, 'mic:old', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(old.id, result); store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(now - 2 * AUDIO_RETENTION.day, m.id);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false, clock: () => now,
      removeFiles: async (folder, names) => { began(); await disk; for (const name of names) await rm(join(folder, name), { force: true }); },
    });
    const sweeping = retention.run();
    await Promise.race([started, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('deletion did not begin')), 1000))]);
    const { frame } = await store.addFrame(m.id, 'mic:new', 0, 1000, Buffer.alloc(64000));
    assert.equal(store.meeting(m.id).audioRemovedAt, null);
    assert.ok(existsSync(store.resolvePath(frame.path)));
    release(); await sweeping;
    assert.ok(existsSync(store.resolvePath(frame.path)), 'in-flight deletion uses only the removed generation');
    await writeFile(store.resolvePath(old.path), 'residue from a crash');
    retention.close(); store.close(); store = new MeetingStore(directory);
    let cleaning!: () => void;
    const cleaningStarted = new Promise<void>(resolve => { cleaning = resolve; });
    const resumedDisk = new Promise<void>(resolve => { release = resolve; });
    const errors: string[] = [];
    retention = new AudioRetention(store, { setting: () => 'always', active: () => false, log: message => errors.push(message),
      removeFiles: async (folder, names) => { cleaning(); await resumedDisk; for (const name of names) await rm(join(folder, name), { force: true }); },
    });
    const resumedCleanup = retention.run(); await cleaningStarted;
    retention.close(); store.close(); store = new MeetingStore(directory);
    release(); await resumedCleanup;
    assert.deepEqual(errors, [], 'cleanup completing after close never accesses the closed database');
    assert.equal(existsSync(store.resolvePath(old.path)), false, 'old cleanup survives restart even with Always');
    assert.ok(existsSync(store.resolvePath(frame.path)));
    assert.throws(() => store.setStatus(old.id, 'queued'), /transcription cannot be retried/);
  } finally { release?.(); retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('new generation capture tolerates old cleanup removing the empty directory before file creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-generation-directory-'));
  try {
    const preload = join(directory, 'finish-cleanup.mjs');
    await writeFile(preload, `import fs from 'node:fs/promises'; import { dirname } from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.open; let pending = true;
fs.open = async function(path, ...args) {
  if (pending && String(path).includes('/g1-')) { pending = false; await fs.rmdir(dirname(path)); }
  return original.call(this, path, ...args);
}; syncBuiltinESMExports();`);
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--import', preload, '--input-type=module', '-e', `
      import { MeetingStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      const store = new MeetingStore(${JSON.stringify(directory)});
      try {
        const m = store.createMeeting(); store.db.prepare('UPDATE meetings SET audioRemovedAt=1 WHERE id=?').run(m.id);
        const { frame } = await store.addFrame(m.id, 'mic:new', 0, 0, Buffer.alloc(64000));
        console.log(JSON.stringify({ path: store.resolvePath(frame.path), removed: store.meeting(m.id).audioRemovedAt }));
      } finally { store.close(); }
    `], { encoding: 'utf8' });
    const saved = JSON.parse(output);
    assert.equal(saved.removed, null); assert.ok(existsSync(saved.path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('generation migration preserves old removed rows and their crash cleanup without rewriting chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-generation-migrate-'));
  let store = new MeetingStore(directory); let retention: AudioRetention | undefined;
  try {
    const m = store.createMeeting(), old = await store.addPcm(m.id, 'mic:old', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(old.id, result);
    store.db.prepare("UPDATE chunks SET path='' WHERE id=?").run(old.id);
    store.db.prepare("UPDATE meetings SET audioRemovedAt=?, audioRemovedAfter='1 day' WHERE id=?").run(Date.now(), m.id);
    store.db.exec('DROP TABLE audio_removals; ALTER TABLE meetings DROP COLUMN audioGeneration; ALTER TABLE meetings DROP COLUMN audioEmpty;');
    store.close(); store = new MeetingStore(directory);
    assert.equal(store.chunk(old.id)!.path, '');
    assert.equal(store.chunk(old.id)!.text, result.text);
    const { frame } = await store.addFrame(m.id, 'mic:new', 0, 1000, Buffer.alloc(64000));
    retention = new AudioRetention(store, { setting: () => 'always', active: () => false });
    await retention.run();
    assert.equal(existsSync(store.resolvePath(old.path)), false); assert.ok(existsSync(store.resolvePath(frame.path)));
    assert.throws(() => store.setStatus(old.id, 'queued'), /transcription cannot be retried/);
  } finally { retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('room-compare keeps transcript metrics when audio disappears between existence check and read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'room-disappears-'));
  const store = new MeetingStore(directory);
  try {
    const m = store.createMeeting(); const c = await store.addPcm(m.id, 'mic:take', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(c.id, result);
    const preload = join(directory, 'disappear.mjs');
    await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (path === ${JSON.stringify(store.resolvePath(c.path))}) fs.rmSync(path, { force: true });
  return original.call(this, path, ...args);
}; syncBuiltinESMExports();`);
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--import', preload, 'scripts/room-compare.ts', m.id, directory], { encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.match(report.audio, /unavailable/i);
    assert.equal(report.takes[0].words, result.text.split(' ').length);
    assert.equal(report.takes[0].windows, 1);
    assert.equal(report.takes[0].sample, result.text);
    assert.equal(report.takes[0].levelDbfs.median, null);
    assert.deepEqual(report.takes[0].unavailableAudio, [0]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an empty legacy meeting is scanned once and observe starts no more sweeps, including after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-empty-'));
  let store = new MeetingStore(directory); let retention: AudioRetention | undefined;
  try {
    const m = store.createMeeting(); store.db.prepare('UPDATE meetings SET audioLegacy=1 WHERE id=?').run(m.id);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false });
    await retention.run(); // startup inspects the disk once, including for unindexed orphan audio
    let sweeps = 0;
    const run = retention.run.bind(retention);
    retention.run = () => { sweeps++; return run(); };
    for (let i = 0; i < 10; i++) retention.observe();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sweeps, 0);
    assert.equal(store.meeting(m.id).audioRemovedAt, null);
    assert.equal(existsSync(join(directory, 'audio')), false, 'nothing was touched');
    retention.close(); store.close(); store = new MeetingStore(directory);
    retention = new AudioRetention(store, { setting: () => 'day', active: () => false });
    sweeps = 0; retention.run = async () => { sweeps++; };
    retention.observe(); assert.equal(sweeps, 0, 'empty marker is durable');
    // Fresh capture clears the empty marker and follows retention normally.
    const c = await store.addPcm(m.id, 'mic:new', 0, 0, 16000, Buffer.alloc(64000));
    assert.equal(store.meeting(m.id).audioEmpty, 0); assert.ok(existsSync(store.resolvePath(c.path)));
  } finally { retention?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
