import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SwitchableRecognizer } from '../src/setup/switchable-recognizer.ts';
import { MeetingStore, type Chunk } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';
import { LiveDrafts } from '../src/drafts.ts';
import { startServer } from '../src/server.ts';
import type { SetupOptions } from '../src/setup/service.ts';
import { model, gguf } from './helpers/gguf.ts';

const workerScript = new URL('./fixtures/switch-worker.ts', import.meta.url);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(condition: () => boolean | Promise<boolean>, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!await condition()) { if (Date.now() > deadline) throw new Error('Condition did not settle'); await sleep(10); }
}
async function directory(t: TestContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'setup-live-')));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function chunk(seconds = .02): Chunk {
  return { id: randomUUID(), meetingId: 'example', source: 'example', sequence: 0, path: '/unused', decodeStart: 0, startMs: 0,
    seconds, sampleRate: null, status: 'queued', text: '', error: null, metrics: null, hash: 'example', attempts: 0, retryAt: null };
}
async function pids(path: string) { return (await readFile(`${path}.pids`, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number); }
function gone(pid: number) { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
async function api(t: TestContext, setup: SetupOptions = {}, prepare?: (path: string) => Promise<void>) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'setup-live-api-'))); await prepare?.(path);
  const drafts = new LiveDrafts({ modelPath: 'startup', workerScript: new URL('./fixtures/fake-stream-worker.ts', import.meta.url) });
  const app = await startServer({ directory: path, port: 0, quick: null, heavy: null, drafts, setup: {
    ...setup, worker: { workerScript, ...setup.worker },
    scan: { home: join(path, 'home'), envModelPath: null, hfHome: null, ...setup.scan },
    ffmpeg: setup.ffmpeg ?? (async () => ({ found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })),
  } });
  t.after(async () => { await app.close(); await rm(path, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (route: string, options: RequestInit = {}) => fetch(`${app.url}${route}`, { ...options, headers: {
    Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...options.headers,
  } });
  const get = async (route = '/api/setup') => (await request(route)).json();
  const post = (route: string, value: unknown = {}) => request(route, { method: 'POST', body: JSON.stringify(value) });
  const use = async (name: string) => {
    const row = (await get('/api/setup/speech-models')).models.find((m: any) => m.name === name);
    const response = await post('/api/setup/speech/use', { id: row.id }); assert.equal(response.status, 200); return response.json();
  };
  return { app, drafts, path, request, get, post, use };
}

test('switch waits between chunks, reuses preflight worker, and startup does not preflight', async t => {
  const path = await directory(t), old = join(path, 'old.gguf'), next = join(path, 'next.gguf');
  const r = new SwitchableRecognizer(old, { workerScript }); t.after(() => r.close());
  assert.deepEqual(await pids(old), []);
  const first = r.transcribe(chunk(.5)); await until(async () => (await pids(old)).length === 1);
  const change = r.switchTo(next);
  await until(async () => (await pids(next)).length === 1); await sleep(80);
  assert.equal(r.modelPath, old);
  assert.match((await first).text, /^old.gguf:/);
  const second = r.transcribe(chunk());
  assert.equal(await change, true); assert.match((await second).text, /^next.gguf:/);
  assert.equal((await pids(next)).length, 1, 'test-loaded worker is reused');
  assert.ok((await pids(old)).every(gone));
});

for (const name of ['broken.gguf', 'never.gguf']) test(`failed preflight ${name} preserves old worker and kills test child`, async t => {
  const path = await directory(t), old = join(path, 'old.gguf'), bad = join(path, name);
  const r = new SwitchableRecognizer(old, { workerScript, loadMs: 300 }); t.after(() => r.close());
  await r.transcribe(chunk());
  await assert.rejects(r.switchTo(bad), name.startsWith('never') ? /timed out/ : /Could not load/);
  await until(async () => (await pids(bad)).every(gone));
  assert.equal((await pids(bad)).length, 1);
  assert.match((await r.transcribe(chunk())).text, /^old.gguf:/);
});

test('latest switch supersedes and kills the older loading process', async t => {
  const path = await directory(t), slow = join(path, 'slow.gguf'), next = join(path, 'next.gguf');
  const r = new SwitchableRecognizer(null, { workerScript }); t.after(() => r.close());
  const first = r.switchTo(slow); await until(async () => (await pids(slow)).length === 1);
  const second = r.switchTo(next);
  assert.equal(await first, false); assert.equal(await second, true);
  assert.equal(r.modelPath, next); assert.ok((await pids(slow)).every(gone));
});

test('a preflight worker exiting after ready cannot replace the old worker or fail the next queued chunk', async t => {
  const path = await directory(t), old = join(path, 'old.gguf'), fragile = join(path, 'fragile.gguf');
  const r = new SwitchableRecognizer(old, { workerScript }); t.after(() => r.close());
  const first = r.transcribe(chunk(.6));
  const failed = assert.rejects(r.switchTo(fragile), /exited before the switch/);
  await sleep(300);
  const second = r.transcribe(chunk());
  await first; await failed;
  assert.match((await second).text, /^old.gguf:/);
});

test('close cancels test loading and leaves no child pids', async t => {
  const path = await directory(t), current = join(path, 'old.gguf'), slow = join(path, 'never.gguf');
  const r = new SwitchableRecognizer(current, { workerScript });
  await r.transcribe(chunk());
  const changing = r.switchTo(slow); await until(async () => (await pids(slow)).length === 1);
  await assert.doesNotReject(r.close()); assert.equal(await changing, false); await r.close();
  assert.ok([...(await pids(current)), ...(await pids(slow))].every(gone));
});

test('close during transcription keeps the running disk record recoverable', async t => {
  const path = await directory(t), model = join(path, 'old.gguf');
  const store = new MeetingStore(path), meeting = store.createMeeting('Example');
  store.addMedia(meeting.id, '/unused.wav', 10);
  const r = new SwitchableRecognizer(model, { workerScript }), jobs = new JobManager(store, r);
  jobs.kick(); await until(async () => (await pids(model)).length === 1);
  await jobs.close(); assert.equal(store.chunks(meeting.id)[0].status, 'running');
  assert.ok((await pids(model)).every(gone)); store.close();
  const reopened = new MeetingStore(path);
  try { assert.equal(reopened.chunks(meeting.id)[0].status, 'queued'); } finally { reopened.close(); }
});

test('API failed switch reports one line, rolls back saved choice, and old finals still work', async t => {
  const f = await api(t, {}, async path => {
    const initial = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await writeFile(join(path, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await model(join(path, 'models/broken.gguf'), { name: 'Example broken' });
  });
  const original = (await f.get('/api/status')).config.path;
  const response = await f.use('Example broken'); assert.equal(response.rows[0].pending.applies, 'loading');
  await until(async () => Boolean((await f.get()).rows[0].switchError));
  await until(async () => (await f.get('/api/settings')).speechModelPath === original);
  assert.match((await f.get()).rows[0].switchError, /^[^\r\n]+$/);
  assert.equal((await f.get()).restartNeeded, false);
  assert.equal((await f.get('/api/status')).config.path, original);
  const m = f.app.store.createMeeting('Example'); f.app.store.addMedia(m.id, '/unused.wav', .02); f.app.jobs.kick();
  await f.app.jobs.wait(); assert.match(f.app.store.chunks(m.id)[0].text, /^old.gguf:/);
});

test('API rapid choices keep only the latest saved/running model and kill the older preflight', async t => {
  const f = await api(t, {}, async path => {
    const initial = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await writeFile(join(path, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await model(join(path, 'models/slow.gguf'), { name: 'Example slow' });
    await model(join(path, 'models/next.gguf'), { name: 'Example next' });
  });
  await f.use('Example slow');
  const slow = join(f.path, 'models/slow.gguf'), next = join(f.path, 'models/next.gguf');
  await until(async () => (await pids(slow)).length === 1);
  await f.use('Example next'); await until(async () => !(await f.get()).rows[0].pending);
  assert.equal((await f.get('/api/status')).config.path, next);
  assert.equal((await f.get('/api/settings')).speechModelPath, next);
  assert.ok((await pids(slow)).every(gone));
});

test('a recording begun during test load also defers the swap without pausing old finals', async t => {
  const f = await api(t, {}, async path => {
    const initial = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await writeFile(join(path, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await model(join(path, 'models/slow.gguf'), { name: 'Example slow' });
  });
  await f.use('Example slow');
  const m = f.app.store.createMeeting('Example'), source = `mic:${randomUUID()}`;
  await f.app.capture.accept(m.id, source, 0, 0, Buffer.alloc(64));
  await until(async () => (await f.get()).rows[0].pending?.applies === 'after recording');
  const other = f.app.store.createMeeting('Old final'); f.app.store.addMedia(other.id, '/unused.wav', .02);
  f.app.jobs.kick(); await f.app.jobs.wait();
  assert.match(f.app.store.chunks(other.id)[0].text, /^old.gguf:/);
  await f.app.capture.end(m.id, source, 0);
  await until(async () => !(await f.get()).rows[0].pending, 5000);
  assert.match((await f.get('/api/status')).config.path, /slow.gguf$/);
});

test('failed switch restores null when the running model was auto-chosen', async t => {
  const f = await api(t, {}, async path => {
    await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await model(join(path, 'broken.gguf'), { name: 'Example broken' });
  });
  // Choose-file can reach files not found in the models folder.
  const pickerPath = join(f.path, 'models/broken.gguf');
  await model(pickerPath, { name: 'Example broken' }); await f.post('/api/setup/recheck');
  await f.use('Example broken'); await until(async () => Boolean((await f.get()).rows[0].switchError));
  assert.equal((await f.get('/api/settings')).speechModelPath, null);
});

test('no startup model: completed download wakes queued jobs and enables PCM/import/replay endpoints', async t => {
  const content = gguf({ name: 'Example downloaded' });
  const server = createServer((_req, res) => { res.end(content); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await api(t, { download: { url: `http://127.0.0.1:${address.port}`, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 } });
  const meeting = f.app.store.createMeeting('Example'), id = meeting.id;
  f.app.store.addMedia(id, '/unused.wav', .02); f.app.jobs.kick(); await f.app.jobs.wait();
  assert.equal(f.app.store.chunks(id)[0].status, 'queued');
  assert.equal((await f.post(`/api/meetings/${id}/retry`)).status, 400);
  assert.equal((await f.request(`/api/meetings/${id}/upload`, { method: 'POST', body: '' })).status, 400);
  await f.post('/api/setup/speech/download', { use: true });
  await until(() => f.app.store.chunks(id)[0].status === 'completed');
  assert.equal((await f.get()).restartNeeded, false);
  assert.equal((await f.get('/api/status')).config.available, true);
  assert.equal((await f.post(`/api/meetings/${id}/retry`)).status, 200);
  assert.equal((await f.post(`/api/meetings/${id}/replay`)).status, 200);
  // Empty media still fails validation, but no longer at the missing-model gate.
  const upload = await f.request(`/api/meetings/${id}/upload`, { method: 'POST', body: '' });
  assert.notEqual((await upload.json()).error, 'No local model is available.');
  const live = f.app.store.createMeeting('Example live');
  const pcm = await f.request(`/api/meetings/${live.id}/pcm`, { method: 'POST', body: Buffer.alloc(64), headers: {
    'X-Audio-Source': `mic:${randomUUID()}`, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
  } }); assert.equal(pcm.status, 201);
});

test('recording defers switch, then applies within 5 seconds; non-streaming finals work', async t => {
  const f = await api(t, {}, async path => {
    await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await model(join(path, 'models/whisper.gguf'), { name: 'Example whisper', family: 'whisper' });
  });
  const meeting = f.app.store.createMeeting('Example'), source = `mic:${randomUUID()}`;
  const pcm = new Float32Array(16000); pcm[0] = 1;
  await f.app.capture.accept(meeting.id, source, 0, 0, Buffer.from(pcm.buffer));
  await until(() => f.drafts.drafts(meeting.id)[0]?.text === 'w1');
  const original = (await f.get('/api/status')).config.path;
  const response = await f.use('Example whisper');
  assert.deepEqual(response.rows[0].pending, { path: join(f.path, 'models/whisper.gguf'), applies: 'after recording' });
  await sleep(1100); assert.equal((await pids(join(f.path, 'models/whisper.gguf'))).length, 0);
  pcm[0] = 2; await f.app.capture.accept(meeting.id, source, 1, 1000, Buffer.from(pcm.buffer));
  await until(() => f.drafts.drafts(meeting.id)[0]?.text === 'w1 w2');
  assert.equal((await f.get('/api/status')).config.path, original);
  await f.app.capture.end(meeting.id, source, 1);
  await until(async () => !(await f.get()).rows[0].pending, 5000);
  assert.equal(f.drafts.begin(meeting.id, 'mic:new', 'new-window', 2000), false);
  const status = await f.get('/api/status'); assert.equal(status.config.streaming, false); assert.match(status.sttBackend, /whisper/);
  await f.app.jobs.wait();
  const next = f.app.store.createMeeting('Next'); f.app.store.addMedia(next.id, '/unused.wav', .02); f.app.jobs.kick(); await f.app.jobs.wait();
  assert.match(f.app.store.chunks(next.id)[0].text, /^whisper.gguf:/);
});

test('draft model changes preserve the open window and disable non-streaming new windows', async t => {
  const path = await directory(t), old = join(path, 'old'), next = join(path, 'next');
  const drafts = new LiveDrafts({ modelPath: old, workerScript: new URL('./fixtures/switch-stream-worker.ts', import.meta.url) });
  const feed = (window: string, n: number) => { const pcm = new Float32Array(16000); pcm[0] = n; drafts.feed(window, pcm); };
  try {
    assert.equal(drafts.begin('m', 'mic:a', 'w0', 0), true); feed('w0', 1); await sleep(300);
    drafts.setModel(next, true); feed('w0', 2); await until(() => drafts.drafts('m')[0].text === 'old:w1 w2');
    assert.deepEqual(await pids(next), [], 'setModel does not replace the open window worker');
    drafts.drop('w0'); assert.equal(drafts.begin('m', 'mic:a', 'w1', 2000), true); feed('w1', 3);
    await until(() => drafts.drafts('m')[0].text === 'next:w3');
    await until(async () => (await pids(old)).every(gone));
    drafts.setModel('whisper', false); feed('w1', 4); await until(() => drafts.drafts('m')[0].text === 'next:w3 w4');
    drafts.drop('w1'); assert.equal(drafts.begin('m', 'mic:a', 'w2', 4000), false);
    drafts.setModel(null, false); assert.equal(drafts.begin('m', 'mic:b', 'w3', 0), false);
  } finally { await drafts.close(); }
});

test('FFmpeg rediscovery recycles same model, inherits paths, and clears restart need', async t => {
  let found = false;
  const before = process.env.MEETING_FFMPEG; delete process.env.MEETING_FFMPEG;
  t.after(() => { if (before === undefined) delete process.env.MEETING_FFMPEG; else process.env.MEETING_FFMPEG = before; });
  const f = await api(t, { ffmpeg: async () => found ? { found: true, ffmpeg: '/fictional/ffmpeg', ffprobe: '/fictional/ffprobe' } : { found: false } }, async path => {
    await model(join(path, 'models/old.gguf'));
  });
  const m = f.app.store.createMeeting('Example'); f.app.store.addMedia(m.id, '/unused.wav', .02); f.app.jobs.kick(); await f.app.jobs.wait();
  const path = join(f.path, 'models/old.gguf'), old = (await pids(path))[0];
  found = true; await f.post('/api/setup/recheck');
  await until(async () => !(await f.get()).rows[0].pending);
  assert.ok(gone(old)); assert.equal((await pids(path)).length, 2);
  const n = f.app.store.createMeeting('Next'); f.app.store.addMedia(n.id, '/unused.wav', .02); f.app.jobs.kick(); await f.app.jobs.wait();
  assert.equal(f.app.store.chunks(n.id)[0].text, 'old.gguf:/fictional/ffmpeg');
  assert.equal((await f.get()).restartNeeded, false);
});

for (const recording of [false, true]) test(`server shutdown cancels ${recording ? 'pending' : 'loading'} switch`, async t => {
  const f = await api(t, {}, async path => {
    const initial = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await writeFile(join(path, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await model(join(path, 'models/never.gguf'), { name: 'Example never' });
  });
  if (recording) {
    const m = f.app.store.createMeeting('Example'); await f.app.capture.accept(m.id, `mic:${randomUUID()}`, 0, 0, Buffer.alloc(64));
  }
  await f.use('Example never');
  const path = join(f.path, 'models/never.gguf');
  if (!recording) await until(async () => (await pids(path)).length === 1);
  await f.app.close();
  assert.ok((await pids(path)).every(gone));
  if (recording) assert.deepEqual(await pids(path), []);
  assert.ok((await pids(join(f.path, 'models/old.gguf'))).every(gone));
});
