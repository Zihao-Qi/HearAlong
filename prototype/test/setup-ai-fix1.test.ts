import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiSetup, type AiSettings } from '../src/setup/ai.ts';
import { runPiTask } from '../src/pi-task.ts';
import { toolsFor } from '../src/actions.ts';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

const chosen = { mainModel: 'example/example-main', quickModel: 'example/example-quick:0' };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fixture(t: TestContext, config: Record<string, unknown> = {}, saved: AiSettings = chosen) {
  const f = await fakePi(t, config);
  f.env.PI_CODING_AGENT_DIR = join(f.directory, 'agent'); await mkdir(f.env.PI_CODING_AGENT_DIR);
  let settings = { ...saved };
  const ai = new AiSetup(() => settings, async next => { settings = next; }, { cloud: true, cwd: f.cwd, env: f.env });
  t.after(() => ai.close());
  return { ...f, ai };
}

test('FIX1.1 signed-out runner calls over 15s share the 30s retry window; UI reads remain fresh', async t => {
  const f = await fixture(t, { table: 'No models available. Use /login.' }, { mainModel: null, quickModel: null });
  let now = 0; f.ai.reader.options.clock = () => now;
  await f.ai.recheck();
  for (let second = 0; second <= 15; second++) {
    now = second * 1000;
    await Promise.allSettled([f.ai.require('main'), f.ai.require('quick'), f.ai.correction()]);
  }
  assert.equal((await f.calls()).filter(c => c.args.includes('--list-models')).length, 1, 'at most one list spawn in 30s');
  now = 30_000;
  await Promise.allSettled([f.ai.require('main'), f.ai.require('quick')]);
  await until(async () => (await f.calls()).filter(c => c.args.includes('--list-models')).length === 2);
  await f.ai.reader.read(); // Join the retry already in flight; explicit UI reads are never negative-cached.
  const before = (await f.calls()).filter(c => c.args.includes('--list-models')).length;
  await f.ai.models(true); await f.ai.models();
  assert.equal((await f.calls()).filter(c => c.args.includes('--list-models')).length, before + 2);
});

for (const state of ['ok', 'unreadable'] as const) test(`FIX1.1 ${state} stale runner returns immediately while one slow list revalidates`, async t => {
  const f = await fixture(t, state === 'ok' ? {} : { table: 'unknown table' }); let now = 0;
  f.ai.reader.options.clock = () => now; await f.ai.recheck();
  await f.configure({ listDelay: 5000 }); now = state === 'ok' ? 300_000 : 30_000;
  const pending = Promise.all([f.ai.require('main'), f.ai.correction()]);
  const result = await Promise.race([pending, pause(150).then(() => 'blocked')]);
  assert.deepEqual(result, [chosen.mainModel, chosen.mainModel], 'runners must use stale saved ids without waiting');
  await until(async () => (await f.calls()).filter(c => c.args.includes('--list-models')).length === 2);
  await f.ai.close(); await pending;
});

for (const [label, config, saved, detail] of [
  ['signed-out', { table: 'No models available. Use /login.' }, { mainModel: null, quickModel: null }, "Pi isn't signed in. Run pi, then /login."],
  ['unreadable', { table: 'unknown table' }, { mainModel: null, quickModel: null }, "Couldn't read Pi's models."],
  ['not-installed', {}, { mainModel: null, quickModel: null }, 'Pi is not installed. Run npm ci.'],
  ['missing', {}, { mainModel: 'example/removed', quickModel: chosen.quickModel }, 'example/removed is no longer listed by Pi. Choose AI models in setup.'],
  ['choose', {}, { mainModel: null, quickModel: null }, 'Choose AI models in setup.'],
] as const) test(`FIX1.2 ${label} runner error and setup detail match`, async t => {
  const f = await fixture(t, config, saved);
  if (label === 'not-installed') f.env.MEETING_PI = join(f.directory, 'absent');
  await f.ai.recheck();
  await assert.rejects(f.ai.require('main'), { message: detail });
  await assert.rejects(f.ai.correction(), { message: detail });
  assert.equal(f.ai.status().detail, detail);
});

for (const filter of [[], ['index.ts']] as string[][]) test(`FIX1.3 installed web respects extension filter ${JSON.stringify(filter)} on recheck`, async t => {
  const f = await fixture(t, { packages: 'User packages:\n  npm:pi-web-access (filtered)\n    /example/package\n' });
  const settings = join(f.env.PI_CODING_AGENT_DIR!, 'settings.json');
  await writeFile(settings, JSON.stringify({ packages: [{ source: 'npm:pi-web-access', extensions: [] }] }));
  await f.ai.recheck(); assert.equal(f.ai.web, false, 'installed but all extensions disabled');
  assert.ok(!toolsFor('explain', f.ai.web).includes('web_search'));
  await writeFile(settings, JSON.stringify({ packages: [{ source: 'npm:pi-web-access', extensions: filter }] }));
  await f.ai.recheck(); assert.equal(f.ai.web, filter.length > 0);
  assert.equal(toolsFor('explain', f.ai.web).includes('web_search'), filter.length > 0);
});

