import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { piEnv, setPiKeys } from '../src/pi-command.ts';
import { ApiKeys, Keychain, checkKey } from '../src/setup/api-keys.ts';
import { startServer } from '../src/server.ts';
import { fakeProviders, fakeSecurity } from './helpers/api-keys.ts';
import { PiModels } from '../src/setup/pi-models.ts';
import { ModelRpc } from '../src/pi-rpc.ts';
import { runPiTask } from '../src/pi-task.ts';
import { fakePi, until } from './helpers/setup-pi.ts';

const GEMINI = 'AIza-fictional-gemini-key-0001';
const OPENAI = 'sk-fictional-openai-key-0002';
function useEnvironment(t: any, env: NodeJS.ProcessEnv) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
}
function useKeys(t: any, keys: Parameters<typeof setPiKeys>[0]) { setPiKeys(keys); t.after(() => setPiKeys({})); }
const PRIVATE = { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };

test('the env builder adds saved keys and turns telemetry off; an environment credential wins; omit leaves one key out', t => {
  useKeys(t, { google: GEMINI, openai: OPENAI, anthropic: 'sk-ant-fictional' });
  const env = piEnv({ PATH: '/bin', PI_TELEMETRY: '1' });
  assert.equal(env.GEMINI_API_KEY, GEMINI); assert.equal(env.OPENAI_API_KEY, OPENAI); assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fictional');
  assert.equal(env.PI_TELEMETRY, '0'); assert.equal(env.PI_SKIP_VERSION_CHECK, '1'); assert.equal(env.PATH, '/bin');
  assert.equal(piEnv({ GEMINI_API_KEY: 'from-env' }).GEMINI_API_KEY, 'from-env');
  // Pi reads Anthropic's tokens before its key: an environment token means the saved key would never be used.
  assert.equal(piEnv({ ANTHROPIC_OAUTH_TOKEN: 'token' }).ANTHROPIC_API_KEY, undefined);
  assert.equal(piEnv({}, 'google').GEMINI_API_KEY, undefined);
  setPiKeys({});
  assert.deepEqual(piEnv({ PATH: '/bin' }), { PATH: '/bin', ...PRIVATE });
});

test('every Pi spawn path gets the saved keys and the privacy variables: listing, packages, auth, tasks, process groups, warm lanes', async t => {
  const f = await fakePi(t);
  useEnvironment(t, { MEETING_PI: f.command, FAKE_PI_STATE: f.state, PI_CODING_AGENT_DIR: join(f.directory, 'agent') });
  useKeys(t, { google: GEMINI, openai: OPENAI });
  const expected = { GEMINI_API_KEY: GEMINI, OPENAI_API_KEY: OPENAI, ...PRIVATE };
  const reader = new PiModels({ cwd: f.cwd, env: f.env });
  await reader.read(); await reader.web(); await reader.auth('example/example-main');
  await runPiTask('Reply with OK.', { model: 'example/example-main', cwd: f.cwd, tools: null });
  await runPiTask('Reply with OK.', { model: 'example/example-main', cwd: f.cwd, tools: null, processDir: join(f.directory, 'processes') });
  const lane = new ModelRpc(async () => 'example/example-quick:0', { cwd: f.cwd });
  t.after(() => lane.close());
  await lane.ask('Hello');
  const calls = await f.calls();
  assert.equal(calls.length, 6);
  for (const call of calls as any[]) assert.deepEqual(call.env, expected, call.args.join(' '));
});

test('the warm lane restarts when the saved keys change, so the next request sees them', async t => {
  const f = await fakePi(t);
  useEnvironment(t, { MEETING_PI: f.command, FAKE_PI_STATE: f.state });
  useKeys(t, {});
  const lane = new ModelRpc(async () => 'example/example-quick:0', { cwd: f.cwd });
  t.after(() => lane.close());
  await lane.ask('one'); setPiKeys({ google: GEMINI }); await lane.ask('two');
  await until(async () => (await f.calls()).length === 2);
  const [first, second] = await f.calls() as any[];
  assert.notEqual(first.pid, second.pid);
  assert.equal(first.env.GEMINI_API_KEY, undefined); assert.equal(second.env.GEMINI_API_KEY, GEMINI);
});

