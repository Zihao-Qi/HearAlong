import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, symlink, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { MeetingStore } from '../src/store.ts';
import { AudioRetention, AUDIO_RETENTION, type AudioRetentionSetting } from '../src/audio-retention.ts';
import { startServer } from '../src/server.ts';

const result = { text: 'Transcript stays', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'audio-retention-'));
  let store = new MeetingStore(directory), now = Date.now() + 100 * AUDIO_RETENTION.day;
  let setting: AudioRetentionSetting = 'day';
  const active = new Set<string>();
  const makeRetention = (extra: Partial<ConstructorParameters<typeof AudioRetention>[1]> = {}) => new AudioRetention(store, { clock: () => now, setting: () => setting, active: id => active.has(id), ...extra });
  let retention = makeRetention();
  const age = (id: string, days = 2) => store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(now - days * AUDIO_RETENTION.day, id);
  async function meeting(legacy = false) {
    const m = store.createMeeting('Audio');
    const c = await store.addPcm(m.id, 'mic:take', 0, 0, 16000, Buffer.alloc(64000));
    store.completeChunk(c.id, result);
    age(m.id);
    if (legacy) store.db.prepare('UPDATE meetings SET audioLegacy=1 WHERE id=?').run(m.id);
    return { ...m, chunk: c, folder: join(directory, 'audio', m.id) };
  }
  return {
    directory, get store() { return store; }, get retention() { return retention; }, active, age, meeting, makeRetention,
    now: () => now,
    advance: (ms: number) => { now += ms; }, set: (s: AudioRetentionSetting) => { setting = s; },
    reopen() { retention.close(); store.close(); store = new MeetingStore(directory); retention = makeRetention(); },
    async close() { retention.close(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) test(`retention holds ${status} chunks, then removes only after completion`, async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    f.store.setStatus(m.chunk.id, status);
    f.age(m.id);
    await f.retention.run();
    assert.equal(f.store.meeting(m.id).audioRemovedAt, null);
    assert.ok(existsSync(f.store.resolvePath(m.chunk.path)));
    f.store.completeChunk(m.chunk.id, result); f.age(m.id);
    await f.retention.run();
    assert.ok(f.store.meeting(m.id).audioRemovedAt);
    assert.equal(existsSync(m.folder), false);
  } finally { await f.close(); }
});

test('retention holds recording and pending admission, then starts its completion clock', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting(); f.active.add(m.id);
    await f.retention.run();
    assert.equal(f.store.meeting(m.id).audioRemovedAt, null);
    f.active.delete(m.id); f.retention.observe();
    assert.ok(f.store.meeting(m.id).audioDoneAt);
    await f.retention.run(); assert.ok(existsSync(f.store.resolvePath(m.chunk.path)));
    f.advance(AUDIO_RETENTION.day + 1); await f.retention.run();
    assert.equal(existsSync(m.folder), false);
  } finally { await f.close(); }
});

test('completion arms an expiry timer without waiting for the hourly pass', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    f.age(m.id, 0); f.retention.observe();
    assert.ok(existsSync(m.folder));
    f.advance(AUDIO_RETENTION.day + 1); f.retention.observe();
    for (let i = 0; i < 100 && existsSync(m.folder); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(existsSync(m.folder), false);
    assert.ok(f.store.meeting(m.id).audioRemovedAt);
  } finally { await f.close(); }
});

test('retention holds a replay until its end and starts a fresh timer', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    f.store.startReplay(m.id, m.chunk.source, 1, f.now());
    f.retention.observe(); await f.retention.run();
    assert.ok(existsSync(m.folder)); assert.equal(f.store.meeting(m.id).audioRemovedAt, null);
    f.advance(1001); f.retention.observe(); await f.retention.run(); assert.ok(existsSync(m.folder));
    f.advance(AUDIO_RETENTION.day + 1); await f.retention.run(); assert.equal(existsSync(m.folder), false);
  } finally { await f.close(); }
});

