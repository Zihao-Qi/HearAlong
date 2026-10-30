import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompleted, piTaskArgs, runPiTask } from '../src/pi-task.ts';

const provider = fileURLToPath(new URL('./fixtures/read-scope-provider.ts', import.meta.url));
const guard = fileURLToPath(new URL('./fixtures/search-network-guard.cjs', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url));

test('the network sentinel catches Pi’s original managed-tool download before any network I/O', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'search-network-sentinel-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const networkLog = join(folder, 'network.log');
  await writeFile(networkLog, '');
  const manager = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--require', guard, '--input-type=module', '-e', `const {ensureTool}=await import(${JSON.stringify(manager)}); await ensureTool('rg');`], {
    env: { PATH: folder, HOME: folder, PI_CODING_AGENT_DIR: join(folder, 'agent'), PI_OFFLINE: '0', SEARCH_NETWORK_LOG: networkLog, SEARCH_FIXTURE_ORIGIN: 'http://127.0.0.1:1' }, timeout: 10000,
  });
  assert.match(await readFile(networkLog, 'utf8'), /https:\/\/github\.com\/BurntSushi\/ripgrep\/releases\/latest/);
});

test('a failed extension factory aborts the real cloud task before tools or network calls', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'search-failed-extension-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cwd = join(folder, 'scratch'), home = join(folder, 'home'), bin = join(folder, 'bin');
  for (const path of [cwd, home, bin]) await mkdir(path);
  await symlink(process.execPath, join(bin, 'node'));
  const failed = join(folder, 'failed-extension.ts'), networkLog = join(folder, 'network.log');
  await writeFile(failed, 'export default async function () { throw new Error("Fictional bundled-extension init failure"); }');
  await writeFile(networkLog, '');
  const options = { model: 'scope-fixture/scripted', aiMode: 'cloud' as const, cwd, readRoots: [], tools: 'grep,find', extensions: [provider, failed], skills: false,
    env: { ...process.env, PATH: bin, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '0',
      SCOPE_FIXTURE_URL: 'http://127.0.0.1:1/v1', SEARCH_FIXTURE_ORIGIN: 'https://example.invalid', SEARCH_NETWORK_LOG: networkLog }, timeoutMs: 20000 };
  const events: any[] = [];
  await assert.rejects(runPiTask('Never execute a tool or contact a provider.', { ...options, command: process.execPath,
    args: ['--require', guard, cli, ...piTaskArgs('Never execute a tool or contact a provider.', options)], onEvent: event => events.push(event),
  }), /exit 1/);
  assert.ok(!events.some(event => event.type?.startsWith('tool_execution')));
  assert.equal(await readFile(networkLog, 'utf8'), '');
});

for (const mode of ['cloud', 'local'] as const) test(`real Pi ${mode}: grep/find with no rg/fd and no GitHub fetch`, async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'search-real-pi-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cwd = join(folder, 'scratch'), material = join(folder, 'material'), home = join(folder, 'home'), bin = join(folder, 'bin');
  for (const path of [cwd, material, home, bin]) await mkdir(path);
  await symlink(process.execPath, join(bin, 'node')); // Pi's shebang works; rg, fd and fdfind cannot be found.
  await writeFile(join(material, 'guide.txt'), 'First lantern.\nThe fictional lantern is blue.\nLast lantern.\n');
  const calls = [
    { name: 'grep', arguments: { pattern: 'FICTIONAL', ignoreCase: true, path: material, context: 1 } },
    { name: 'find', arguments: { pattern: '*.txt', path: material } },
  ];
  let turns = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"scripted"}]}');
    if (req.url === '/api/ps') return res.end('{"models":[{"name":"scripted","context_length":32768}]}');
    if (req.url === '/v1/models' || req.url === '/api/v1/models') return res.end('{"data":[]}');
    if (req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text);
    if (body.stream === false) return res.end('{}');
    const turn = turns++, call = calls[turn];
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: 'Finished the fictional search checks.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: `response-${turn}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: `response-${turn}`, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  assert.ok(![4318, 11434, 1234].includes(port));
  const origin = `http://127.0.0.1:${port}`, networkLog = join(folder, 'network.log');
  await writeFile(networkLog, '');
  const options = { model: mode === 'local' ? 'ollama/scripted' : 'scope-fixture/scripted', aiMode: mode, cwd, readRoots: [material], tools: 'grep,find', extensions: mode === 'cloud' ? [provider] : [], skills: false,
    env: { ...process.env, PATH: bin, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: mode === 'local' ? '1' : '0',
      MEETING_OLLAMA_BASE: `${origin}/v1`, MEETING_LMSTUDIO_BASE: `${origin}/v1`, SCOPE_FIXTURE_URL: `${origin}/v1`, SEARCH_FIXTURE_ORIGIN: origin, SEARCH_NETWORK_LOG: networkLog }, timeoutMs: 60_000 };
  const result = checkCompleted(await runPiTask('Run the scripted fictional search checks.', { ...options, command: process.execPath,
    args: ['--require', guard, cli, ...piTaskArgs('Run the scripted fictional search checks.', options)] }));
  const attempts = await readFile(networkLog, 'utf8');
  assert.doesNotMatch(attempts, /github\.com/, `managed-tool network attempt: ${attempts}`);
  assert.equal(result.toolResults.length, 2);
  assert.equal(result.toolResults[0].isError, false, result.toolResults[0].text);
  assert.equal(result.toolResults[0].text, 'guide.txt-1- First lantern.\nguide.txt:2: The fictional lantern is blue.\nguide.txt-3- Last lantern.');
  assert.equal(result.toolResults[1].isError, false, result.toolResults[1].text);
  assert.equal(result.toolResults[1].text, 'guide.txt');
  const agent = mode === 'local' ? join(cwd, '.pi-local') : join(home, 'agent');
  assert.deepEqual(await readdir(join(agent, 'bin')).catch(() => []), [], 'no managed binaries installed');
});
