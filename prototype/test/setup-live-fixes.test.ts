import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LiveDrafts } from '../src/drafts.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { SwitchableRecognizer } from '../src/setup/switchable-recognizer.ts';
import { ModelDownload } from '../src/setup/model-download.ts';
import { SpeechSetup } from '../src/setup/service.ts';
import { startServer } from '../src/server.ts';
import { model, gguf } from './helpers/gguf.ts';

const workerScript = new URL('./fixtures/switch-worker.ts', import.meta.url);
const streamScript = new URL('./fixtures/switch-stream-worker.ts', import.meta.url);
import { setTimeout as sleep } from 'node:timers/promises';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
async function until(condition: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!await condition()) { if (Date.now() > end) throw new Error('Condition did not settle'); await sleep(10); }
}
async function directory(t: TestContext) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'setup-live-fixes-')));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function pids(path: string) { return (await readFile(`${path}.pids`, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number); }
function gone(pid: number) { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
async function offlineDownload(t: TestContext, onDone: (path: string) => Promise<void>) {
  const path = await directory(t), content = gguf({ name: 'Example downloaded' });
  const download = new ModelDownload({ directory: path, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12, onDone });
  await download.ready; await mkdir(join(path, 'models')); await writeFile(download.part, content);
  return download;
}

for (const mode of ['none', 'non-streaming', 'streaming']) test(`fix 1: segments report actual draft availability (${mode})`, async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'setup-live-availability-')));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    if (mode !== 'none') await model(join(path, 'models/example.gguf'), { family: mode === 'streaming' ? 'parakeet' : 'whisper' });
    app = await startServer({ directory: path, port: 0, quick: null, heavy: null,
      setup: { worker: { workerScript }, scan: { home: join(path, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
    const m = app.store.createMeeting('Example');
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${app.url}/api/meetings/${m.id}/segments`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).draftsAvailable, mode === 'streaming');
  } finally { await app?.close(); await rm(path, { recursive: true, force: true }); }
});

test('fix 2: promotion at completion boundary is applied or no longer joins the finished job', async t => {
  let download!: ModelDownload, late: Promise<void> | undefined;
  let calls = 0;
  download = await offlineDownload(t, async () => {
    if (++calls === 1) queueMicrotask(() => queueMicrotask(() => { late = download.start(); }));
  });
  try {
    const work = download.start(); await work; await late;
    assert.ok(late);
    if (late === work) assert.equal(calls, 2, 'a request accepted by the shared job must be finalized');
    else assert.equal(download.state.state, 'done', 'late requests no longer join a finalizing job');
  } finally { await download.close(); }
});

test('fix 3: rejecting first completion callback still processes a late promotion', async t => {
  const entered = deferred(), release = deferred(), warnings: string[] = []; let calls = 0;
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const download = await offlineDownload(t, async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error('Example failed recheck'); }
  });
  try {
    const work = download.start(); await entered.promise;
    assert.equal(download.start(), work); release.resolve(); await work;
    assert.equal(calls, 2); assert.equal(download.state.state, 'done');
    assert.match(warnings.join('\n'), /Example failed recheck/);
  } finally { release.resolve(); await download.close(); }
});

test('fix 4: download remains checking until the choice is saved, including a promoted save', async t => {
  const entered = deferred(), release = deferred(), saveEntered = deferred(), saveRelease = deferred();
  let saved = false, calls = 0;
  const download = await offlineDownload(t, async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    else { saveEntered.resolve(); await saveRelease.promise; saved = true; }
  });
  try {
    const work = download.start(); await entered.promise;
    assert.equal(download.start(), work); release.resolve(); await saveEntered.promise;
    assert.equal(saved, false); assert.equal(download.state.state, 'checking');
    saveRelease.resolve(); await work; assert.equal(saved, true); assert.equal(download.state.state, 'done');
  } finally { release.resolve(); saveRelease.resolve(); await download.close(); }
});

test('fix 2-4: use=true for an already-done download saves the choice and switches live without fetching', async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'setup-live-done-'))), content = gguf({ name: 'Example downloaded' });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const initial = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
    await writeFile(join(path, 'settings.json'), JSON.stringify({ speechModelPath: initial }));
    await writeFile(join(path, 'models/parakeet-unified-en-0.6b-Q8_0.gguf.part'), content);
    app = await startServer({ directory: path, port: 0, quick: null, heavy: null,
      setup: { worker: { workerScript }, scan: { home: join(path, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }),
        download: { url: 'http://127.0.0.1:1/not-used', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 } } });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const request = async (route: string, use?: boolean) => {
      const response = await fetch(app!.url + route, { method: use === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json' }, body: use === undefined ? undefined : JSON.stringify({ use }) });
      assert.equal(response.status, 200); return response.json();
    };
    await request('/api/setup/speech/download', false);
    await until(async () => (await request('/api/setup')).rows[0].download.state === 'done');
    assert.equal((await request('/api/settings')).speechModelPath, initial);
    await request('/api/setup/speech/download', true);
    await until(async () => !(await request('/api/setup')).rows[0].pending);
    const downloaded = join(path, 'models/parakeet-unified-en-0.6b-Q8_0.gguf');
    assert.equal((await request('/api/settings')).speechModelPath, downloaded);
    assert.equal((await request('/api/status')).config.path, downloaded);
    assert.equal((await pids(downloaded)).length, 1);
    assert.equal((await request('/api/setup')).restartNeeded, false);
  } finally { await app?.close(); await rm(path, { recursive: true, force: true }); }
});

test('fix 5: a recheck begun during failed preflight cannot publish the rolled-back choice', async t => {
  const path = await directory(t), old = await model(join(path, 'models/old.gguf'), { name: 'Example old' });
  await model(join(path, 'models/broken.gguf'), { name: 'Example broken' });
  let settings = { speechModelPath: old as string | null, setupSeen: false }, block = false;
  const entered = deferred(), release = deferred(), rejectLoad = deferred();
  const setup = new SpeechSetup(path, () => settings, async change => { settings = { ...settings, ...change }; }, {
    scan: { home: join(path, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => {
      if (block) { block = false; entered.resolve(); await release.promise; } return { found: true };
    },
  });
  await setup.initialize();
  setup.attachRuntime({ recording: () => false, cancelSwitch() {}, applied() {}, kick() {}, switchTo: async () => {
    await rejectLoad.promise; throw new Error('Example invalid weights');
  } });
  try {
    await setup.use(setup.scan.models.find(m => m.name === 'Example broken')!.id);
    block = true; const check = setup.recheck(); await entered.promise;
    rejectLoad.resolve(); await until(() => Boolean(setup.switchError) && settings.speechModelPath === old);
    assert.equal(setup.scan.config.path, old);
    release.resolve(); await check;
    assert.equal(setup.status().rows[0].path, old);
    assert.equal(setup.runningPath, old); assert.equal(settings.speechModelPath, old);
  } finally { release.resolve(); rejectLoad.resolve(); await setup.close(); }
});

for (const maxSources of [1, 2]) test(`fix 6: setModel retires all idle workers at once and strictly preserves ${maxSources} source slots`, async t => {
  const path = await directory(t), old = join(path, 'old'), next = join(path, 'next');
  const drafts = new LiveDrafts({ modelPath: old, workerScript: streamScript, maxSources, idleCloseMs: 60_000 });
  try {
    for (let i = 0; i < maxSources; i++) assert.equal(drafts.begin('m', `mic:${i}`, `w${i}`, 0), true);
    await until(async () => (await pids(old)).length === maxSources);
    for (let i = 0; i < maxSources; i++) drafts.drop(`w${i}`);
    drafts.setModel(next, true);
    await until(async () => (await pids(old)).every(gone));
    for (let i = 0; i < maxSources; i++) assert.equal(drafts.begin('m', `mic:${i}`, `next${i}`, 1000), true);
    assert.equal(drafts.begin('m', 'mic:extra', 'extra', 1000), false);
    await until(async () => (await pids(next)).length === maxSources);
    assert.equal((await pids(next)).filter(pid => !gone(pid)).length, maxSources);
    for (let i = 0; i < maxSources; i++) drafts.drop(`next${i}`);
    drafts.setModel(next, false);
    await until(async () => (await pids(next)).every(gone));
    assert.equal(drafts.begin('m', 'mic:0', 'disabled', 2000), false);
  } finally { await drafts.close(); }
});

test('fix 6: begin retires a same-path worker when streaming becomes unavailable', async t => {
  const path = join(await directory(t), 'old');
  const drafts = new LiveDrafts({ modelPath: path, workerScript: streamScript });
  try {
    assert.equal(drafts.begin('m', 'mic:a', 'w0', 0), true);
    await until(async () => (await pids(path)).length === 1);
    drafts.setModel(path, false);
    assert.equal(drafts.begin('m', 'mic:a', 'w1', 1000), false);
    await until(async () => (await pids(path)).every(gone));
  } finally { await drafts.close(); }
});

test('fix 7: close joins the timeout cancellation promise, not just the cleared worker handle', async t => {
  const path = join(await directory(t), 'never.gguf'), entered = deferred(), release = deferred();
  const original = LocalRecognizer.prototype.cancelLoad, seen = new WeakSet<LocalRecognizer>();
  t.mock.method(LocalRecognizer.prototype, 'cancelLoad', async function (this: LocalRecognizer) {
    const first = !seen.has(this); seen.add(this);
    await original.call(this);
    if (first) { entered.resolve(); await release.promise; }
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = new SwitchableRecognizer(null, { workerScript, loadMs: 500 });
  const switching = assert.rejects(r.switchTo(path), /timed out/);
  let closed = false;
  try {
    await until(async () => (await pids(path)).length === 1);
    t.mock.timers.tick(500); // Loading times out only once the fake child has actually started.
    await entered.promise;
    t.mock.timers.reset();
    const closing = r.close().then(() => { closed = true; });
    await sleep(30); assert.equal(closed, false, 'close must await the original timeout cancellation');
    release.resolve(); await switching; await closing;
    assert.ok((await pids(path)).every(gone));
  } finally { t.mock.timers.reset(); release.resolve(); await switching; await r.close(); }
});