for (const kind of ['foreground models', 'foreground recheck', 'background auth', 'background web'] as const) test(`FIX1.4 close kills and joins ${kind} probes promptly`, async t => {
  const f = await fixture(t); await f.ai.recheck();
  const before = (await f.calls()).length;
  await f.configure(kind.includes('auth') ? { authDelay: 5000 } : kind.includes('web') ? { webDelay: 5000 } : { listDelay: 5000 });
  let pending: Promise<unknown> | undefined;
  if (kind === 'foreground models') pending = f.ai.models(true);
  else if (kind === 'foreground recheck') pending = f.ai.recheck();
  else f.ai.start();
  const isSlow = (args: string[]) => kind.includes('auth') ? args[0] === 'auth' : kind.includes('web') ? args[0] === 'list' : args.includes('--list-models');
  await until(async () => (await f.calls()).slice(before).some(c => isSlow(c.args)));
  const pids = (await f.calls()).slice(before).filter(c => isSlow(c.args)).map(c => c.pid);
  try {
    const at = performance.now(); await f.ai.close();
    const elapsed = performance.now() - at;
    t.diagnostic(`${kind}: close ${elapsed.toFixed(1)}ms; probe PIDs reaped`);
    assert.ok(pids.every(pid => !alive(pid)), `probe PID still alive after close: ${pids}`);
    assert.ok(elapsed < 800, `close took ${Math.round(elapsed)}ms`);
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await pending;
  }
});

test('FIX1.4 HTTP shutdown aborts a slow foreground models handler before the request grace period', async t => {
  const f = await fakePi(t);
  const app = await startServer({ directory: join(f.directory, 'data'), port: 0, recognizer: null, drafts: null, heavy: null, quick: null,
    ai: { env: f.env }, setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  // Do not let the HTTP client's idle keep-alive timeout dominate the probe shutdown measurement.
  const get = (path: string) => fetch(app.url + path, { headers: { Cookie: cookie, Connection: 'close' } });
  try {
    await (await get('/api/setup/ai/models')).json();
    await f.configure({ listDelay: 5000 }); const before = (await f.calls()).length;
    const request = get('/api/setup/ai/models?refresh=1').then(response => response.json());
    await until(async () => (await f.calls()).slice(before).some(c => c.args.includes('--list-models')));
    const pid = (await f.calls()).slice(before).find(c => c.args.includes('--list-models'))!.pid;
    const at = performance.now(); await app.close();
    assert.equal(alive(pid), false); assert.ok(performance.now() - at < 800, 'HTTP shutdown waited on an uncancelled probe');
    await request;
  } finally { await app.close(); }
});

test('FIX1.5 catalog omission, restoration and recheck cannot bypass a saved pair tiny failure', async t => {
  const f = await fixture(t); await f.ai.recheck();
  let rejectTiny!: (error: Error) => void, started = false;
  const held = new Promise<never>((_, reject) => { rejectTiny = reject; }); held.catch(() => {});
  f.ai.options.tiny = async () => { started = true; return held; };
  try {
    await f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel }); await until(() => started);
    await f.configure({ table: table(['example example-quick:0 32K 4K no no']) });
    await f.ai.models(true);
    assert.equal(f.ai.status().state, 'checking', 'Save keeps its tiny-call obligation even with a missing catalog row');
    await f.configure({}); await f.ai.models(true); await f.ai.recheck();
    assert.equal(f.ai.status().state, 'checking', 'auth-only refresh cannot replace Save check');
    rejectTiny(new Error('tiny rejected access')); await until(() => f.ai.status().state !== 'checking');
    assert.equal(f.ai.status().state, 'no-access'); assert.equal(f.ai.status().detail, 'tiny rejected access');
  } finally { rejectTiny(new Error('test cleanup')); }
});

test('FIX1.5 a recheck begun during Save cannot overwrite the tiny failure when its probes finish later', async t => {
  const f = await fixture(t); await f.ai.recheck();
  let rejectTiny!: (error: Error) => void, started = false;
  const held = new Promise<never>((_, reject) => { rejectTiny = reject; }); held.catch(() => {});
  f.ai.options.tiny = async () => { started = true; return held; };
  try {
    await f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel }); await until(() => started);
    await f.configure({ webDelay: 400 });
    const pending = f.ai.recheck();
    rejectTiny(new Error('tiny failed before recheck ended'));
    await pending;
    assert.equal(f.ai.status().state, 'no-access'); assert.equal(f.ai.status().detail, 'tiny failed before recheck ended');
  } finally { rejectTiny(new Error('test cleanup')); }
});

test('FIX1.6 a newer Save aborts and reaps the older tiny process', async t => {
  const f = await fixture(t, { taskDelay: 5000 }); await f.ai.recheck();
  f.ai.options.tiny = (prompt, options) => runPiTask(prompt, options);
  await f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel });
  await until(async () => (await f.calls()).some(c => c.args.includes('json')));
  const pid = (await f.calls()).find(c => c.args.includes('json'))!.pid;
  try {
    await f.configure({}); await f.ai.use({ main: chosen.quickModel, quick: chosen.mainModel });
    await pause(150);
    assert.equal(alive(pid), false, 'superseded tiny child is still running');
    await until(() => f.ai.status().state === 'ready');
  } finally { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
});

test('FIX1.7 status correctionModel uses the same injected AI environment as correction calls', async t => {
  const f = await fakePi(t); f.env.MEETING_CORRECTION_MODEL = 'example/correction-override';
  const app = await startServer({ directory: join(f.directory, 'data'), port: 0, recognizer: null, drafts: null, heavy: null,
    ai: { env: f.env }, setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const status = await (await fetch(app.url + '/api/status', { headers: { Cookie: cookie } })).json();
    assert.equal(status.capabilities.correctionModel, 'example/correction-override');
  } finally { await app.close(); }
});

test('FIX1.8 identical roles spawn only one auth probe per readiness pass', async t => {
  const f = await fixture(t, {}, { mainModel: chosen.mainModel, quickModel: chosen.mainModel });
  await f.ai.recheck();
  assert.equal((await f.calls()).filter(c => c.args[0] === 'auth').length, 1);
  await f.ai.use({ main: chosen.quickModel, quick: chosen.quickModel });
  await until(() => f.ai.status().state === 'ready');
  assert.equal((await f.calls()).filter(c => c.args[0] === 'auth').length, 2);
});
