import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { SpeechSetup, type SetupOptions } from '../src/setup/service.ts';
import { ModelDownload } from '../src/setup/model-download.ts';
import { SpeechModels } from '../src/setup/speech-models.ts';
import { ScanTimeout } from '../src/setup/deadline.ts';
import { readGguf } from '../src/setup/gguf.ts';
import { checkFfmpeg } from '../src/setup/ffmpeg.ts';
import { startServer } from '../src/server.ts';
import { model, gguf } from './helpers/gguf.ts';

const run = promisify(execFile);
const source = (path: string) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function waitFor(condition: () => boolean | Promise<boolean>, timeout = 1500) {
  const until = Date.now() + timeout;
  while (!await condition()) { if (Date.now() > until) throw new Error('Condition did not arrive.'); await new Promise(r => setTimeout(r, 2)); }
}
async function directory() { return fs.realpath(await fs.mkdtemp(join(tmpdir(), 'setup-round-two-'))); }
function scanOptions(path: string) { return { directory: path, home: join(path, 'home'), envModelPath: null, hfHome: null }; }
async function setupFixture(path: string, options: SetupOptions = {}) {
  let settings = { speechModelPath: null as string | null, setupSeen: false };
  const setup = new SpeechSetup(path, () => settings, async change => { settings = { ...settings, ...change }; }, {
    ...options, scan: scanOptions(path), ffmpeg: options.ffmpeg ?? (async () => ({ found: true })),
  });
  await setup.initialize(); return setup;
}
function restoreEnv(t: TestContext) {
  const original = { MEETING_FFMPEG: process.env.MEETING_FFMPEG, MEETING_FFPROBE: process.env.MEETING_FFPROBE };
  delete process.env.MEETING_FFMPEG; delete process.env.MEETING_FFPROBE;
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('round 2 item 1: recheck generations publish and resolve without waiting for later requests', async t => {
  const path = await directory(), gates: ReturnType<typeof deferred>[] = [];
  let hold = false, active = 0, peak = 0;
  const setup = await setupFixture(path, { ffmpeg: async () => {
    active++; peak = Math.max(peak, active);
    if (hold) { const gate = deferred(); gates.push(gate); await gate.promise; }
    active--; return { found: true };
  } });
  const pending: Promise<void>[] = [];
  t.after(async () => { hold = false; gates.forEach(g => g.resolve()); await Promise.allSettled(pending); await setup.download.close(); await fs.rm(path, { recursive: true, force: true }); });
  await model(join(path, 'models/example.gguf'));
  hold = true;
  let first = false, second = false, third = false;
  pending.push(setup.recheck().then(() => { first = true; })); await waitFor(() => gates.length === 1);
  pending.push(setup.recheck().then(() => { second = true; }));
  // Many callers during one pass must coalesce into just one next pass.
  for (let i = 0; i < 8; i++) pending.push(setup.recheck());
  gates[0].resolve(); await waitFor(() => gates.length === 2);
  await waitFor(() => first, 200);
  assert.equal(second, false); assert.equal(setup.models().models.length, 1);
  pending.push(setup.recheck().then(() => { third = true; }));
  gates[1].resolve(); await waitFor(() => gates.length === 3);
  await waitFor(() => second, 200); assert.equal(third, false);
  gates[2].resolve(); await Promise.all(pending);
  assert.equal(third, true); assert.equal(gates.length, 3); assert.equal(peak, 1);
});

test('round 2 item 2: a failed cancel remains an error for its caller but close drains it safely', async t => {
  const path = await directory();
  const job = new ModelDownload({ directory: path }); await job.ready;
  await fs.mkdir(join(path, 'models')); await fs.writeFile(job.part, 'example'); job.state = { state: 'paused', bytes: 7 };
  const original = fs.rm, entered = deferred(), release = deferred();
  t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === job.part) { entered.resolve(); await release.promise; throw Object.assign(new Error('Example unlink denied'), { code: 'EACCES' }); }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const cancelled = job.cancel(); const refused = assert.rejects(cancelled, { code: 'EACCES' });
    await entered.promise; const closed = job.close(); const safe = assert.doesNotReject(closed);
    release.resolve(); await Promise.all([refused, safe]);
    assert.ok(await fs.stat(job.part)); await job.start(); assert.equal(job.state.state, 'paused');
  } finally { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); await job.close().catch(() => {}); await fs.rm(path, { recursive: true, force: true }); }
});