test('the Keychain gets the key on stdin only, hex-encoded, never in any argv; read, update and remove work', async t => {
  const security = await fakeSecurity(t);
  useEnvironment(t, security.env);
  const keychain = new Keychain();
  const key = `AIza-te"st$\`\\ '%x;&|*key#END`;
  assert.equal(await keychain.read('google'), null);
  await keychain.write('google', key);
  assert.equal(await keychain.read('google'), key);
  await keychain.write('google', 'AIza-second-fictional-key');
  assert.equal(await keychain.read('google'), 'AIza-second-fictional-key');
  await keychain.remove('google'); await keychain.remove('google'); // removing twice is fine
  assert.equal(await keychain.read('google'), null);
  const calls = await security.calls();
  for (const secret of [key, Buffer.from(key).toString('hex'), 'AIza-second-fictional-key']) {
    assert.ok(calls.every(call => !call.args.some(arg => arg.includes(secret))), 'a key or its hex reached argv');
    assert.ok(calls.every(call => !call.stdin.includes(key)), 'the raw key reached stdin');
  }
  const writes = calls.filter(call => call.args[0] === '-i');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].args, ['-i']);
  assert.equal(writes[0].stdin, `add-generic-password -U -s HearAlong -a google -X ${Buffer.from(key).toString('hex')}\n`);
  assert.deepEqual(calls.find(call => call.args[0] === 'find-generic-password')!.args, ['find-generic-password', '-s', 'HearAlong', '-a', 'google', '-w']);
  // A failing tool: nothing is claimed saved or read.
  process.env.FAKE_SECURITY_FAIL = '1';
  await assert.rejects(keychain.write('openai', 'sk-fictional-openai-key'), /Couldn’t save the key/);
  await assert.rejects(keychain.read('openai'), /Couldn’t read the key/);
  await assert.rejects(keychain.remove('openai'), /Couldn’t remove the key/);
  assert.throws(() => new Keychain('/usr/bin/security', '/tmp/with space.keychain-db'), /spaces or quotes/);
});

