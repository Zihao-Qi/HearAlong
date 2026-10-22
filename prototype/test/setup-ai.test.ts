import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, copyFile, chmod, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePi } from '../src/pi-command.ts';
import { PiModels, parseModels, hasWebPackage } from '../src/setup/pi-models.ts';
import { AiSetup, modelChoices, CHOOSE_AI, type AiSettings } from '../src/setup/ai.ts';
import { ModelRpc } from '../src/pi-rpc.ts';
import { piNotesRunner } from '../src/notes.ts';
import { piActionRunner } from '../src/actions.ts';
import { piTaskArgs, runPiTask } from '../src/pi-task.ts';
import { planModel } from '../src/plans/jobs.ts';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

function useEnvironment(t: any, env: NodeJS.ProcessEnv) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
}
async function fixture(t: any, initial: Record<string, unknown> = {}, saved: AiSettings = { mainModel: null, quickModel: null }) {
  const fake = await fakePi(t, initial);
  let settings = { ...saved }, saves = 0;
  const ai = new AiSetup(() => settings, async next => { settings = { ...settings, ...next }; saves++; }, { cwd: fake.cwd, env: fake.env, cloud: true });
  t.after(() => ai.close());
  return { ...fake, ai, settings: () => settings, saves: () => saves };
}
const chosen = { mainModel: 'example/example-main', quickModel: 'example/example-quick:0' };

test('Pi table requires the six-column header, preserves provider/model and colon ids, and strips ANSI', () => {
  const result = parseModels(`\x1b[1m${table()}\x1b[0m`);
  assert.equal(result.state, 'ok'); assert.equal(result.count, 2); assert.deepEqual(result.providers, ['example']);
  assert.deepEqual(result.models[1], { id: 'example/example-quick:0', provider: 'example', model: 'example-quick:0', context: '32K', maxOut: '4K', thinking: false, images: false });
  for (const bad of ['provider model tokens', table().replace('no  no', 'maybe  no'), 'a warning\n' + table(), 'provider model context max-out thinking images']) assert.equal(parseModels(bad).state, 'unreadable');
});

test('stderr warnings do not affect a valid model table, and probes have app cwd and extensions enabled', async t => {
  const f = await fakePi(t, { stderr: 'Warning: No models match pattern example/*' });
  assert.equal((await new PiModels({ cwd: f.cwd, env: f.env }).read()).state, 'ok');
  const call = (await f.calls())[0]; assert.equal(call.cwd, f.cwd);
  assert.deepEqual(call.args, ['--no-context-files', '--list-models']); assert.ok(!call.args.includes('--no-extensions'));
});

for (const [label, config, state] of [
  ['unknown header', { table: 'provider model tokens' }, 'unreadable'],
  ['signed out', { table: 'No models available. Use /login to log in.' }, 'signed-out'],
  ['nonzero', { listCode: 1 }, 'unreadable'],
] as const) test(`Pi list ${label} is never cached`, async t => {
  const f = await fakePi(t, config), reader = new PiModels({ cwd: f.cwd, env: f.env });
  assert.equal((await reader.read()).state, state); assert.equal((await reader.read()).state, state);
  assert.equal((await f.calls()).length, 2);
});

test('Pi list timeout is unreadable, not cached; spawn ENOENT is not-installed', async t => {
  const f = await fakePi(t, { listDelay: 2000 });
  const reader = new PiModels({ cwd: f.cwd, env: f.env, timeoutMs: 250 });
  assert.equal((await reader.read()).state, 'unreadable');
  await f.configure({}); reader.options.timeoutMs = 3000;
  assert.equal((await reader.read()).state, 'ok');
  assert.equal((await new PiModels({ cwd: f.cwd, env: { MEETING_PI: join(f.directory, 'absent') } }).read()).state, 'not-installed');
  assert.equal((await new PiModels({ cwd: f.cwd, root: f.directory, env: { PATH: '' } }).read()).state, 'not-installed');
});

test('concurrent reads including refresh share one spawn, ok expires at five minutes, explicit refresh bypasses cache', async t => {
  const f = await fakePi(t, { listDelay: 100 }); let now = 10;
  const reader = new PiModels({ cwd: f.cwd, env: f.env, clock: () => now });
  const [first, second] = await Promise.all([reader.read(), reader.read(true)]); assert.equal(first, second);
  assert.equal((await f.calls()).length, 1);
  now += 299_999; assert.equal(await reader.read(), first);
  now++; assert.notEqual(await reader.read(), first); assert.equal((await f.calls()).length, 2);
  await reader.read(true); assert.equal((await f.calls()).length, 3);
});