test('round 2 item 2: server cleanup survives a throwing download close', async () => {
  // A child isolates the pre-fix listener leak; its forced exit is only fixture cleanup.
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { startServer } from ${source('server.ts')};
    import { ModelDownload } from ${source('setup/model-download.ts')};
    const directory = await fs.mkdtemp(join(tmpdir(), 'setup-close-test-'));
    const app = await startServer({ directory, port: 0, recognizer: null, quick: null, heavy: null,
      setup: { scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
    const original = ModelDownload.prototype.close;
    ModelDownload.prototype.close = async () => { throw new Error('Example close failure'); };
    let closed = true; try { await app.close(); } catch { closed = false; }
    let databaseClosed = false; try { app.store.db.prepare('SELECT 1'); } catch { databaseClosed = true; }
    const lockReleased = !await fs.stat(join(directory, 'server.lock')).catch(() => null);
    console.log(JSON.stringify({ closed, databaseClosed, lockReleased }));
    ModelDownload.prototype.close = original;
    if (!databaseClosed) app.store.close(); await fs.rm(directory, { recursive: true, force: true }); process.exit(0);
  `], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { closed: true, databaseClosed: true, lockReleased: true });
});

test('round 2 item 3: use true arriving during finalization saves the downloaded choice', async () => {
  const path = await directory(), content = gguf({ name: 'Example downloaded', padding: 1024 });
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Length': content.length }); res.end(content); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await model(join(path, 'models/existing.gguf'), { name: 'Example existing' });
  const entered = deferred(), release = deferred(); let hold = false;
  const setup = await setupFixture(path, {
    download: { url: `http://127.0.0.1:${address.port}`, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 },
    ffmpeg: async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } return { found: true }; },
  });
  try {
    hold = true;
    const work = setup.download.start(); await entered.promise;
    await setup.startDownload(true);
    assert.equal(setup.download.start(), work);
    release.resolve(); await work;
    assert.equal(setup.settings().speechModelPath, setup.download.path);
    assert.equal(setup.scan.config.path, setup.download.path); assert.equal(setup.restartNeeded, true);
  } finally { release.resolve(); await setup.download.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(path, { recursive: true, force: true }); }
});

test('round 2 item 4: teardown restores decoder ownership before a second server starts', async t => {
  restoreEnv(t); const path = await directory(); let fallback = true, found = false;
  const options = (directory: string) => ({ directory, port: 0, recognizer: null, quick: null, heavy: null,
    setup: { scan: scanOptions(directory), ffmpeg: async (env: NodeJS.ProcessEnv) => {
      const result = await checkFfmpeg({ env, fallbackFolders: ['/fictional/brew'], run: async command => {
        if (fallback ? !command.startsWith('/fictional/brew/') : command.includes('/')) throw Object.assign(new Error('Example binary absent'), { code: 'ENOENT' });
      } }); found = result.found; return result;
    } } });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(options(join(path, 'first'))); assert.equal(found, true);
    assert.equal(process.env.MEETING_FFMPEG, '/fictional/brew/ffmpeg'); await app.close();
    assert.equal(process.env.MEETING_FFMPEG, undefined); assert.equal(process.env.MEETING_FFPROBE, undefined);
    fallback = false; app = await startServer(options(join(path, 'second'))); assert.equal(found, true); await app.close();
    process.env.MEETING_FFMPEG = '/fictional/user/ffmpeg'; process.env.MEETING_FFPROBE = '/fictional/user/ffprobe';
    app = await startServer(options(join(path, 'user'))); await app.close();
    assert.equal(process.env.MEETING_FFMPEG, '/fictional/user/ffmpeg'); assert.equal(process.env.MEETING_FFPROBE, '/fictional/user/ffprobe');
  } finally { await app?.close(); await fs.rm(path, { recursive: true, force: true }); }
});

