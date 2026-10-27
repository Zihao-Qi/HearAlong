import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { type SetupOptions } from '../src/setup/service.ts';
import { model, gguf } from './helpers/gguf.ts';

async function fixture(t: any, setup: SetupOptions = {}, prepare?: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'setup-api-')));
  await prepare?.(directory);
  const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8').catch(() => '{}'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'cloud', cloudConsent: { providers: ['example'], time: 1 }, ...saved }));
  const options = { directory, port: 0, quick: null, heavy: null, drafts: null,
    setup: { worker: { workerScript: new URL('./fixtures/switch-worker.ts', import.meta.url) }, ...setup, scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null, ...setup.scan }, ffmpeg: setup.ffmpeg ?? (async () => ({ found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })) } };
  const app = await startServer(options);
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}${path}`, { ...options, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...options.headers } });
  await request('/api/setup/ai/models'); // Settle the fake Pi's initial catalog read.
  const get = async (path = '/api/setup') => { const response = await request(path); assert.equal(response.status, 200); return response.json(); };
  const post = (path: string, value: unknown = {}) => request(path, { method: 'POST', body: JSON.stringify(value) });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, app, options, request, get, post };
}
async function waitFor(test: () => Promise<boolean>) { const deadline = Date.now() + 10_000; while (!await test()) { if (Date.now() > deadline) throw new Error('Setup did not settle.'); await new Promise(r => setTimeout(r, 10)); } }

test('setup API returns keyed rows and stable status config fields', async t => {
  const f = await fixture(t, {}, async directory => { await model(join(directory, 'models/example.gguf')); });
  const setup = await f.get(); assert.equal(setup.seen, false); assert.equal(setup.restartNeeded, false);
  assert.deepEqual(setup.rows.map((r: any) => [r.id, r.needed, r.state]), [['speech', true, 'ready'], ['ffmpeg', true, 'found'], ['ai', false, 'signed-out']]);
  const { config } = await f.get('/api/status');
  assert.equal(config.available, true); assert.equal(config.name, 'Example speech'); assert.equal(config.streaming, true);
  for (const key of ['available', 'path', 'source', 'bytes', 'error']) assert.ok(key in config);
  const models = await f.get('/api/setup/speech-models'); assert.equal(models.models[0].inUse, true); assert.equal(models.truncated, false);
});

test('/api/status with MEETING_MODEL_PATH missing stays unavailable even when a model exists', async t => {
  const previous = process.env.MEETING_MODEL_PATH;
  process.env.MEETING_MODEL_PATH = '/fictional/missing.gguf';
  t.after(() => { if (previous === undefined) delete process.env.MEETING_MODEL_PATH; else process.env.MEETING_MODEL_PATH = previous; });
  const f = await fixture(t, { scan: { envModelPath: undefined } }, async directory => { await model(join(directory, 'models/example.gguf')); });
  const { config } = await f.get('/api/status'); assert.equal(config.available, false); assert.equal(config.path, '/fictional/missing.gguf');
  const row = (await f.get()).rows[0]; assert.equal(row.state, 'missing'); assert.equal(row.missingPath, config.path);
});

test('setup API reports a missing saved choice while startup falls back', async t => {
  const f = await fixture(t, {}, async directory => {
    await model(join(directory, 'models/example.gguf'));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ speechModelPath: '/fictional/gone.gguf' }));
  });
  assert.equal((await f.get('/api/status')).config.available, true);
  const row = (await f.get()).rows[0]; assert.equal(row.state, 'missing'); assert.equal(row.missingPath, '/fictional/gone.gguf');
});

test('setup API none and FFmpeg missing rows', async t => {
  const f = await fixture(t, { ffmpeg: async () => ({ found: false, error: 'Missing tools.' }) });
  assert.deepEqual((await f.get()).rows.map((r: any) => r.state), ['none', 'missing', 'signed-out']);
});

test('setup POST endpoints all require the dashboard origin and session', async t => {
  const f = await fixture(t);
  for (const path of ['speech/use', 'speech/choose-file', 'speech/download', 'speech/pause', 'speech/cancel', 'recheck', 'seen']) {
    const response = await f.request(`/api/setup/${path}`, { method: 'POST', body: '{}', headers: { Origin: 'https://other.example' } });
    assert.equal(response.status, 403, path);
  }
  assert.equal((await fetch(`${f.app.url}/api/setup`)).status, 403);
  assert.equal((await f.request('/api/setup', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('setup use persists choice and updates running config after asynchronous load', async t => {
  const f = await fixture(t, {}, async directory => {
    await model(join(directory, 'models/a.gguf'), { name: 'Example first' });
    await model(join(directory, 'models/b.gguf'), { name: 'Example next', family: 'whisper' });
  });
  const original = (await f.get('/api/status')).config;
  const next = (await f.get('/api/setup/speech-models')).models.find((m: any) => m.name === 'Example next');
  const response = await f.post('/api/setup/speech/use', { id: next.id }); assert.equal(response.status, 200);
  assert.equal((await response.json()).restartNeeded, false);
  assert.equal((await f.get('/api/status')).config.path, original.path);
  assert.equal((await f.get('/api/settings')).speechModelPath, next.chosenFile.path);
  const settings = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')); assert.equal(settings.speechModelPath, next.chosenFile.path);
  await waitFor(async () => !(await f.get()).rows[0].pending);
  assert.equal((await f.get('/api/status')).config.path, next.chosenFile.path);
  const models = (await f.get('/api/setup/speech-models')).models;
  assert.equal(models.find((m: any) => m.name === 'Example first').inUse, false);
  assert.equal(models.find((m: any) => m.name === 'Example next').inUse, true);
});

test('setup use is allowed during live capture and waits for recording to stop', async t => {
  const f = await fixture(t, {}, async directory => {
    const initial = await model(join(directory, 'models/a.gguf'));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await model(join(directory, 'models/b.gguf'), { name: 'Example next' });
  });
  const meeting = f.app.store.createMeeting('Example meeting'), source = `mic:${randomUUID()}`;
  // The actual PCM endpoint establishes recording ownership, as it does for the dashboard.
  const pcm = await f.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64_000), headers: {
    'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
  } }); assert.equal(pcm.status, 201);
  const next = (await f.get('/api/setup/speech-models')).models.find((m: any) => m.name === 'Example next');
  assert.equal((await f.post('/api/setup/speech/use', { id: next.id })).status, 200);
  assert.equal((await f.get()).restartNeeded, false); assert.equal((await f.get('/api/status')).recording, true);
  assert.equal((await f.get()).rows[0].pending.applies, 'after recording');
});

test('setupSeen persists across server starts and other settings are preserved', async t => {
  const f = await fixture(t);
  await f.request('/api/settings', { method: 'PUT', body: JSON.stringify({ miniOpensItself: true }) });
  assert.equal((await f.post('/api/setup/seen')).status, 200); assert.equal((await f.get()).seen, true);
  await f.app.close();
  const restarted = await startServer(f.options);
  try {
    const cookie = (await fetch(restarted.url)).headers.get('set-cookie')!.split(';')[0];
    const settings = await (await fetch(`${restarted.url}/api/settings`, { headers: { Cookie: cookie } })).json();
    assert.equal(settings.setupSeen, true); assert.equal(settings.miniOpensItself, true);
  } finally { await restarted.close(); }
});

test('setup validates settings, model ids and download inputs with readable 400 errors', async t => {
  const f = await fixture(t);
  for (const value of [{ speechModelPath: 3 }, { speechModelPath: '' }, { setupSeen: 'yes' }, null]) assert.equal((await f.request('/api/settings', { method: 'PUT', body: JSON.stringify(value) })).status, 400);
  for (const value of [{}, { id: 3 }, { id: 'gone' }, null]) {
    const response = await f.post('/api/setup/speech/use', value); assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error, 'string');
  }
  for (const value of [{ use: 'yes' }, null, []]) assert.equal((await f.post('/api/setup/speech/download', value)).status, 400);
});

test('setup picker cancelled makes no change; unsupported and non-GGUF selections get a one-line 400', async t => {
  let selected: string | null = null;
  const f = await fixture(t, { picker: async () => selected });
  assert.deepEqual(await (await f.post('/api/setup/speech/choose-file')).json(), { cancelled: true });
  selected = join(f.directory, 'not.gguf'); await writeFile(selected, 'not a model');
  let response = await f.post('/api/setup/speech/choose-file'); assert.equal(response.status, 400); assert.match((await response.json()).error, /^Not a speech model HearAlong can run: [^\n]+$/);
  selected = await model(join(f.directory, 'llm.gguf'), { family: 'llama' });
  response = await f.post('/api/setup/speech/choose-file'); assert.equal(response.status, 400);
  selected = await model(join(f.directory, 'chosen.gguf'));
  response = await f.post('/api/setup/speech/choose-file'); assert.equal(response.status, 200); assert.equal((await response.json()).restartNeeded, false);
});

test('setup picker permits only one native dialog at a time', async t => {
  let finish!: (path: null) => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture(t, { picker: async () => { began(); return new Promise(resolve => { finish = resolve; }); } });
  const first = f.post('/api/setup/speech/choose-file'); await started;
  assert.equal((await f.post('/api/setup/speech/choose-file')).status, 400);
  finish(null); assert.deepEqual(await (await first).json(), { cancelled: true });
});

test('setup a concurrent recheck cannot lose a newly saved model choice', async t => {
  let block = false, release!: () => void, began!: () => void;
  const entered = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture(t, { ffmpeg: async () => {
    if (block) { block = false; began(); await new Promise<void>(resolve => { release = resolve; }); }
    return { found: true };
  } }, async directory => {
    await model(join(directory, 'models/a.gguf'));
    await model(join(directory, 'models/b.gguf'), { name: 'Example next', family: 'whisper' });
  });
  const next = (await f.get('/api/setup/speech-models')).models.find((m: any) => m.name === 'Example next');
  block = true;
  const recheck = f.post('/api/setup/recheck'); await entered;
  assert.equal((await f.get()).rows[0].state, 'scanning');
  const choose = f.post('/api/setup/speech/use', { id: next.id });
  await waitFor(async () => (await f.get('/api/settings')).speechModelPath === next.chosenFile.path);
  release(); await recheck;
  assert.equal((await (await choose).json()).restartNeeded, false);
  assert.equal((await f.get()).rows[0].path, next.chosenFile.path);
});

test('setup download controls, reload progress, and server shutdown keep the same job', async t => {
  const content = gguf({ name: 'Example download', padding: 256_000 });
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    let offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
    res.writeHead(offset ? 206 : 200, { 'Content-Length': content.length - offset,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${content.length - 1}/${content.length}` } : {}) });
    const timer = setInterval(() => { const end = Math.min(content.length, offset + 1024); res.write(content.subarray(offset, end)); offset = end; if (offset === content.length) { clearInterval(timer); res.end(); } }, 5);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(t, { download: { url: `http://127.0.0.1:${address.port}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 } });
  await Promise.all([f.post('/api/setup/speech/download'), f.post('/api/setup/speech/download')]);
  await waitFor(async () => (await f.get()).rows[0].download.bytes > 0);
  assert.equal(requests, 1);
  const reloadCookie = (await fetch(f.app.url)).headers.get('set-cookie')!.split(';')[0];
  const reloaded = await (await fetch(`${f.app.url}/api/setup`, { headers: { Cookie: reloadCookie } })).json();
  assert.equal(reloaded.rows[0].state, 'downloading'); assert.equal(reloaded.rows[0].download.total, content.length);
  assert.equal((await (await f.post('/api/setup/speech/pause')).json()).rows[0].state, 'paused');
  await f.post('/api/setup/speech/download');
  await waitFor(async () => requests === 2);
  assert.equal((await (await f.post('/api/setup/speech/cancel')).json()).rows[0].download.state, 'idle');
  const part = join(f.directory, 'models/parakeet-unified-en-0.6b-Q8_0.gguf.part');
  assert.equal(await stat(part).catch(() => null), null);
  await f.post('/api/setup/speech/download');
  await waitFor(async () => (await f.get()).rows[0].download.bytes > 0);
  await f.app.close();
  assert.ok((await stat(part)).size > 0);
  const restarted = await startServer(f.options);
  try {
    const cookie = (await fetch(restarted.url)).headers.get('set-cookie')!.split(';')[0];
    const setup = await (await fetch(`${restarted.url}/api/setup`, { headers: { Cookie: cookie } })).json();
    assert.equal(setup.rows[0].state, 'paused'); assert.ok(setup.rows[0].download.bytes > 0);
  } finally { await restarted.close(); }
});

test('setup recheck rescans models and reruns FFmpeg discovery', async t => {
  let found = false;
  const f = await fixture(t, { ffmpeg: async () => ({ found }) });
  await model(join(f.directory, 'models/new.gguf')); found = true;
  const response = await f.post('/api/setup/recheck'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows.map((r: any) => r.state), ['ready', 'found', 'signed-out']);
});

for (const existing of [false, true]) for (const use of [false, true]) test(`setup finished download saves choice if no running model or use=true (existing=${existing}, use=${use})`, async t => {
  const content = gguf({ name: 'Example downloaded', padding: 16_384 });
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Length': content.length }); res.end(content); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(t, { download: { url: `http://127.0.0.1:${address.port}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 } }, async directory => {
    if (existing) await model(join(directory, 'models/existing.gguf'), { name: 'Example existing' });
  });
  const response = await f.post('/api/setup/speech/download', { use }); assert.equal(response.status, 200);
  assert.equal((await response.json()).rows[0].state, 'downloading');
  await waitFor(async () => (await f.get()).rows[0].download.state === 'done');
  const settings = await f.get('/api/settings');
  assert.equal(Boolean(settings.speechModelPath), !existing || use);
  assert.equal((await f.get()).restartNeeded, false);
  await waitFor(async () => !(await f.get()).rows[0].pending);
  if (!existing || use) assert.equal((await f.get('/api/status')).config.path, settings.speechModelPath);
  assert.ok((await f.get('/api/setup/speech-models')).models.some((m: any) => m.name === 'Example downloaded'));
});