test('executable resolution: explicit override > PATH > bundled > absent', async t => {
  const f = await fakePi(t), root = join(f.directory, 'app'), bin = join(root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true }); const bundled = join(bin, 'pi');
  await copyFile(f.command, bundled); await chmod(bundled, 0o755);
  assert.equal(resolvePi({ root, env: { MEETING_PI: '/override/pi', PATH: f.directory } }), '/override/pi');
  assert.equal(resolvePi({ root, env: { PATH: f.directory } }), f.command);
  assert.equal(resolvePi({ root, env: { PATH: '' } }), bundled);
  assert.equal(resolvePi({ root: f.directory, env: { PATH: '' } }), null);
});

test('default names prefer openai-codex, then the first other provider, never an unrelated model', async t => {
  const f = await fixture(t, { table: table(['fictional gpt-6.1-sol 1M 8K yes yes', 'fictional gpt-6-luna 1M 8K yes yes', 'openai-codex gpt-6.1-sol 1M 8K yes yes', 'openai-codex gpt-6-luna 1M 8K yes yes']) });
  await f.ai.recheck();
  assert.deepEqual(f.ai.status().main, { id: 'openai-codex/gpt-6.1-sol', source: 'default' });
  assert.deepEqual(f.ai.status().quick, { id: 'openai-codex/gpt-6-luna', source: 'default' }); assert.equal(f.ai.status().state, 'ready'); assert.equal(f.saves(), 0);
  await f.configure({ table: table(['fictional gpt-6.1-sol 1M 8K yes yes', 'fictional gpt-6-luna 1M 8K yes yes']) }); await f.ai.recheck();
  assert.equal(f.ai.current('main'), 'fictional/gpt-6.1-sol'); assert.equal(f.ai.current('quick'), 'fictional/gpt-6-luna');
  await f.configure({}); await f.ai.recheck(); assert.equal(f.ai.status().state, 'choose'); assert.equal(f.ai.current('main'), null);
});

test('a runner refreshing expired defaults also starts readiness for the newly effective models', async t => {
  const defaults = (provider: string) => table([`${provider} gpt-6.1-sol 1M 8K yes yes`, `${provider} gpt-6-luna 1M 8K yes yes`]);
  const f = await fixture(t, { table: defaults('openai-codex') }); let now = 0; f.ai.reader.options.clock = () => now;
  await f.ai.recheck(); assert.equal(f.ai.status().state, 'ready');
  await f.configure({ table: defaults('fictional') }); now = 300_000;
  assert.equal(await f.ai.require('main'), 'openai-codex/gpt-6.1-sol', 'runner returns stale defaults without blocking');
  await until(() => f.ai.status().main?.id === 'fictional/gpt-6.1-sol' && f.ai.status().state === 'ready');
  assert.equal(await f.ai.require('main'), 'fictional/gpt-6.1-sol'); assert.equal(f.ai.status().quick?.id, 'fictional/gpt-6-luna');
});

test('missing saved models do not fall back; env wins; unreadable lists preserve saved ids', async t => {
  const f = await fixture(t, {}, { mainModel: 'example/removed', quickModel: chosen.quickModel });
  await f.ai.recheck(); assert.equal(f.ai.status().state, 'missing');
  await assert.rejects(f.ai.require('main'), { message: 'example/removed is no longer listed by Pi. Choose AI models in setup.' });
  assert.deepEqual(modelChoices(f.settings(), f.ai.reader.last, { MEETING_HEAVY_MODEL: 'env/model' }).main, { choice: { id: 'env/model', source: 'env' }, missing: false });
  await f.configure({ table: 'unrecognized' }); await f.ai.recheck();
  assert.equal(await f.ai.require('main'), 'example/removed'); assert.equal(f.ai.status().state, 'unreadable');
});

for (const [label, config, detail] of [
  ['not ready', { auth: { status: 'not_ready', reason: 'quota unavailable\ntry later' } }, 'quota unavailable try later'],
  ['invalid JSON', { authRaw: 'not json' }, "Couldn't check Pi's access."],
  ['unknown status', { auth: { status: 'invalid' }, authCode: 2 }, "Couldn't check Pi's access."],
] as const) test(`auth ${label} produces no-access with one-line reason and never requests credentials`, async t => {
  const f = await fixture(t, config, chosen); await f.ai.recheck();
  assert.equal(f.ai.status().state, 'no-access'); assert.equal(f.ai.status().detail, detail);
  for (const call of (await f.calls()).filter(c => c.args[0] === 'auth')) {
    assert.deepEqual(call.args, ['auth', 'check', '--model', call.model, '--json', '--no-refresh']); assert.ok(!call.args.includes('--credentials'));
  }
});