test('round 2 item 5: Node closes a real directory after its timed-out pending read settles', async () => {
  // A blocked FIFO open occupies the sole libuv thread without CPU work. Expire the controlled
  // scan deadline only after the real directory read has queued behind it.
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { openSync, closeSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
    import { mock } from 'node:test'; import { syncBuiltinESMExports } from 'node:module';
    import { SpeechModels } from ${source('setup/speech-models.ts')};
    const directory = await fs.mkdtemp(join(tmpdir(), 'setup-pending-read-')); await fs.mkdir(join(directory, 'models'));
    const fifo = join(directory, 'gate'); execFileSync('mkfifo', [fifo]);
    const dir = await fs.opendir(join(directory, 'models')), close = dir.close.bind(dir), read = dir.read.bind(dir);
    const originalStat = fs.stat, originalOpendir = fs.opendir;
    let closeStarted = false, closed = false, closing;
    dir.close = (callback) => {
      closeStarted = true;
      if (callback) return close((...args) => { closed = true; callback(...args); });
      closing = close().then(() => { closed = true; });
      queueMicrotask(() => mock.timers.tick(0)); // The expired close deadline must not wait for the blocked read.
      return closing;
    };
    fs.stat = async () => { throw Object.assign(new Error('No optional settings'), { code: 'ENOENT' }); };
    fs.opendir = async () => dir; syncBuiltinESMExports();
    let now = 0, released = false;
    mock.method(performance, 'now', () => now);
    mock.timers.enable({ apis: ['setTimeout'] });
    const blocked = fs.open(fifo, 'r');
    dir.read = () => {
      const pending = read();
      queueMicrotask(() => { now = 30; mock.timers.tick(30); });
      return pending;
    };
    const release = async () => { if (!released) { released = true; closeSync(openSync(fifo, 'w')); await (await blocked).close(); } };
    try {
      const started = performance.now();
      const scan = await new SpeechModels().scan({ directory, home: join(directory, 'home'), envModelPath: null, hfHome: null, maxScanMs: 30 });
      const elapsed = performance.now() - started;
      assert.equal(scan.truncated, true); assert.ok(elapsed < 250); assert.equal(closeStarted, true); assert.equal(closed, false);
      assert.throws(() => dir.readSync(), { code: 'ERR_DIR_CONCURRENT_OPERATION' });
      await release(); await closing; assert.equal(closed, true); await assert.rejects(read(), { code: 'ERR_DIR_CLOSED' });
      console.log(JSON.stringify({ truncated: scan.truncated, closeQueuedDuringRead: closeStarted, closed, elapsed }));
    } finally {
      mock.timers.reset(); mock.restoreAll(); await release(); if (!closed) await close().catch(() => {});
      fs.stat = originalStat; fs.opendir = originalOpendir; syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true });
    }
  `], { timeout: 10_000, env: { ...process.env, UV_THREADPOOL_SIZE: '1' } });
  const result = JSON.parse(stdout.trim()); assert.equal(result.closed, true); assert.equal(result.closeQueuedDuringRead, true);
});

test('round 2 item 6: an unresolved deadline timer does not keep a child process alive', async () => {
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { byDeadline } from ${source('setup/deadline.ts')};
    void byDeadline(new Promise(() => {}), performance.now() + 10000).catch(() => {});
    console.log('started');
  `], { timeout: 1500 });
  assert.equal(stdout.trim(), 'started');
});

function expireOnlyInsideHeader(t: TestContext) {
  // The clock expires in the CPU/header bounds check, not in an I/O race or scan.stop().
  t.mock.method(performance, 'now', () => new Error().stack?.includes('HeaderReader.bound') ? 20_000 : 0);
}
test('round 2 item 7: a GGUF header deadline throws ScanTimeout rather than tooLarge', async t => {
  const path = await directory(); await model(join(path, 'example.gguf')); expireOnlyInsideHeader(t);
  try { await assert.rejects(readGguf(join(path, 'example.gguf'), 10_000), error => error instanceof ScanTimeout); }
  finally { t.mock.restoreAll(); await fs.rm(path, { recursive: true, force: true }); }
});
test('round 2 item 7: the typed header timeout marks the scan truncated', async t => {
  const path = await directory(); await model(join(path, 'models/example.gguf')); expireOnlyInsideHeader(t);
  try { assert.equal((await new SpeechModels().scan({ ...scanOptions(path), maxScanMs: 10_000 })).truncated, true); }
  finally { t.mock.restoreAll(); await fs.rm(path, { recursive: true, force: true }); }
});