test('retention holds unsealed frames; sealed windows and leftover frames are removed together', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    const { frame } = await f.store.addFrame(m.id, 'mic:live', 0, 1000, Buffer.alloc(64000));
    f.age(m.id); await f.retention.run();
    assert.ok(existsSync(f.store.resolvePath(frame.path))); assert.equal(f.store.meeting(m.id).audioRemovedAt, null);
    const sealed = await f.store.sealWindow(m.id, [frame]);
    await writeFile(f.store.resolvePath(frame.path), Buffer.alloc(4)); // crash residue from a seal
    f.store.completeChunk(sealed.id, result); f.age(m.id);
    await f.retention.run();
    assert.equal(existsSync(f.store.resolvePath(sealed.path)), false); assert.equal(existsSync(f.store.resolvePath(frame.path)), false);
    assert.equal(f.store.heldSources().length, 0);
    await assert.rejects(f.store.sealWindow(m.id, [frame]), /Audio removed/);
  } finally { await f.close(); }
});

test('retention waits for expiry, honours Always, and applies month to day changes', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    f.age(m.id, 0.5); await f.retention.run(); assert.ok(existsSync(m.folder));
    f.age(m.id, 10); f.set('month'); await f.retention.run(); assert.ok(existsSync(m.folder));
    f.set('always'); await f.retention.run(); assert.ok(existsSync(m.folder));
    f.set('day'); await f.retention.run(); assert.equal(existsSync(m.folder), false);
    assert.equal(f.store.meeting(m.id).audioRemovedAfter, '1 day');
  } finally { await f.close(); }
});

test('retention commits removal before deleting; transcripts, notes, imports and sibling folders stay', async () => {
  const f = await fixture();
  let r: AudioRetention | undefined;
  try {
    const m = await f.meeting();
    const keep = [join(f.directory, 'notes', m.id + '.json'), join(f.directory, 'imports', 'original.media'), join(f.directory, 'eval-room', 'take.f32'), join(f.directory, 'audio', 'eval-sibling', 'take.f32')];
    for (const path of keep) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'keep'); }
    // Malicious/old DB paths must never decide what is deleted.
    f.store.db.prepare('UPDATE chunks SET path=? WHERE id=?').run(keep[1], m.chunk.id);
    r = f.makeRetention({ removeFiles: async (path, names) => {
      assert.ok(f.store.meeting(m.id).audioRemovedAt);
      assert.equal(f.store.chunk(m.chunk.id)!.path, '');
      await Promise.all(names.map(name => rm(join(path, name), { force: true })));
      await rmdir(path);
    } });
    await r.run();
    assert.equal(existsSync(m.folder), false);
    assert.match(f.store.markdown(m.id), /Transcript stays/);
    for (const path of keep) assert.equal(await readFile(path, 'utf8'), 'keep');
  } finally { r?.close(); await f.close(); }
});

test('a restart finishes deletion committed before a crash, even with Always', async () => {
  const f = await fixture(); let r: AudioRetention | undefined;
  try {
    const m = await f.meeting();
    r = f.makeRetention({ removeFiles: async () => { throw new Error('crash'); } });
    await r.run(); r.close();
    assert.ok(f.store.meeting(m.id).audioRemovedAt); assert.ok(existsSync(m.folder));
    f.reopen(); f.set('always'); await f.retention.run();
    assert.equal(existsSync(m.folder), false);
    assert.equal(f.store.nextChunk(), undefined);
    await f.store.removeSealedFrameFiles();
    assert.match(f.store.markdown(m.id), /Transcript stays/);
  } finally { r?.close(); await f.close(); }
});

for (const answer of ['remove', 'keep'] as const) test(`older audio question blocks old meetings, not new ones; ${answer} is durable and asked once`, async () => {
  const f = await fixture();
  try {
    const old = await f.meeting(true), newer = await f.meeting();
    await f.retention.run();
    assert.ok(existsSync(old.folder)); assert.equal(existsSync(newer.folder), false);
    assert.deepEqual(f.retention.notice, { count: 1, bytes: 64000 });
    f.reopen(); await f.retention.run(); assert.ok(existsSync(old.folder)); assert.ok(f.retention.notice);
    f.retention.answer(answer); await f.retention.run();
    assert.equal(existsSync(old.folder), answer === 'keep');
    if (answer === 'keep') assert.equal(f.store.meeting(old.id).audioKept, 1);
    f.reopen(); f.advance(40 * AUDIO_RETENTION.day); await f.retention.run();
    assert.equal(f.retention.notice, null); assert.equal(existsSync(old.folder), answer === 'keep');
    const later = await f.meeting(); await f.retention.run(); assert.equal(existsSync(later.folder), false);
  } finally { await f.close(); }
});