test('auth timeout is unknown, not proof of readiness', async t => {
  const f = await fakePi(t, { authDelay: 2000 });
  assert.equal((await new PiModels({ cwd: f.cwd, env: f.env, timeoutMs: 250 }).auth(chosen.mainModel)).state, 'unknown');
});

test('installed web package needs its following installed-path line; failed list clears it on recheck', async t => {
  assert.equal(hasWebPackage('User packages:\n  npm:pi-web-access\n'), false);
  assert.equal(hasWebPackage('User packages:\n  npm:pi-web-access\n  npm:other\n    /other\n'), false);
  assert.equal(hasWebPackage('User packages:\n  npm:pi-web-access-extra\n    /package\n'), false);
  const packages = 'User packages:\n  npm:pi-web-access@0.0.1 (filtered)\n    /example/package\n';
  assert.equal(hasWebPackage(packages), true);
  const f = await fixture(t, { packages }, chosen); await f.ai.recheck(); assert.equal(f.ai.status().web, true);
  await f.configure({ packages, webCode: 1 }); await f.ai.recheck(); assert.equal(f.ai.status().web, false);
});

test('tiny quick call uses no tools and a 60s deadline, failure is no-access; recheck makes no tiny call', async t => {
  const f = await fixture(t, { taskError: 'access denied\nno quota' }); useEnvironment(t, f.env);
  await f.ai.recheck(); await f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel });
  assert.equal(f.ai.status().state, 'checking');
  await until(() => f.ai.status().state === 'no-access'); assert.match(f.ai.status().detail!, /access denied no quota/);
  let tasks = (await f.calls()).filter(c => c.args.includes('json')); assert.equal(tasks.length, 1);
  assert.equal(tasks[0].model, chosen.quickModel); assert.ok(tasks[0].args.includes('--no-tools')); assert.ok(tasks[0].args.includes('--no-skills'));
  await f.configure({}); await f.ai.recheck(); assert.equal(f.ai.status().state, 'ready');
  tasks = (await f.calls()).filter(c => c.args.includes('json')); assert.equal(tasks.length, 1);
  const seen: number[] = [];
  const ai = new AiSetup(f.settings, async () => {}, { cwd: f.cwd, env: f.env, cloud: true, tiny: async (prompt, options) => { seen.push(options.timeoutMs!); assert.equal(prompt, 'Reply with OK.'); return runPiTask(prompt, options); } });
  await ai.use({ main: chosen.mainModel, quick: chosen.quickModel }); await until(() => ai.status().state === 'ready');
  assert.deepEqual(seen, [60_000]); await ai.close();
});

test('metadata completing late cannot bypass the tiny call or lose web detection; refreshing models keeps checking', async t => {
  const f = await fixture(t, { webDelay: 300, taskDelay: 900, packages: 'User packages:\n  npm:pi-web-access\n    /example/web\n' });
  f.ai.start(); await f.ai.reader.read();
  await f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel });
  await until(async () => (await f.calls()).some(c => c.args.includes('json')));
  await f.ai.models(true); assert.equal(f.ai.status().state, 'checking');
  await until(() => f.ai.web); assert.equal(f.ai.status().state, 'checking');
  await until(() => f.ai.status().state === 'ready');
});

test('derived model overrides remain verbatim and work even without a main model', async t => {
  const f = await fixture(t);
  f.env.MEETING_CORRECTION_MODEL = 'example/special:0';
  assert.equal(await f.ai.correction(), 'example/special:0');
  useEnvironment(t, { PLAN_MODEL: 'fictional/plan:medium', EXPLORE_MODEL: 'fictional/explore:0' });
  const unavailable = async (): Promise<string> => { throw new Error(CHOOSE_AI); };
  assert.equal(await planModel('plan', unavailable), 'fictional/plan:medium');
  assert.equal(await planModel('explore', unavailable), 'fictional/explore:0');
});

