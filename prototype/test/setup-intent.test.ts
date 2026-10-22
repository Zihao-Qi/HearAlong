import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SpeechSetup, type SetupSettings } from '../src/setup/service.ts';
import { model, gguf } from './helpers/gguf.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Condition did not settle');
}
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'setup-intent-')));
  const a = await model(join(directory, 'models/a.gguf'), { name: 'Example A' });
  const b = await model(join(directory, 'models/b.gguf'), { name: 'Example B' });
  const c = await model(join(directory, 'models/c.gguf'), { name: 'Example C' });
  const content = gguf({ name: 'Example download' });
  let settings: SetupSettings = { speechModelPath: a, setupSeen: false };
  let beforeSave = async (_change: Partial<SetupSettings>) => {};
  const setup = new SpeechSetup(directory, () => settings, async change => { await beforeSave(change); settings = { ...settings, ...change }; }, {
    scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }),
    download: { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 },
  });
  await setup.initialize(); await writeFile(setup.download.part, content);
  t.after(async () => { await setup.close(); await rm(directory, { recursive: true, force: true }); });
  const id = (path: string) => setup.scan.models.find(m => m.chosenFile.path === path)!.id;
  const runtime = () => setup.attachRuntime({ recording: () => false, cancelSwitch() {}, applied() {}, kick() {},
    switchTo: async (_path, apply) => { apply(); return true; } });
  return { setup, a, b, c, id, runtime, saveHook: (hook: typeof beforeSave) => { beforeSave = hook; } };
}

test('intent 1: newest download-use during finalization supersedes a paused path choice', async t => {
  const { setup, c, id, runtime } = await fixture(t); runtime();
  const entered = deferred(), release = deferred(), pausing = deferred(); let hold = true;
  setup.options.ffmpeg = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } return { found: true }; };
  const pause = setup.download.pause.bind(setup.download);
  t.mock.method(setup.download, 'pause', () => { pausing.resolve(); return pause(); });
  const job = setup.download.start(); let choosing: Promise<unknown> | undefined;
  try {
    await entered.promise; choosing = setup.use(id(c)); await pausing.promise;
    await setup.startDownload(true);
    release.resolve(); await Promise.all([job, choosing]); await tick();
    assert.equal(setup.settings().speechModelPath, setup.download.path);
    assert.equal(setup.runningPath, setup.download.path);
    assert.equal(setup.pending, undefined);
  } finally { release.resolve(); await Promise.allSettled([job, choosing]); }
});

test('intent 2: resume(false) cannot revive download-use superseded by C', async t => {
  const { setup, c, id, runtime } = await fixture(t); runtime();
  const entered = deferred(), release = deferred(), pausing = deferred(); let hold = true;
  setup.options.download!.freeSpace = async () => 1e12;
  // Keep the real downloader before its abort check, so choosing C pauses rather than finalizes it.
  const downloadOptions = (setup.download as unknown as { options: { freeSpace: () => Promise<number> } }).options;
  downloadOptions.freeSpace = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } return 1e12; };
  const pause = setup.download.pause.bind(setup.download);
  t.mock.method(setup.download, 'pause', () => { const work = pause(); queueMicrotask(pausing.resolve); return work; });
  await setup.startDownload(true); let choosing: Promise<unknown> | undefined;
  try {
    await entered.promise; choosing = setup.use(id(c)); await pausing.promise; await tick();
    release.resolve(); await choosing;
    assert.equal(setup.settings().speechModelPath, c); assert.equal(setup.download.state.state, 'paused');
    await setup.startDownload(false); await until(() => setup.download.state.state === 'done'); await tick();
    assert.equal(setup.settings().speechModelPath, c); assert.equal(setup.runningPath, c);
  } finally { release.resolve(); await choosing; }
});

test('download intent survives pause and resume(false) when no newer choice intervenes', async t => {
  const { setup, runtime } = await fixture(t); runtime();
  const entered = deferred(), release = deferred(); let hold = true;
  const options = (setup.download as unknown as { options: { freeSpace: () => Promise<number> } }).options;
  options.freeSpace = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } return 1e12; };
  try {
    await setup.startDownload(true); await entered.promise;
    const paused = setup.download.pause(); await tick(); release.resolve(); await paused;
    assert.equal(setup.download.state.state, 'paused');
    await setup.startDownload(false); await until(() => setup.download.state.state === 'done'); await tick();
    assert.equal(setup.settings().speechModelPath, setup.download.path);
    assert.equal(setup.runningPath, setup.download.path);
  } finally { release.resolve(); }
});

test('intent 3: rejected save preserves intent but a later load failure reports and rolls back', async t => {
  const { setup, a, b, c, id, saveHook } = await fixture(t);
  const first = deferred(), failSecond = deferred(); let attempts = 0;
  setup.attachRuntime({ recording: () => false, applied() {}, kick() {}, cancelSwitch() { first.resolve(); }, switchTo: async (_path, apply) => {
    if (++attempts === 1) { await first.promise; return false; }
    await failSecond.promise; throw new Error('Example B failed on retry');
  } });
  try {
    await setup.use(id(b));
    saveHook(async change => { if (change.speechModelPath === c) throw new Error('Example save failed'); });
    await assert.rejects(setup.use(id(c)), /Example save failed/);
    assert.equal(setup.settings().speechModelPath, b);
    await setup.recheck(); assert.equal(attempts, 2);
    failSecond.resolve(); await tick(); await tick();
    assert.equal(setup.settings().speechModelPath, a);
    assert.equal(setup.runningPath, a); assert.equal(setup.pending, undefined);
    assert.match(setup.switchError!, /Example B failed on retry/);
  } finally { first.resolve(); failSecond.resolve(); }
});
