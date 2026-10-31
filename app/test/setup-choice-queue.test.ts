import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SpeechSetup } from '../src/setup/service.ts';
import { model, gguf } from './helpers/gguf.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'setup-choice-queue-')));
  const a = await model(join(directory, 'models/a.gguf'), { name: 'Example A' });
  const c = await model(join(directory, 'models/c.gguf'), { name: 'Example C' });
  const content = gguf({ name: 'Example B' });
  let settings = { speechModelPath: a as string | null, setupSeen: false };
  const saves: (string | null)[] = [];
  const setup = new SpeechSetup(directory, () => settings, async change => {
    if ('speechModelPath' in change) saves.push(change.speechModelPath!);
    settings = { ...settings, ...change };
  }, {
    scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }),
    download: { url: 'http://127.0.0.1:1/not-used', bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), freeSpace: async () => 1e12 },
  });
  await setup.initialize(); await writeFile(setup.download.part, content);
  t.after(async () => { await setup.close(); await rm(directory, { recursive: true, force: true }); });
  return { setup, a, c, saves, cId: setup.scan.models.find(m => m.name === 'Example C')!.id };
}

for (const hold of ['recheck', 'save'] as const) test(hold === 'recheck'
  ? 'choice queue: C chosen during B finalization survives B failure and switches to C'
  : 'choice queue: rollback queued behind a newer explicit choice save does nothing', async t => {
  const { setup, a, c, cId, saves } = await fixture(t);
  const bEntered = deferred(), bRelease = deferred(), cEntered = deferred(), cRelease = deferred(), failB = deferred(), paused = deferred();
  const pause = setup.download.pause.bind(setup.download);
  t.mock.method(setup.download, 'pause', () => { paused.resolve(); return pause(); });
  let holdB = true, holdC = true;
  setup.options.ffmpeg = async () => {
    if (holdB) { holdB = false; bEntered.resolve(); await bRelease.promise; }
    if (hold === 'recheck' && setup.settings().speechModelPath === c && holdC) {
      holdC = false; cEntered.resolve(); await cRelease.promise;
    }
    return { found: true };
  };
  if (hold === 'save') {
    const save = setup.save;
    t.mock.method(setup, 'save', async (change: Parameters<SpeechSetup['save']>[0]) => {
      if (change.speechModelPath === c && holdC) { holdC = false; cEntered.resolve(); await cRelease.promise; }
      await save(change);
    });
  }
  const switched: string[] = [];
  setup.attachRuntime({ recording: () => false, cancelSwitch() {}, applied() {}, kick() {}, switchTo: async (path, applied) => {
    switched.push(path);
    if (path === setup.download.path) { await failB.promise; throw new Error('Example B failed to load'); }
    applied(); return true;
  } });
  let choosing: Promise<unknown> | undefined;
  const work = setup.startDownload(true);
  try {
    await bEntered.promise;
    choosing = setup.use(cId); await paused.promise;
    bRelease.resolve(); await work; await cEntered.promise;
    assert.ok(switched.includes(setup.download.path), 'B began switching after C requested the pause');
    failB.resolve(); await tick(); await tick();
    if (hold === 'recheck') assert.equal(setup.settings().speechModelPath, c, 'A must not overwrite saved C');
    else assert.equal(saves.includes(a), false, 'rollback cannot write A while the newer C save is pending');
    cRelease.resolve(); await choosing; await tick();
    assert.equal(setup.settings().speechModelPath, c);
    assert.equal(setup.runningPath, c); assert.equal(switched.at(-1), c);
    assert.equal(saves.includes(a), false);
  } finally {
    bRelease.resolve(); cRelease.resolve(); failB.resolve();
    await Promise.allSettled([work, choosing]);
  }
});

for (const kind of ['pause', 'cancel'] as const) test(`choice queue: promotion during finalization with active ${kind} is saved and switched`, async t => {
  const { setup } = await fixture(t), entered = deferred(), release = deferred(), controlling = deferred();
  let first = true;
  setup.options.ffmpeg = async () => {
    if (first) { first = false; entered.resolve(); await release.promise; } return { found: true };
  };
  const switched: string[] = [];
  setup.attachRuntime({ recording: () => false, cancelSwitch() {}, applied() {}, kick() {}, switchTo: async (path, applied) => {
    switched.push(path); applied(); return true;
  } });
  const stop = setup.download[kind].bind(setup.download);
  t.mock.method(setup.download, kind, () => { controlling.resolve(); return stop(); });
  const work = setup.download.start();
  let control: Promise<void> | undefined;
  try {
    await entered.promise;
    control = setup.download[kind](); await controlling.promise; await tick();
    await setup.startDownload(true);
    release.resolve(); await work; await control; await tick();
    assert.equal(setup.download.state.state, 'done');
    assert.equal(setup.settings().speechModelPath, setup.download.path);
    assert.equal(setup.runningPath, setup.download.path);
    assert.deepEqual(switched, [setup.download.path]);
  } finally { release.resolve(); await Promise.allSettled([work, control]); }
});