test('cloud off means no Pi subprocesses, including discovery endpoints and model calls', async t => {
  const f = await fakePi(t);
  const ai = new AiSetup(() => chosen, async () => assert.fail('must not save'), { cwd: f.cwd, env: f.env, cloud: false });
  ai.start(); await ai.recheck(); await ai.models(true);
  await assert.rejects(ai.require('main'), { message: CHOOSE_AI }); await assert.rejects(ai.correction(), { message: CHOOSE_AI });
  assert.equal(ai.status().state, 'off'); assert.equal(ai.current('main'), null); assert.deepEqual(await f.calls(), []); await ai.close();
});

test('warm correction and board lanes replace processes, old calls keep their model and drain', async t => {
  const f = await fixture(t, { taskDelay: 200 }, chosen); useEnvironment(t, f.env);
  const correction = new ModelRpc(() => f.ai.correction(), { cwd: f.cwd });
  const board = new ModelRpc(() => f.ai.require('quick'), { cwd: f.cwd });
  t.after(async () => { await correction.close(); await board.close(); });
  const oldCorrection = correction.ask('first'), oldBoard = board.ask('first');
  await until(async () => (await f.calls()).filter(c => c.args.includes('rpc')).length === 2);
  await f.ai.use({ main: chosen.quickModel, quick: chosen.mainModel });
  const nextCorrection = correction.ask('second'), nextBoard = board.ask('second');
  const before = await Promise.all([oldCorrection, oldBoard]), after = await Promise.all([nextCorrection, nextBoard]);
  assert.match(before[0].text, /^example\/example-main:/); assert.match(before[1].text, /^example\/example-quick:0:/);
  assert.match(after[0].text, /^example\/example-quick:0:/); assert.match(after[1].text, /^example\/example-main:/);
  assert.notEqual(before[0].text.split(':').at(-1), after[0].text.split(':').at(-1));
  assert.notEqual(before[1].text.split(':').at(-1), after[1].text.split(':').at(-1));
});

test('notes and action runners resolve each call, running task keeps its model; plan thinking never splits colon ids', async t => {
  const f = await fixture(t, { taskDelay: 150 }, chosen); useEnvironment(t, f.env);
  const notes = piNotesRunner(() => f.ai.require('main'));
  const actions = piActionRunner(() => f.ai.require('main'));
  const input = { instructions: 'Reply OK', inputPath: join(f.directory, 'input.md'), cwd: f.cwd, sessionDir: join(f.directory, 'sessions'), signal: new AbortController().signal };
  const old = notes(input); await until(async () => (await f.calls()).some(c => c.args.includes('json')));
  await f.ai.use({ main: chosen.quickModel, quick: chosen.quickModel });
  await old; await notes(input);
  await actions({ ...input, action: 'explain', tools: 'read', onEvent: () => {}, processDir: join(f.directory, 'processes') });
  const tasks = (await f.calls()).filter(c => c.args.includes('json'));
  assert.equal(tasks[0].model, chosen.mainModel); assert.equal(tasks.at(-1)!.model, chosen.quickModel); assert.equal(tasks.at(-2)!.model, chosen.quickModel);
  const model = await planModel('plan', () => f.ai.require('main')); assert.equal(model, chosen.quickModel);
  assert.equal(await planModel('explore', () => f.ai.require('main')), chosen.quickModel);
  const args = piTaskArgs('Plan', { cwd: f.cwd, model, thinking: 'low' });
  assert.equal(args[args.indexOf('--model') + 1], 'example/example-quick:0'); assert.equal(args[args.indexOf('--thinking') + 1], 'low');
});

