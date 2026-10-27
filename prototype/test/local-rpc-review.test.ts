import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as rpc from '../src/pi-rpc.ts';
import { inLocalPiLane } from '../src/local-pi-lane.ts';
import { stopPiRuns } from '../src/pi-command.ts';
import { isAiDeferred } from '../src/ai-deferral.ts';
import { runPiTask } from '../src/pi-task.ts';
import { MeetingStore } from '../src/store.ts';
import { Boards } from '../src/board.ts';
import { Corrector } from '../src/correction.ts';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function holder() {
  const started = gate(), end = gate();
  const done = inLocalPiLane('ollama/holder', async () => { started.resolve(); await end.promise; });
  await started.promise;
  return { done, release: end.resolve };
}
async function bounded(promise: Promise<unknown>, ms = 1000) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function loadFixture(t: any, loadMs = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-review-load-')), command = join(directory, 'pi'), log = join(directory, 'load.jsonl');
  await copyFile(new URL('./fixtures/local-rpc-load.mjs', import.meta.url), command); await chmod(command, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { log, options: { model: 'ollama/fictional:4b', command, cwd: directory,
    env: { ...process.env, RPC_LOAD_LOG: log, RPC_LOAD_MS: String(loadMs), RPC_LOAD_BOUND_MS: '3000' } } };
}

// Mutable limits follow the task-limit convention; production stays ten minutes, with 1:100 timing here.
test('review RPC: production local deadline is ten minutes', () => {
  assert.equal(rpc.PI_RPC_LIMITS?.localTimeoutMs, 600_000);
});
for (const kind of ['ollama', 'lmstudio']) for (const oldMs of [300, 900]) test(`review RPC: ${kind} cold load outlasts old ${oldMs} ms limit but fits the loading bound`, async t => {
  const f = await loadFixture(t, 1200);
  const limits = rpc.PI_RPC_LIMITS;
  if (limits) { const saved = limits.localTimeoutMs; limits.localTimeoutMs = 6000; t.after(() => { limits.localTimeoutMs = saved; }); }
  const lane = new rpc.PiRpc({ ...f.options, model: `${kind}/fictional:4b`, timeoutMs: oldMs });
  try {
    const answer = await lane.ask('Fictional cold start', oldMs);
    assert.equal(answer.text, 'Fictional answer');
    assert.ok(answer.ms >= 1200); assert.ok(answer.ms < 6000);
    assert.match(await readFile(f.log, 'utf8'), /"loaded"/);
  } finally { await lane.close(); }
});

test('review RPC: cloud default, Board override and per-request deadlines are unchanged', async t => {
  const f = await loadFixture(t), delays: number[] = [], timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => { delays.push(ms!); return timeout(fn, ms, ...args); });
  for (const [configured, requested, expected] of [[undefined, undefined, 30_000], [90_000, undefined, 90_000], [90_000, 45_000, 45_000]]) {
    const lane = new rpc.PiRpc({ ...f.options, model: 'example/cloud', timeoutMs: configured });
    try {
      delays.length = 0; await lane.ask('Fictional cloud reply', requested);
      assert.ok(delays.includes(expected!)); assert.equal(delays.includes(600_000), false);
    } finally { await lane.close(); }
  }
});

for (const stop of ['interrupt', 'watcher'] as const) test(`review RPC: cold loading still responds to ${stop} cancellation and releases the local lane`, async t => {
  const f = await loadFixture(t, 1200), lane = new rpc.PiRpc(f.options);
  const reply = lane.ask('Fictional cold start').then(() => null, error => error);
  try {
    await until(async () => (await readFile(f.log, 'utf8').catch(() => '')).includes('loading'));
    if (stop === 'interrupt') lane.interrupt(); else stopPiRuns();
    assert.ok(isAiDeferred(await reply));
    let admitted = false;
    await inLocalPiLane('ollama/next', async () => { admitted = true; });
    assert.equal(admitted, true);
  } finally { await lane.close(); }
});

