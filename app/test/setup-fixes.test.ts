import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { ModelDownload, type DownloadOptions, type DownloadState } from '../src/setup/model-download.ts';
import { SpeechModels } from '../src/setup/speech-models.ts';
import { SpeechSetup, type SetupOptions } from '../src/setup/service.ts';
import { checkFfmpeg } from '../src/setup/ffmpeg.ts';
import { model, gguf } from './helpers/gguf.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function waitFor(condition: () => boolean | Promise<boolean>) {
  const until = Date.now() + 3000;
  while (!await condition()) { if (Date.now() > until) throw new Error('Condition did not arrive.'); await new Promise(r => setTimeout(r, 2)); }
}
async function directory(t: TestContext, cleanup = true) {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'setup-fix-')));
  if (cleanup) t.after(() => fs.rm(path, { recursive: true, force: true })); return path;
}
function scanOptions(path: string) { return { directory: path, home: join(path, 'home'), envModelPath: null, hfHome: null }; }
async function setupFixture(t: TestContext, options: SetupOptions = {}, saved: string | null = null, path?: string) {
  const ownsDirectory = !path;
  path ??= await directory(t, false);
  let settings = { speechModelPath: saved, setupSeen: false };
  const setup = new SpeechSetup(path, () => settings, async change => { settings = { ...settings, ...change }; }, {
    ...options, scan: { ...scanOptions(path), ...options.scan }, ffmpeg: options.ffmpeg ?? (async () => ({ found: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })),
  });
  await setup.initialize(); t.after(async () => { await setup.download.close(); if (ownsDirectory) await fs.rm(path!, { recursive: true, force: true }); });
  return { setup, reset: () => { settings = { ...settings, speechModelPath: null }; } };
}
function restoreEnv(t: TestContext) {
  const original = { MEETING_FFMPEG: process.env.MEETING_FFMPEG, MEETING_FFPROBE: process.env.MEETING_FFPROBE };
  delete process.env.MEETING_FFMPEG; delete process.env.MEETING_FFPROBE;
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function apiFixture(t: TestContext) {
  const path = await directory(t, false);
  const app = await startServer({ directory: path, port: 0, recognizer: null, quick: null, heavy: null,
    setup: { scan: scanOptions(path), ffmpeg: async () => ({ found: true }) } });
  // Also release the old implementation's leaked resources if a regression assertion fails.
  t.after(async () => { await app.close().catch(() => { app.store.close(); }); await fs.rm(join(path, 'server.lock'), { force: true }); await fs.rm(path, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const put = (value: unknown) => fetch(`${app.url}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { app, path, put };
}
const content = gguf({ name: 'Example downloaded', padding: 1024 });
async function downloadFixture(t: TestContext, extra: Partial<DownloadOptions> = {}) {
  const path = await directory(t, false);
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Length': content.length }); res.end(content); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { directory: path, url: `http://127.0.0.1:${address.port}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12, ...extra };
  const job = new ModelDownload(options); await job.ready;
  t.after(async () => { await job.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(path, { recursive: true, force: true }); });
  return { job, options, requests: () => requests };
}

test('fix 1: settings API rejects speechModelPath, including mixed updates', async t => {
  const f = await apiFixture(t);
  for (const value of [{ speechModelPath: '/fictional/model.gguf' }, { speechModelPath: null }, { speechModelPath: '/fictional/model.gguf', setupSeen: true }]) {
    assert.equal((await f.put(value)).status, 400);
  }
  assert.equal((await f.put({ setupSeen: true })).status, 200);
  assert.equal(JSON.parse(await fs.readFile(join(f.path, 'settings.json'), 'utf8')).speechModelPath, null);
});

test('fix 2: valid environment choice ignores a missing saved choice', async t => {
  const path = await directory(t), env = await model(join(path, 'env.gguf'));
  const result = await new SpeechModels().scan({ ...scanOptions(path), envModelPath: env, savedPath: join(path, 'gone.gguf') });
  assert.equal(result.config.path, env); assert.equal(result.missingPath, undefined);
});

test('fix 3: clearing a previously saved choice reports the true next model and restart', async t => {
  const path = await directory(t);
  const saved = await model(join(path, 'models/whisper.gguf'), { family: 'whisper', name: 'Example saved' });
  const automatic = await model(join(path, 'models/parakeet.gguf'), { name: 'Example automatic' });
  const f = await setupFixture(t, {}, saved, path);
  f.reset(); await f.setup.recheck();
  assert.equal(f.setup.scan.config.path, automatic); assert.equal(f.setup.restartNeeded, true);
});

for (const state of ['idle', 'done', 'damaged', 'noSpace'] as const) test(`fix 4: pause and cancel leave inactive ${state} unchanged`, async t => {
  const f = await downloadFixture(t);
  const original: DownloadState = state === 'done' ? { state, path: f.job.path } : state === 'noSpace' ? { state, neededBytes: 100 } : { state };
  f.job.state = original;
  await f.job.pause(); assert.deepEqual(f.job.state, original);
  await f.job.cancel(); assert.deepEqual(f.job.state, original);
});
for (const state of ['paused', 'interrupted'] as const) test(`fix 4: inactive ${state} is preserved by pause and deleted by cancel`, async t => {
  const f = await downloadFixture(t);
  await fs.mkdir(join(f.options.directory, 'models')); await fs.writeFile(f.job.part, content.subarray(0, 7));
  const original: DownloadState = state === 'paused' ? { state, bytes: 7 } : { state, bytes: 7, reason: 'Example lost connection.' };
  f.job.state = original;
  await f.job.pause(); assert.deepEqual(f.job.state, original);
  await f.job.cancel(); assert.deepEqual(f.job.state, { state: 'idle' }); assert.equal(await fs.stat(f.job.part).catch(() => null), null);
});

test('fix 5: cancel racing a finishing download preserves done', async t => {
  const entered = deferred(), release = deferred();
  const f = await downloadFixture(t, { onDone: async () => { entered.resolve(); await release.promise; } });
  const work = f.job.start(); await entered.promise;
  const cancel = f.job.cancel(); release.resolve(); await Promise.all([work, cancel]);
  assert.deepEqual(f.job.state, { state: 'done', path: f.job.path }); assert.deepEqual(await fs.readFile(f.job.path), content);
});

test('fix 6: transfer requests share one job and resume reports its completed path, not a selection hint', async t => {
  const entered = deferred(), release = deferred(); let completed: string | undefined;
  const f = await downloadFixture(t, { freeSpace: async () => { entered.resolve(); await release.promise; return 1e12; }, onDone: async path => { completed = path; } });
  const first = f.job.start(); await entered.promise;
  assert.equal(f.job.start(), first); assert.equal(f.job.start(), first);
  release.resolve(); await first; assert.equal(completed, f.job.path);
  // Selection now belongs to SpeechSetup's intent, not to a sticky flag on a transfer attempt.
  const resumed = deferred(), resumeSpace = deferred(); let resumedPath: string | undefined;
  const second = await downloadFixture(t, {
    freeSpace: async () => { resumed.resolve(); await resumeSpace.promise; return 1e12; },
    onDone: async path => { resumedPath = path; },
  });
  const work = second.job.start(); await resumed.promise;
  const pause = second.job.pause(); resumeSpace.resolve(); await Promise.all([work, pause]);
  await second.job.start(); assert.equal(resumedPath, second.job.path);
});

test('fix 7: a post-rename callback failure keeps done and logs the failure', async t => {
  const warnings: unknown[][] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const f = await downloadFixture(t, { onDone: async () => { throw new Error('Example settings failure'); } });
  await f.job.start(); assert.equal(f.job.state.state, 'done'); assert.deepEqual(await fs.readFile(f.job.path), content);
  assert.match(warnings.flat().join(' '), /Example settings failure/);
});

test('fix 8: an oversized part appearing after initialization restarts from zero', async t => {
  const f = await downloadFixture(t);
  await fs.mkdir(join(f.options.directory, 'models')); await fs.writeFile(f.job.part, Buffer.alloc(content.length + 1));
  await f.job.start(); assert.equal(f.job.state.state, 'done'); assert.equal(f.requests(), 1);
  assert.deepEqual(await fs.readFile(f.job.path), content);
});

test('fix 9: close prevents queued and future starts from outliving the owner', async t => {
  const entered = deferred(), release = deferred(); let checks = 0;
  const f = await downloadFixture(t, { freeSpace: async () => { checks++; entered.resolve(); await release.promise; return 1e12; } });
  const first = f.job.start(); await entered.promise;
  const cancelled = f.job.cancel(), queued = f.job.start(), closed = f.job.close(); release.resolve();
  await Promise.all([first, cancelled, queued, closed]); await f.job.start();
  assert.equal(checks, 1); assert.equal(f.requests(), 0); assert.equal(await fs.stat(f.job.path).catch(() => null), null);
});

test('fix 10: a failed settings save does not prevent database and lock cleanup', async t => {
  const f = await apiFixture(t), rename = fs.rename;
  t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (String(to) === join(f.path, 'settings.json')) throw Object.assign(new Error('Example full disk'), { code: 'ENOSPC' });
    return rename(from, to);
  }); syncBuiltinESMExports();
  try { assert.equal((await f.put({ setupSeen: true })).status, 400); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await assert.doesNotReject(f.app.close());
  assert.equal(await fs.stat(join(f.path, 'server.lock')).catch(() => null), null);
  assert.throws(() => f.app.store.db.prepare('SELECT 1'));
});

test('fix 11: slow opendir is bounded and its late directory handle is closed', async t => {
  const path = await directory(t), original = fs.opendir;
  await fs.mkdir(join(path, 'models'));
  const entered = deferred(), release = deferred(), closed = deferred();
  let now = 0, lateReturned = false;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (String(args[0]) === join(path, 'models')) {
      const dir = await original(...args), close = dir.close.bind(dir);
      dir.close = (async () => { await close(); closed.resolve(); }) as typeof dir.close;
      entered.resolve();
      await release.promise;
      lateReturned = true;
      return dir;
    }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const pending = new SpeechModels().scan({ ...scanOptions(path), maxScanMs: 30 });
    await entered.promise; // Only expire the budget once opendir really is in flight.
    now = 30; t.mock.timers.tick(30);
    const scan = await pending;
    assert.equal(lateReturned, false, 'scan returns before delayed opendir');
    assert.equal(scan.truncated, true);
    release.resolve();
    await closed.promise;
  } finally { release.resolve(); t.mock.timers.reset(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('fix 11: slow file stat is bounded by the scan deadline', async t => {
  const path = await directory(t), selected = await model(join(path, 'model.gguf')), original = fs.stat;
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    if (String(args[0]) === selected) await new Promise(r => setTimeout(r, 250));
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const started = performance.now();
    const scan = await new SpeechModels().scan({ ...scanOptions(path), envModelPath: selected, maxScanMs: 30 });
    assert.ok(performance.now() - started < 180, 'scan returns before delayed stat'); assert.equal(scan.truncated, true);
  } finally { await new Promise(r => setTimeout(r, 280)); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const kind of ['FIFO', 'oversized'] as const) test(`fix 11: Pi Voice ${kind} settings are skipped without reading`, async t => {
  const path = await directory(t), voice = join(path, 'home/.pi/agent/pi-voice.json');
  await fs.mkdir(join(path, 'home/.pi/agent'), { recursive: true });
  if (kind === 'FIFO') execFileSync('mkfifo', [voice]); else await fs.writeFile(voice, Buffer.alloc(1024 * 1024 + 1));
  let reads = 0, opens = 0; const original = fs.readFile, open = fs.open;
  // Avoid blocking the pre-fix implementation; the assertion detects the unsafe read.
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === voice) { reads++; return '{}'; }
    return original(...args);
  });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === voice) { opens++; throw new Error('Unsafe configuration open.'); }
    return open(...args);
  }); syncBuiltinESMExports();
  try { await new SpeechModels().scan(scanOptions(path)); assert.equal(reads, 0); assert.equal(opens, 0); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('fix 12: finishing a download forces a fresh scan after an older recheck', async t => {
  const f = await downloadFixture(t), path = f.options.directory;
  await model(join(path, 'models/existing.gguf'), { name: 'Example existing' });
  const entered = deferred(), release = deferred(), scanned = deferred(); let block = false;
  const { setup } = await setupFixture(t, { download: f.options, ffmpeg: async () => {
    if (block) { block = false; entered.resolve(); await release.promise; } return { found: true };
  } }, null, path);
  const original = setup.scanner.scan.bind(setup.scanner);
  t.mock.method(setup.scanner, 'scan', async (...args: Parameters<typeof original>) => { const result = await original(...args); scanned.resolve(); return result; });
  block = true;
  const recheck = setup.recheck(); await entered.promise; await scanned.promise;
  const download = setup.download.start();
  await waitFor(async () => Boolean(await fs.stat(setup.download.path).catch(() => null)));
  // Let onDone enter recheck while the older check is still held.
  await new Promise(r => setTimeout(r, 10)); release.resolve(); await Promise.all([recheck, download]);
  assert.equal(setup.download.state.state, 'done');
  assert.ok(setup.models().models.some(m => m.name === 'Example downloaded'));
});

test('fix 13: discovering new decoder paths reports restart needed for existing workers', async t => {
  restoreEnv(t); let found = false;
  const { setup } = await setupFixture(t, { ffmpeg: async () => found ? { found: true, ffmpeg: '/fictional/brew/ffmpeg', ffprobe: '/fictional/brew/ffprobe' } : { found: false } });
  assert.equal(setup.restartNeeded, false);
  found = true; await setup.recheck(); assert.equal(setup.ffmpeg.found, true); assert.equal(setup.restartNeeded, true);
});

test('fix 14: app-owned decoder overrides are cleared before rediscovery', async t => {
  restoreEnv(t); let fallback = true;
  // The runner is fictional; isolate the new filesystem PATH lookup from the owner's installed binaries too.
  const emptyPath = await directory(t);
  const { setup } = await setupFixture(t, { ffmpeg: async env => checkFfmpeg({ env: { ...env, PATH: emptyPath }, fallbackFolders: ['/fictional/brew'], run: async command => {
    if (fallback ? !command.startsWith('/fictional/brew/') : command.includes('/')) throw Object.assign(new Error('Example missing binary'), { code: 'ENOENT' });
  } }) });
  assert.equal(process.env.MEETING_FFMPEG, '/fictional/brew/ffmpeg');
  fallback = false; await setup.recheck();
  assert.equal(setup.ffmpeg.found, true); assert.equal(setup.ffmpeg.ffmpeg, 'ffmpeg');
  assert.equal(process.env.MEETING_FFMPEG, undefined); assert.equal(process.env.MEETING_FFPROBE, undefined);
});

test('fix 14: user-owned decoder overrides are never overwritten', async t => {
  restoreEnv(t); process.env.MEETING_FFMPEG = '/fictional/user/ffmpeg'; process.env.MEETING_FFPROBE = '/fictional/user/ffprobe';
  const { setup } = await setupFixture(t, { ffmpeg: async () => ({ found: true, ffmpeg: '/fictional/other/ffmpeg', ffprobe: '/fictional/other/ffprobe' }) });
  await setup.recheck();
  assert.equal(process.env.MEETING_FFMPEG, '/fictional/user/ffmpeg'); assert.equal(process.env.MEETING_FFPROBE, '/fictional/user/ffprobe');
});