test('legacy migration separates existing meetings and falls back to file time without DB timestamps', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    const stamp = Math.floor(Date.now() / 1000) * 1000;
    await utimes(f.store.resolvePath(m.chunk.path), stamp / 1000, stamp / 1000);
    f.store.db.exec('ALTER TABLE chunks DROP COLUMN completedAt; ALTER TABLE frames DROP COLUMN savedAt; DROP TABLE audio_retention');
    for (const column of ['audioDoneAt', 'audioRemovedAt', 'audioRemovedAfter', 'audioLegacy', 'audioKept', 'recordingEndedAt']) f.store.db.exec(`ALTER TABLE meetings DROP COLUMN ${column}`);
    f.reopen(); await f.retention.run();
    assert.equal(f.store.meeting(m.id).audioLegacy, 1);
    assert.equal(f.store.meeting(m.id).audioDoneAt, stamp);
    assert.equal(f.store.createMeeting().audioLegacy, 0);
    assert.ok(f.retention.notice);
    f.retention.answer('remove'); await f.retention.run(); assert.equal(existsSync(m.folder), false);
  } finally { await f.close(); }
});

test('legacy completion uses the latest completed chunk or frame timestamp when available', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting(true);
    const { frame } = await f.store.addFrame(m.id, 'mic:legacy', 0, 1000, Buffer.alloc(64000));
    const sealed = await f.store.sealWindow(m.id, [frame]); f.store.completeChunk(sealed.id, result);
    const latest = f.now() - 2 * AUDIO_RETENTION.day;
    f.store.db.prepare('UPDATE frames SET savedAt=? WHERE id=?').run(latest, frame.id);
    f.store.db.prepare('UPDATE chunks SET completedAt=? WHERE meetingId=?').run(latest - 1000, m.id);
    f.store.db.prepare('UPDATE meetings SET audioDoneAt=NULL WHERE id=?').run(m.id);
    await f.retention.run();
    assert.equal(f.store.meeting(m.id).audioDoneAt, latest);
    assert.ok(existsSync(f.store.resolvePath(sealed.path)));
    f.retention.answer('remove'); await f.retention.run(); assert.equal(existsSync(f.store.resolvePath(sealed.path)), false);
  } finally { await f.close(); }
});

test('legacy audio without DB chunk/frame times uses newest file modification time', async () => {
  const f = await fixture();
  try {
    const m = f.store.createMeeting(); const folder = join(f.directory, 'audio', m.id);
    await mkdir(folder, { recursive: true });
    const path = join(folder, 'orphan.frame.f32'); await writeFile(path, 'audio');
    const stamp = Math.floor(Date.now() / 1000) * 1000; await utimes(path, stamp / 1000, stamp / 1000);
    f.store.db.prepare('UPDATE meetings SET audioLegacy=1 WHERE id=?').run(m.id);
    await f.retention.run(); assert.equal(f.store.meeting(m.id).audioDoneAt, stamp);
    assert.ok(existsSync(path)); f.retention.answer('remove'); await f.retention.run(); assert.equal(existsSync(path), false);
  } finally { await f.close(); }
});

test('retention refuses symlink escapes and preserves unexpected documents and eval folders', async () => {
  const f = await fixture();
  try {
    const m = await f.meeting();
    const outside = join(f.directory, 'imports'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'safe');
    await rm(m.folder, { recursive: true }); await symlink(outside, m.folder);
    await f.retention.run(); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe');
    const valid = await f.meeting();
    await writeFile(join(valid.folder, 'notes.md'), 'notes');
    await mkdir(join(valid.folder, 'eval-private')); await writeFile(join(valid.folder, 'eval-private', 'take.f32'), 'eval');
    await symlink(join(outside, 'keep'), join(valid.folder, 'linked.f32'));
    await f.retention.run();
    assert.equal(existsSync(f.store.resolvePath(valid.chunk.path)), false);
    assert.equal(await readFile(join(valid.folder, 'notes.md'), 'utf8'), 'notes');
    assert.equal(await readFile(join(valid.folder, 'eval-private', 'take.f32'), 'utf8'), 'eval');
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe');
  } finally { await f.close(); }
});