async function serverFixture(t: any, initial: Record<string, unknown> = {}, saved: object = {}) {
  const f = await fakePi(t, initial); useEnvironment(t, f.env);
  const data = join(f.directory, 'data'); await mkdir(data); await writeFile(join(data, 'settings.json'), JSON.stringify(saved));
  const app = await startServer({ directory: data, port: 0, recognizer: null, drafts: null, quick: null, heavy: null,
    ai: { env: f.env }, setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(() => app.close());
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', value?: unknown, headers = {}) => fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const row = async () => (await (await request('/api/setup')).json()).rows.find((r: any) => r.id === 'ai');
  return { ...f, app, data, request, row };
}

test('setup AI endpoints validate before saving, apply both ids atomically and return checking immediately', async t => {
  const f = await serverFixture(t, { authDelay: 200, taskDelay: 200 });
  const before = await readFile(join(f.data, 'settings.json'), 'utf8');
  let response = await f.request('/api/setup/ai', 'PUT', { main: 'example/not-listed', quick: chosen.quickModel });
  assert.equal(response.status, 400); assert.equal((await response.json()).error, "Pi doesn't list example/not-listed.");
  assert.equal(await readFile(join(f.data, 'settings.json'), 'utf8'), before);
  response = await f.request('/api/setup/ai', 'PUT', { main: chosen.mainModel, quick: chosen.quickModel }); assert.equal(response.status, 200);
  assert.equal((await response.json()).rows.find((r: any) => r.id === 'ai').state, 'checking');
  const saved = JSON.parse(await readFile(join(f.data, 'settings.json'), 'utf8')); assert.equal(saved.mainModel, chosen.mainModel); assert.equal(saved.quickModel, chosen.quickModel);
  await until(async () => (await f.row()).state === 'ready');
  const settings = await (await f.request('/api/settings')).json();
  assert.deepEqual(settings.boardModels, [{ id: 'quick', model: chosen.quickModel }, { id: 'main', model: chosen.mainModel }]);
  const caps = (await (await f.request('/api/status')).json()).capabilities; assert.equal(caps.mainModel, chosen.mainModel);
  const calls = (await f.calls()).filter(c => c.args.includes('--list-models')).length;
  const listed = await (await f.request('/api/setup/ai/models?refresh=1')).json(); assert.equal(listed.count, 2);
  assert.equal((await f.calls()).filter(c => c.args.includes('--list-models')).length, calls + 1);
  for (const [path, method] of [['/api/setup/ai', 'PUT'], ['/api/setup/recheck', 'POST']] as const) assert.equal((await f.request(path, method, {}, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await fetch(`${f.app.url}/api/setup/ai/models`)).status, 403);
  assert.equal((await f.request('/api/setup/ai/models', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/api/settings', 'PUT', { mainModel: chosen.mainModel })).status, 400);
});

test('AI settings reject an environment-controlled role with 400 and no disk changes', async t => {
  const f = await serverFixture(t); f.env.MEETING_HEAVY_MODEL = chosen.mainModel;
  const before = await readFile(join(f.data, 'settings.json'), 'utf8');
  const response = await f.request('/api/setup/ai', 'PUT', { main: chosen.quickModel, quick: chosen.quickModel });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /set by the environment/);
  assert.equal(await readFile(join(f.data, 'settings.json'), 'utf8'), before);
});

test('saving re-reads an expired catalog and rejects a formerly listed id without a save', async t => {
  const f = await fixture(t); let now = 0; f.ai.reader.options.clock = () => now;
  await f.ai.reader.read(); await f.configure({ table: table(['example replacement 32K 4K no no']) }); now = 300_000;
  await assert.rejects(f.ai.use({ main: chosen.mainModel, quick: chosen.quickModel }), { message: `Pi doesn't list ${chosen.mainModel}.` });
  assert.equal(f.saves(), 0); assert.equal((await f.calls()).filter(c => c.args.includes('--list-models')).length, 2);
});

for (const [legacy, expected] of [['luna', 'quick'], ['sol', 'main']] as const) test(`saved board ${legacy} migrates to ${expected}`, async t => {
  const f = await serverFixture(t, {}, { boardModel: legacy });
  let settings = await (await f.request('/api/settings')).json(); assert.equal(settings.boardModel, expected);
  assert.equal((await f.request('/api/settings', 'PUT', { boardModel: 'main' })).status, 200);
  settings = JSON.parse(await readFile(join(f.data, 'settings.json'), 'utf8')); assert.equal(settings.boardModel, 'main');
  assert.equal((await f.request('/api/settings', 'PUT', { boardModel: 'sol' })).status, 400);
});

test('startup returns while Pi is still reading; MEETING_CLOUD=0 keeps server AI off without spawning', async t => {
  const f = await serverFixture(t, { listDelay: 1000 });
  assert.equal((await f.row()).state, 'reading');
  await f.app.close();
  process.env.MEETING_CLOUD = '0';
  const before = (await f.calls()).length;
  const app = await startServer({ directory: join(f.directory, 'off'), port: 0, recognizer: null, drafts: null, ai: { env: f.env }, setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const status = await (await fetch(`${app.url}/api/setup`, { headers: { Cookie: cookie } })).json(); assert.equal(status.rows.find((r: any) => r.id === 'ai').state, 'off');
    assert.equal((await f.calls()).length, before);
  } finally { await app.close(); }
});
