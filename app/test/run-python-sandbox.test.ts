// run_python runs model-written code: it must not see provider credentials, and its sandbox keeps it away from the Keychain,
// Pi's sign-ins, HearAlong's data folder (except its own scratch folder) and the network. A fake `uv` stands in for Python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

async function fixture(t: any, uvBody: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'run-python-sandbox-')));
  const bin = join(root, 'bin'), home = join(root, 'home'), data = join(root, 'data'), cwd = join(data, 'scratch', 'actions', 'job-1');
  for (const dir of [bin, join(home, '.pi', 'agent'), join(home, 'Library', 'Keychains'), cwd]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'auth.json'), '{"google":{"type":"api_key","key":"fictional-stored-key"}}');
  await writeFile(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'fictional keychain');
  await writeFile(join(data, 'settings.json'), '{"fictional":true}');
  // The fake uv skips uv's own options (as uv would) and runs as the "script" itself.
  await writeFile(join(bin, 'uv'), `#!${process.execPath}\n${uvBody}\n`); await chmod(join(bin, 'uv'), 0o755);
  const saved = { ...process.env }, start = process.cwd();
  Object.assign(process.env, {
    PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, RUN_PYTHON_MS: '20000',
    GEMINI_API_KEY: 'fictional-gemini-key', OPENAI_API_KEY: 'fictional-openai-key', ANTHROPIC_OAUTH_TOKEN: 'fictional-token',
    AWS_SECRET_ACCESS_KEY: 'fictional-aws', HF_TOKEN: 'fictional-hf', COPILOT_GITHUB_TOKEN: 'fictional-gh', PROBE_KEEP: 'kept',
  });
  delete process.env.MEETING_PROCESS_DIR; delete process.env.RUN_PYTHON_USED; delete process.env.RUN_PYTHON_MAX_RUNS;
  process.chdir(cwd);
  t.after(async () => {
    process.chdir(start);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  });
  const { default: register } = await import('../pi-extensions/run-python.ts');
  let tool: any; register({ registerTool: (value: any) => { tool = value; } } as any);
  return { root, home, data, cwd, run: async () => (await tool.execute('probe', { code: 'print(1)' })) };
}

test('model-written code never sees a provider credential; other variables pass', async t => {
  const f = await fixture(t, `console.log(JSON.stringify(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'HF_TOKEN', 'COPILOT_GITHUB_TOKEN', 'PROBE_KEEP'].filter(k => k in process.env)))`);
  const result = await f.run();
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), ['PROBE_KEEP']);
});

test('the sandbox: no Keychain tool, no Pi sign-ins, no data folder but its own scratch, no network; Python runs offline', async t => {
  const listener = createServer(socket => socket.end()); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = (listener.address() as { port: number }).port;
  const f = await fixture(t, `
const fs = require('node:fs'), net = require('node:net'), { spawnSync } = require('node:child_process'), home = process.env.HOME;
const result = { args: process.argv.slice(2) };
const attempt = (name, fn) => { try { fn(); result[name] = 'allowed'; } catch (error) { result[name] = 'denied'; } };
attempt('auth.json', () => fs.readFileSync(home + '/.pi/agent/auth.json'));
attempt('keychains', () => fs.readFileSync(home + '/Library/Keychains/login.keychain-db'));
attempt('data folder', () => fs.readFileSync(${JSON.stringify(join('DATA', 'settings.json'))}.replace('DATA', process.cwd().replace(/\\/scratch\\/.*$/, ''))));
attempt('own scratch', () => { fs.writeFileSync('out.txt', 'x'); fs.readFileSync('out.txt'); });
attempt('security', () => { const run = spawnSync('/usr/bin/security', ['-h']); if (run.error) throw run.error; });
attempt('copy security', () => fs.copyFileSync('/usr/bin/security', 'security-copy'));
const socket = net.connect(${port}, '127.0.0.1');
socket.on('connect', () => { result.network = 'allowed'; socket.destroy(); done(); });
socket.on('error', () => { result.network = 'denied'; done(); });
function done() { console.log(JSON.stringify(result)); }`);
  const result = await f.run();
  assert.equal(result.isError, undefined, result.content[0].text);
  const seen = JSON.parse(result.content[0].text);
  assert.deepEqual({ ...seen, args: undefined }, { args: undefined, 'auth.json': 'denied', keychains: 'denied', 'data folder': 'denied', 'own scratch': 'allowed',
    security: 'denied', 'copy security': 'denied', network: 'denied' });
  assert.ok(seen.args.includes('--offline'), 'uv runs offline: the sandbox has no network');
  assert.equal(await readFile(join(f.cwd, 'out.txt'), 'utf8'), 'x');
});