async function callers(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'rpc-review-callers-'));
  const store = new MeetingStore(directory), meeting = store.createMeeting('Fictional cupboard meeting');
  const chunk = await store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, Buffer.alloc(64000));
  store.completeChunk(chunk.id, { text: 'Should we move the fictional wooden tokens into the blue cupboard before lunch?', words: [], backend: 'fake', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let started = gate(), pause = true, entries = 0;
  const errors: unknown[] = [];
  let lane = new rpc.ModelRpc(async () => 'ollama/fictional:4b', { cwd: directory, command: join(directory, 'intentionally-missing-pi') });
  const ask = async (message: string, text: string) => {
    if (!pause) return { text, ms: 1, attempts: 1, usages: [], aborted: false, stopReason: 'stop' };
    const pending = lane.ask(message); pending.catch(() => {}); await turn(); entries++; started.resolve();
    try { return await pending; } catch (error) { errors.push(error); throw error; }
  };
  const boards = new Boards({ store, directory, actions: null, clock: Date.now, glossaryFor: async () => null, hasMaterials: () => false, ask: message => ask(message, '{"items":[]}') });
  const corrector = new Corrector({ store, clock: () => 100_000, glossaryFor: async () => ({ version: 1, origin: 'user', builtAt: 0,
    terms: [{ term: 'wooden tokens', spokenVariants: [], note: 'Fictional counters.' }] }), ask: message => ask(message, '{"edits":[]}') });
  t.after(async () => { await boards.close(); await lane.close(); });
  return { boards, corrector, meeting, errors, lane: () => lane, entries: () => entries, entered: () => started.promise, close: () => lane.close(),
    async reset() { await lane.close(); lane = new rpc.ModelRpc(async () => 'ollama/fictional:4b', { cwd: directory, command: join(directory, 'intentionally-missing-pi') }); started = gate(); },
    resume() { pause = false; } };
}

for (const caller of ['Board', 'correction'] as const) for (const stop of ['watcher', 'close'] as const) test(`review RPC: ${caller} queued ${stop} cancellation preserves speech and retry budget`, async t => {
  const f = await callers(t), held = await holder();
  const tick = () => caller === 'Board' ? f.boards.tick(f.meeting.id, true) : f.corrector.tick(f.meeting.id, true);
  try {
    for (let i = 0; i < 3; i++) {
      const running = tick(); await f.entered();
      const closing = stop === 'close' ? f.close() : Promise.resolve(stopPiRuns());
      const ended = bounded(Promise.all([running, closing]));
      const finished = await ended;
      if (!finished) { stopPiRuns(); await Promise.all([running, closing]); }
      assert.equal(finished, true, 'Queued shutdown must not wait for the model lane');
      assert.ok(isAiDeferred(f.errors.at(-1)), 'Scheduling cancellation must reach the caller as AiDeferred');
      if (caller === 'Board') {
        const status = await f.boards.status(f.meeting.id);
        assert.equal(status.gaps.length, 0); assert.equal(status.lastError, null);
        assert.equal(await f.boards.hasBacklog(f.meeting.id), true);
      } else {
        const state = f.corrector.state(f.meeting.id);
        assert.equal(state.failures, 0); assert.equal(state.retryAfter, 0); assert.equal(state.stats.failed, 0); assert.equal(state.lastCallAt, 0);
        assert.equal(f.corrector.pending(f.meeting.id).length, 1);
      }
      await f.reset();
    }
    f.resume(); await tick();
    assert.equal(caller === 'Board' ? await f.boards.hasBacklog(f.meeting.id) : Boolean(f.corrector.pending(f.meeting.id).length), false);
  } finally { stopPiRuns(); held.release(); await held.done; }
});

test('review RPC: real mode change defers queued Board and correction work without spending their budgets', async t => {
  const pi = await fakePi(t, { table: table(['ollama fictional:4b 32K 4K no no']) });
  const directory = join(pi.directory, 'app'); await mkdir(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'local', setupSeen: true, localMainModel: 'ollama/fictional:4b', localQuickModel: 'ollama/fictional:4b' }));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, board: null, recognizer: null, drafts: null,
    ai: { env: pi.env }, setup: { scan: { home: pi.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  const board = await callers(t), correction = await callers(t), held = await holder();
  try {
    const a = board.boards.tick(board.meeting.id, true), b = correction.corrector.tick(correction.meeting.id, true);
    await Promise.all([board.entered(), correction.entered()]);
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(app.url + '/api/setup/ai', { method: 'PUT', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: '{"mode":"off"}' });
    assert.equal(response.status, 200); await Promise.all([a, b]);
    assert.ok(isAiDeferred(board.errors[0])); assert.ok(isAiDeferred(correction.errors[0]));
    assert.equal((await board.boards.status(board.meeting.id)).gaps.length, 0);
    assert.equal(await board.boards.hasBacklog(board.meeting.id), true);
    assert.equal(correction.corrector.state(correction.meeting.id).failures, 0);
    assert.equal(correction.corrector.state(correction.meeting.id).retryAfter, 0);
  } finally { stopPiRuns(); held.release(); await held.done; await app.close(); }
});

test('review RPC: server close defers queued Board and correction callers, including requests in the RPC queue', async t => {
  const f = await callers(t), pi = await fakePi(t, { table: table(['ollama fictional:4b 32K 4K no no']) });
  const directory = join(pi.directory, 'app'); await mkdir(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'local', setupSeen: true, localMainModel: 'ollama/fictional:4b', localQuickModel: 'ollama/fictional:4b' }));
  const app = await startServer({ directory, port: 0, quick: f.lane(), heavy: null, board: null, recognizer: null, drafts: null,
    ai: { env: pi.env }, setup: { scan: { home: pi.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  const held = await holder();
  const work = Promise.all([f.boards.tick(f.meeting.id, true), f.corrector.tick(f.meeting.id, true)]);
  try {
    await until(() => f.entries() === 2);
    const closing = app.close();
    const finished = await bounded(Promise.all([closing, work]));
    if (!finished) { stopPiRuns(); held.release(); await Promise.all([closing, work]); }
    assert.equal(finished, true, 'Server shutdown cancels queued RPC without waiting for another job');
    assert.equal(f.errors.length, 2); assert.ok(f.errors.every(isAiDeferred));
    assert.equal(await f.boards.hasBacklog(f.meeting.id), true);
    assert.equal((await f.boards.status(f.meeting.id)).lastError, null);
    assert.equal(f.corrector.state(f.meeting.id).failures, 0);
    assert.equal(f.corrector.state(f.meeting.id).retryAfter, 0);
    assert.equal(f.corrector.pending(f.meeting.id).length, 1);
  } finally { stopPiRuns(); held.release(); await held.done; await work; await app.close(); }
});

test('review RPC: watcher cancellation keeps tasks cancelled and genuine RPC failures stay ordinary', async t => {
  const f = await loadFixture(t), held = await holder();
  const task = runPiTask('Never spawned', { ...f.options, command: join(f.options.cwd, 'missing') }).then(() => null, error => error);
  await turn(); stopPiRuns();
  try { const error = await task; assert.equal(error.reason, 'cancelled'); assert.equal(isAiDeferred(error), false); }
  finally { held.release(); await held.done; }
  const lane = new rpc.PiRpc({ ...f.options, command: join(f.options.cwd, 'missing') });
  try { await assert.rejects(lane.ask('Genuine spawn failure'), error => !isAiDeferred(error) && /ENOENT/.test(String(error))); }
  finally { await lane.close(); }
});