test('recording a new meeting and close do not wait on a large deletion', async () => {
  const f = await fixture(); let r: AudioRetention | undefined; let finish!: () => void;
  try {
    const old = await f.meeting();
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const disk = new Promise<void>(resolve => { finish = resolve; });
    r = f.makeRetention({ removeFiles: async () => { began(); await disk; } });
    const sweeping = r.run();
    await Promise.race([started, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Deletion did not begin.')), 250))]);
    const current = f.store.createMeeting();
    await f.store.addFrame(current.id, 'mic:new', 0, 0, Buffer.alloc(64000));
    assert.equal(f.store.heldFrames(current.id).length, 1);
    assert.ok(f.store.meeting(old.id).audioRemovedAt);
    r.close(); f.reopen(); // closes the old SQLite handle; late completion must not use it
    finish(); await sweeping;
  } finally { finish?.(); r?.close(); await f.close(); }
});

test('an arriving recording claims its meeting before the first frame body is saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-admission-'));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let incoming: ClientRequest | undefined;
  try {
    app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: { async transcribe() { return result; }, close() {} } });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const m = app.store.createMeeting();
    const c = await app.store.addPcm(m.id, 'mic:old', 0, 0, 16000, Buffer.alloc(64000));
    app.store.completeChunk(c.id, result);
    app.store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(Date.now() - 3 * AUDIO_RETENTION.day, m.id);
    const response = new Promise<number>((resolve, reject) => {
      incoming = httpRequest(app!.url + `/api/meetings/${m.id}/pcm`, { method: 'POST', headers: {
        Cookie: cookie, Origin: app!.url, 'Content-Length': '64000', 'X-Audio-Source': 'mic:11111111-1111-1111-1111-111111111111',
        'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '1000',
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      incoming.on('error', reject);
      incoming.write(Buffer.alloc(4)); // the rest of the frame is still arriving
    });
    void response.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 40));
    await app.audioRetention.run();
    assert.equal(app.store.meeting(m.id).audioRemovedAt, null, 'admission must block deletion before the frame reaches disk');
    incoming!.end(Buffer.alloc(63996));
    assert.equal(await response, 201);
    assert.equal(app.store.heldFrames(m.id).length, 1);
  } finally { incoming?.destroy(); await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server settings persist and removed-meeting retry is a clean refusal; room-compare is graceful', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-server-'));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, value: object) => fetch(app!.url + path, { method: 'PUT', headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await (await fetch(app.url + '/api/settings', { headers: { Cookie: cookie } })).json()).audioRetention, 'day');
    assert.equal((await request('/api/settings', { audioRetention: 'invalid' })).status, 400);
    assert.equal((await request('/api/settings', { audioRetention: 'always' })).status, 200);
    assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).audioRetention, 'always');
    const m = app.store.createMeeting(); const c = await app.store.addPcm(m.id, 'mic:take', 0, 0, 16000, Buffer.alloc(64000));
    app.store.completeChunk(c.id, result);
    app.store.db.prepare('UPDATE meetings SET audioDoneAt=? WHERE id=?').run(Date.now() - 3 * AUDIO_RETENTION.day, m.id);
    await app.audioRetention.run(); assert.ok(existsSync(app.store.resolvePath(c.path)), 'saved Always stops removal');
    await request('/api/settings', { audioRetention: 'day' }); await app.audioRetention.run();
    const response = await fetch(app.url + `/api/meetings/${m.id}/retry`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url } });
    assert.equal(response.status, 409); assert.match((await response.json()).error, /Audio removed/);
    assert.throws(() => app!.store.setStatus(c.id, 'queued'), /Audio removed/);
    const compare = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/room-compare.ts', m.id, directory], { cwd: process.cwd(), encoding: 'utf8' }));
    assert.match(compare.audio, /removed/); assert.equal(compare.takes[0].levelDbfs.median, null);
    const residue = join(directory, 'audio', m.id, 'crash.frame.f32');
    await mkdir(join(residue, '..'), { recursive: true }); await writeFile(residue, 'left after mark');
    await app.close();
    app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null });
    for (let i = 0; i < 100 && existsSync(residue); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(existsSync(residue), false, 'server startup finishes committed deletion without an explicit sweep');
    const nextCookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    assert.equal((await (await fetch(app.url + '/api/settings', { headers: { Cookie: nextCookie } })).json()).audioRetention, 'day');
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