test('a key is checked against the provider’s model list: accepted, rejected (400/401), unavailable, unreachable; the key stays out of URLs and messages', async t => {
  const providers = await fakeProviders(t, { google: GEMINI, openai: OPENAI, anthropic: 'sk-ant-fictional-key' });
  await checkKey('google', GEMINI, providers.env); await checkKey('openai', OPENAI, providers.env); await checkKey('anthropic', 'sk-ant-fictional-key', providers.env);
  assert.equal(providers.requests[0].url, '/google/v1beta/models?pageSize=1'); assert.equal(providers.requests[0].headers['x-goog-api-key'], GEMINI);
  assert.equal(providers.requests[1].headers.authorization, `Bearer ${OPENAI}`);
  assert.equal(providers.requests[2].headers['anthropic-version'], '2023-06-01');
  assert.ok(providers.requests.every(request => !request.url.includes(GEMINI) && !request.url.includes(OPENAI)));
  for (const [provider, company] of [['google', 'Google'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic']] as const) {
    await assert.rejects(checkKey(provider, 'wrong-fictional-key', providers.env), (error: any) => {
      assert.equal(error.message, `${company} didn’t accept this key. Check it and try again.`); assert.equal(error.status, 400); return true;
    });
  }
  providers.state.status = 503;
  await assert.rejects(checkKey('openai', OPENAI, providers.env), /OpenAI couldn’t check the key right now \(HTTP 503\)/);
  providers.state.status = 0;
  const closed = { MEETING_GOOGLE_API_BASE: 'http://127.0.0.1:9/google' };
  await assert.rejects(checkKey('google', GEMINI, closed), (error: any) => {
    assert.equal(error.message, 'Couldn’t reach Google. Check the connection.'); assert.ok(!error.message.includes(GEMINI)); return true;
  });
});

const GOOGLE_ROWS = ['google gemini-fictional-pro 1M 64K yes yes', 'google gemini-fictional-flash 1M 64K yes yes'];
async function keysServer(t: any, initial: Record<string, unknown> = {}, saved: object = {}, extraEnv: NodeJS.ProcessEnv = {}) {
  const security = await fakeSecurity(t);
  const providers = await fakeProviders(t, { google: GEMINI, openai: OPENAI });
  let remove!: () => unknown;
  const f = await fakePi({ after: fn => { remove = fn; } }, { keyRows: { google: GOOGLE_ROWS }, ...initial });
  Object.assign(f.env, providers.env, extraEnv);
  useEnvironment(t, { ...f.env, ...security.env });
  const logs: string[] = [];
  const console_ = { log: console.log, warn: console.warn, error: console.error };
  for (const name of ['log', 'warn', 'error'] as const) console[name] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await app?.close(); Object.assign(console, console_); await remove(); });
  const data = join(f.directory, 'data'); await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), JSON.stringify({ aiMode: 'cloud', cloudConsent: { providers: ['example', 'google'], time: 1, legacy: true }, ...saved }));
  const start = async () => {
    app = await startServer({ directory: data, port: 0, recognizer: null, drafts: null, quick: null, heavy: null,
      ai: { env: f.env }, setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    return (path: string, method = 'GET', value?: unknown) => fetch(`${app!.url}${path}`, { method, headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  };
  let request = await start();
  const responses: string[] = [];
  const call = async (path: string, method = 'GET', value?: unknown) => {
    const response = await request(path, method, value), text = await response.text(); responses.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  const keys = async (fresh = true) => Object.fromEntries((await call(`/api/setup/ai/keys${fresh ? '?fresh=1' : ''}`)).body.keys.map((k: any) => [k.provider, k]));
  const settings = async () => JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
  const restart = async () => { await app!.close(); request = await start(); };
  return { f, security, providers, data, call, keys, settings, logs, responses, restart };
}

test('saving a key: rejected and unreachable save nothing; a good key is stored, listed at once, and its models can be chosen; removing resets them', async t => {
  const s = await keysServer(t, {}, { mainModel: 'example/example-main', quickModel: 'example/example-quick:0' });
  assert.deepEqual(Object.values(await s.keys()).map((k: any) => k.state), ['none', 'none', 'none']);
  let response = await s.call('/api/setup/ai/keys/google', 'PUT', { key: 'AIza-wrong-fictional-key' });
  assert.equal(response.status, 400); assert.equal(response.body.error, 'Google didn’t accept this key. Check it and try again.');
  s.f.env.MEETING_GOOGLE_API_BASE = 'http://127.0.0.1:9/google';
  response = await s.call('/api/setup/ai/keys/google', 'PUT', { key: GEMINI });
  assert.equal(response.status, 502); assert.equal(response.body.error, 'Couldn’t reach Google. Check the connection.');
  s.f.env.MEETING_GOOGLE_API_BASE = s.providers.env.MEETING_GOOGLE_API_BASE;
  assert.deepEqual(await s.security.store(), {}); assert.equal((await s.settings()).apiKeys, undefined);
  assert.equal((await s.call('/api/setup/ai/keys/google', 'PUT', { key: 'short' })).status, 400);
  assert.equal((await s.call('/api/setup/ai/keys/mistral', 'PUT', { key: GEMINI })).status, 404);

  response = await s.call('/api/setup/ai/keys/google', 'PUT', { key: ` ${GEMINI}\n` });
  assert.equal(response.status, 200);
  assert.equal(response.body.models.count, 4); assert.ok(response.body.models.models.some((m: any) => m.id === 'google/gemini-fictional-pro'));
  assert.deepEqual(response.body.keys.find((k: any) => k.provider === 'google'), { provider: 'google', state: 'saved', last4: '0001', models: 2 });
  assert.deepEqual(await s.security.store(), { 'HearAlong/google': GEMINI });
  assert.deepEqual((await s.settings()).apiKeys, ['google']);
  // Pi was asked without the key (a sign-in of its own?) and with it (does Pi find a credential?).
  const checks = (await s.f.calls() as any[]).filter(c => c.args.includes('--provider') && c.args.includes('google'));
  assert.ok(checks.some(c => c.env.GEMINI_API_KEY === undefined) && checks.some(c => c.env.GEMINI_API_KEY === GEMINI));

  assert.equal((await s.call('/api/setup/ai', 'PUT', { main: 'google/gemini-fictional-pro', quick: 'example/example-quick:0' })).status, 200);
  response = await s.call('/api/setup/ai/keys/google', 'DELETE');
  assert.equal(response.status, 200); assert.deepEqual(response.body.reset, ['main']);
  assert.equal(response.body.models.count, 2); assert.equal(response.body.keys.find((k: any) => k.provider === 'google').state, 'none');
  const saved = await s.settings(); assert.equal(saved.mainModel, null); assert.equal(saved.quickModel, 'example/example-quick:0'); assert.deepEqual(saved.apiKeys, []);
  assert.deepEqual(await s.security.store(), {});

  // The key never reaches the data folder, the server's output or an HTTP response.
  const files = await readdir(s.data, { recursive: true, withFileTypes: true });
  for (const file of files.filter(entry => entry.isFile())) assert.ok(!(await readFile(join(file.parentPath, file.name), 'utf8')).includes(GEMINI), `${file.name} holds the key`);
  for (const text of [...s.logs, ...s.responses]) assert.ok(!text.includes(GEMINI) && !text.includes('wrong-fictional'), 'a key reached the output');
});

test('a saved key is read from the Keychain at start (only when one was saved) and given to Pi', async t => {
  const s = await keysServer(t);
  assert.equal((await s.security.calls()).length, 0); // nothing saved: the Keychain is never touched
  assert.equal((await s.call('/api/setup/ai/keys/google', 'PUT', { key: GEMINI })).status, 200);
  await s.restart();
  assert.equal((await s.call('/api/setup/ai/models?refresh=1')).body.count, 4);
  const lists = (await s.f.calls() as any[]).filter(c => c.args.includes('--list-models'));
  assert.equal(lists.at(-1).env.GEMINI_API_KEY, GEMINI);
  assert.deepEqual((await s.keys()).google, { provider: 'google', state: 'saved', last4: '0001', models: 2 });
});

test('Pi’s own sign-in: no key offered; a saved key it overrides says so; the environment wins too; an unknown check offers the button', async t => {
  const s = await keysServer(t, { stored: ['anthropic'] }, {}, { OPENAI_API_KEY: 'sk-fictional-env-key' });
  let keys = await s.keys();
  assert.deepEqual([keys.google.state, keys.openai.state, keys.anthropic.state], ['none', 'env', 'pi']);
  const refused = await s.call('/api/setup/ai/keys/openai', 'PUT', { key: OPENAI });
  assert.equal(refused.status, 409); assert.deepEqual(await s.security.store(), {});
  assert.equal((await s.call('/api/setup/ai/keys/google', 'PUT', { key: GEMINI })).status, 200);
  await s.f.configure({ keyRows: { google: GOOGLE_ROWS }, stored: ['anthropic', 'google'] }); // the user signs in through Pi later
  keys = await s.keys();
  assert.deepEqual(keys.google, { provider: 'google', state: 'shadowed', by: 'pi', last4: '0001', models: 2 });
  await s.f.configure({ keyRows: { google: GOOGLE_ROWS }, providerAuthRaw: 'Something unexpected' });
  keys = await s.keys();
  assert.deepEqual([keys.google.state, keys.anthropic.state], ['saved', 'none']);
});

test('a Pi that does not pick up the key: nothing stays saved', async t => {
  const s = await keysServer(t, { ignoreEnv: true });
  const response = await s.call('/api/setup/ai/keys/google', 'PUT', { key: GEMINI });
  assert.equal(response.status, 502); assert.equal(response.body.error, 'Pi didn’t pick up the key. Nothing was saved.');
  assert.deepEqual(await s.security.store(), {}); assert.deepEqual((await s.settings()).apiKeys, []);
  assert.equal(piEnv({}).GEMINI_API_KEY, undefined);
});

// Review round 1: failed saves never change the durable key unnoticed, nothing changes after close, and refreshes are fresh.
const OLD = 'fictional-old-google-key', NEW = 'fictional-new-google-key';
function keyState(options: { writeFails?: 'after-update' | 'before'; restoreFails?: boolean; auth?: 'ready' | 'not_ready' | 'unknown'; saved?: string[]; disk?: string | null } = {}) {
  let disk: string | null = options.disk === undefined ? OLD : options.disk, writes = 0;
  const state = { apiKeys: options.saved ?? ['google'], apiKeysUnconfirmed: [] as string[] };
  const keychain = {
    read: async () => disk,
    write: async (_provider: string, value: string) => {
      writes++;
      if (options.restoreFails && writes > 1) throw new Error('locked during rollback');
      if (options.writeFails === 'before' && writes === 1) throw new Error('could not start');
      disk = value;
      if (options.writeFails === 'after-update' && writes === 1) throw new Error('read-back failed after update');
    },
    remove: async () => { disk = null; },
  };
  const make = () => new ApiKeys({ saved: () => state as any, persist: async (value: any) => { Object.assign(state, value); }, keychain: keychain as any, env: {},
    reader: { providerAuth: async () => options.auth ?? 'ready' } as any, fetch: async () => new Response('{}') });
  return { make, disk: () => disk, state };
}

test('a failed Keychain write (after the item changed, or before) restores and verifies the previous key: nothing changed', async t => {
  t.after(() => setPiKeys({}));
  for (const writeFails of ['after-update', 'before'] as const) {
    const s = keyState({ writeFails }), keys = s.make(); await keys.load();
    await assert.rejects(keys.add('google', NEW), (error: any) => { assert.equal(error.message, 'Couldn’t save the Google key in this Mac’s Keychain. Nothing was changed.'); return true; });
    assert.equal(s.disk(), OLD); assert.equal(piEnv({}).GEMINI_API_KEY, OLD); assert.deepEqual(s.state.apiKeys, ['google']);
    await keys.close();
    const again = s.make(); await again.load(); assert.equal(piEnv({}).GEMINI_API_KEY, OLD); await again.close();
  }
});

test('a rollback that cannot be verified says the key may have changed; that key is reported, not used, also after a restart', async t => {
  t.after(() => setPiKeys({}));
  const s = keyState({ restoreFails: true, auth: 'not_ready' }), keys = s.make(); await keys.load();
  await assert.rejects(keys.add('google', NEW), (error: any) => {
    assert.equal(error.message, 'Pi didn’t pick up the key, and the Google key on this Mac may have changed. Remove it and add it again.');
    assert.ok(!error.message.includes('Nothing was saved')); return true;
  });
  assert.equal(s.disk(), NEW); assert.equal(piEnv({}).GEMINI_API_KEY, undefined);
  assert.deepEqual(s.state.apiKeysUnconfirmed, ['google']);
  await keys.close();
  const again = s.make(); await again.load();
  assert.equal(piEnv({}).GEMINI_API_KEY, undefined, 'an unconfirmed key is never used');
  assert.deepEqual((await again.list()).find(k => k.provider === 'google'), { provider: 'google', state: 'unconfirmed' });
  await again.remove('google');
  assert.equal(s.disk(), null); assert.deepEqual([s.state.apiKeys, s.state.apiKeysUnconfirmed], [[], []]);
  await again.close();
});

test('closed key setup refuses changes and leaves no key behind', async t => {
  t.after(() => setPiKeys({}));
  const s = keyState({ disk: null, saved: [] }), keys = s.make(); await keys.load(); await keys.close();
  await assert.rejects(keys.add('google', NEW), (error: any) => error.status === 503);
  await assert.rejects(keys.remove('google'), (error: any) => error.status === 503);
  assert.equal(s.disk(), null); assert.equal(piEnv({}).GEMINI_API_KEY, undefined); assert.deepEqual(s.state.apiKeys, []);
});

test('a PUT whose body arrives after shutdown began saves nothing and leaves no key active', async t => {
  const f = await fakePi(t);
  const data = join(f.directory, 'data'); await mkdir(data);
  let durable: string | undefined;
  const app = await startServer({ directory: data, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null, plans: null,
    ai: { env: f.env }, keys: { keychain: { read: async () => durable ?? null, write: async (_p: string, key: string) => { durable = key; }, remove: async () => { durable = undefined; } } as any, fetch: async () => new Response('{}') },
    setup: { scan: { home: f.directory, envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(async () => { await app.close(); setPiKeys({}); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const { request } = await import('node:http');
  const body = JSON.stringify({ key: 'fictional-late-http-google-key' });
  let finish!: () => void;
  const completed = new Promise<{ status?: number }>(resolve => {
    const req = request(`${app.url}/api/setup/ai/keys/google`, { method: 'PUT', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', () => resolve({}));
    req.write(body.slice(0, 1)); finish = () => req.end(body.slice(1));
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const closing = app.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  finish();
  const result = await completed; await closing;
  assert.notEqual(result.status, 200);
  assert.equal(durable, undefined); assert.equal(piEnv({}).GEMINI_API_KEY, undefined);
  assert.equal(JSON.parse(await readFile(join(data, 'settings.json'), 'utf8').catch(() => '{}')).apiKeys?.length ?? 0, 0);
});

test('a forced refresh after a key change never reuses a listing started with the old keys, nor caches one as current', async t => {
  const f = await fakePi(t, { keyRows: { google: GOOGLE_ROWS }, listDelay: 300 });
  useEnvironment(t, { MEETING_PI: f.command, FAKE_PI_STATE: f.state });
  useKeys(t, {});
  const reader = new PiModels({ cwd: f.cwd, env: f.env });
  t.after(() => reader.close());
  const old = reader.read(true);
  await until(async () => (await f.calls()).length === 1);
  setPiKeys({ google: GEMINI });
  const fresh = reader.read(true);
  assert.notEqual(fresh, old);
  assert.equal((await old).count, 2); assert.equal((await fresh).count, 4);
  assert.equal((await reader.read()).count, 4);
  // A listing that finishes after another key change is not current: the next ordinary read lists again.
  const late = reader.read(true); await until(async () => (await f.calls()).length === 3);
  setPiKeys({}); await late;
  assert.equal((await reader.read()).count, 2);
});
