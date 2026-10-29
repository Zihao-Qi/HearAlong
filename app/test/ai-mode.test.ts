import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiModels } from '../src/setup/pi-models.ts';
import { LOCAL_MODELS_EXTENSION, piLaunch, setPiAdmission, setPiKeys, type AiMode } from '../src/pi-command.ts';
import { fakePi } from './helpers/setup-pi.ts';
import { READ_SCOPE_EXTENSION, runPiTask } from '../src/pi-task.ts';
import { PiRpc } from '../src/pi-rpc.ts';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('model listings explicitly load the bundled local-model provider extension', async t => {
  const f = await fakePi(t);
  const reader = new PiModels({ cwd: f.cwd, env: f.env });
  t.after(() => reader.close());
  await reader.read();
  const call = (await f.calls())[0];
  const extension = call.args.findIndex((arg, index) => arg === '-e' && /[/\\]local-models\.ts$/.test(call.args[index + 1] ?? ''));
  assert.notEqual(extension, -1, 'Every model listing must include -e …/local-models.ts.');
});

for (const mode of ['cloud', 'local'] as const) test(`${mode} listing has exact launch arguments`, async t => {
  const f = await fakePi(t);
  const reader = new PiModels({ cwd: f.cwd, env: f.env, mode });
  t.after(() => reader.close());
  await reader.read();
  const call = (await f.calls())[0];
  assert.deepEqual(call.args, [
    '--no-approve',
    ...(mode === 'local' ? ['--no-extensions', '--no-skills'] : []),
    '-e', LOCAL_MODELS_EXTENSION, '--no-context-files', '--list-models',
  ]);
  assert.equal(call.args.includes('--no-extensions'), mode === 'local');
});

test('local launch is offline, excludes credentials, and refuses cloud ids; off refuses every launch', () => {
  setPiKeys({ google: 'fictional-saved-key' });
  try {
    const local = piLaunch([], { mode: 'local', model: 'ollama/example', cwd: '/fictional/scratch', env: { OPENAI_API_KEY: 'fictional-key', ANTHROPIC_AUTH_TOKEN: 'fictional-token' } });
    assert.equal(local.env.PI_OFFLINE, '1');
    assert.equal(local.env.PI_CODING_AGENT_DIR, '/fictional/scratch/.pi-local');
    assert.equal(local.env.PI_TELEMETRY, '0');
    assert.equal(local.env.PI_SKIP_VERSION_CHECK, '1');
    for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(local.env[key], undefined, key);
    assert.throws(() => piLaunch([], { mode: 'local', model: 'openai/example' }), /Only.*local|local.*model/i);
    assert.throws(() => piLaunch([], { mode: 'off' }), /off/i);
  } finally { setPiKeys({}); }
});

for (const mode of ['local', 'cloud'] as const) test(`${mode} tasks and RPC have exact arguments and named environment protections`, async t => {
  const f = await fakePi(t);
  const model = mode === 'local' ? 'ollama/example' : 'example/main';
  f.env.OPENAI_API_KEY = 'fictional-key';
  const prefix = ['--no-approve', ...(mode === 'local' ? ['--no-extensions', '--no-skills', '-e', LOCAL_MODELS_EXTENSION] : [])];
  await runPiTask('Example', { model, aiMode: mode, cwd: f.cwd, env: f.env, tools: null });
  const rpc = new PiRpc({ model, aiMode: mode, cwd: f.cwd, env: f.env });
  try { await rpc.ask('Example'); } finally { await rpc.close(); }
  const python = fileURLToPath(new URL('../pi-extensions/run-python.ts', import.meta.url));
  await runPiTask('Example gated', { model, aiMode: mode, cwd: f.cwd, env: f.env, tools: 'read,run_python', command: f.command, readRoots: [], extensions: [python], processDir: join(f.directory, 'processes') });
  const calls = await f.calls();
  assert.deepEqual(calls[2].args, [...prefix, '--mode', 'json', '--model', model, '--no-context-files', '-e', python, '-e', READ_SCOPE_EXTENSION, '--tools', 'read,run_python', '--no-session', '--', 'Example gated']);
  assert.deepEqual(calls[0].args, [...prefix, '--mode', 'json', '--model', model, '--no-context-files', '--no-tools', ...(mode === 'cloud' ? ['--no-skills'] : []), '--no-session', '--', 'Example']);
  assert.deepEqual(calls[1].args, [...prefix, '--mode', 'rpc', '--no-session', '--no-tools', '--no-context-files', '--model', model, '--thinking', 'low']);
  for (const call of calls) {
    const env = (call as typeof call & { env: Record<string, string | undefined> }).env;
    assert.equal(env.PI_TELEMETRY, '0'); assert.equal(env.PI_SKIP_VERSION_CHECK, '1');
    assert.equal(env.PI_OFFLINE, mode === 'local' ? '1' : undefined);
    assert.equal(env.OPENAI_API_KEY, mode === 'local' ? undefined : 'fictional-key');
  }
});

test('Off and a cloud model in local mode are refused without spawning any Pi path', async t => {
  const f = await fakePi(t);
  for (const [aiMode, model] of [['off', 'example/main'], ['local', 'example/main']] as const) {
    await assert.rejects(runPiTask('Example', { model, aiMode, cwd: f.cwd, env: f.env }), /off|Only local/);
    const rpc = new PiRpc({ model, aiMode, cwd: f.cwd, env: f.env });
    try { await assert.rejects(rpc.ask('Example'), /off|Only local/); } finally { await rpc.close(); }
  }
  assert.throws(() => new PiModels({ cwd: f.cwd, env: f.env, mode: 'off' }).read(), /off/);
  assert.equal((await f.calls()).length, 0);
});

test('a pinned cloud task cannot start another phase after the app changes to local or Off', async t => {
  const f = await fakePi(t);
  let mode: AiMode = 'cloud';
  const release = setPiAdmission(() => mode);
  try {
    const options = { model: 'example/main', cwd: f.cwd, env: f.env, tools: null };
    await runPiTask('First phase', options);
    mode = 'local'; await assert.rejects(runPiTask('Continuation', options), /Only local/);
    mode = 'off'; await assert.rejects(runPiTask('Continuation', options), /off/);
    assert.equal((await f.calls()).length, 1);
  } finally { release(); }
});
