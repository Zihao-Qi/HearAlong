import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncServer } from './helpers/http.ts';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompleted, runPiTask } from '../src/pi-task.ts';

const provider = fileURLToPath(new URL('./fixtures/read-scope-provider.ts', import.meta.url));

test('real Pi blocks an outside read and symlink escapes before content reaches its model, output or session', async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'scope-real-pi-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cwd = join(folder, 'scratch'), materials = join(folder, 'materials'), home = join(folder, 'home'), sessions = join(folder, 'sessions');
  for (const path of [cwd, materials, home]) await mkdir(path);
  const inside = join(materials, 'guide.txt'), outside = join(folder, 'outside.txt');
  const secret = 'FICTIONAL_OUTSIDE_CANARY_73501', permitted = 'The fictional lanterns belong on shelf seven.';
  await writeFile(inside, permitted); await writeFile(outside, secret);
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, join(materials, 'escape.txt'));
  const requests: any[] = [];
  const calls = [
    { name: 'read', arguments: { path: outside } },
    { name: 'read', arguments: { path: inside } },
    { name: 'read', arguments: { path: join(materials, 'escape.txt') } },
    { name: 'ls', arguments: {} },
    { name: 'fetch_content', arguments: { url: outside } },
    { name: 'fetch_content', arguments: { url: 'https://example.invalid/fictional' } },
  ];
  const server = createAsyncServer(t, async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); requests.push(body);
    const turn = requests.length - 1;
    const call = calls[turn];
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: 'assistant', content: 'Finished the fictional scope checks.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of [
      { id: `response-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `response-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const safePath = (process.env.PATH ?? '').split(':').filter(path => !path.includes('/.pi/')).join(':');
  const options = { model: 'scope-fixture/scripted', cwd, sessionDir: sessions, readRoots: [materials], tools: 'read,grep,find,ls,fetch_content', extensions: [provider], skills: false,
    env: { ...process.env, PATH: safePath, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', MEETING_PI: '/usr/bin/false', SCOPE_FIXTURE_URL: `http://127.0.0.1:${port}/v1` }, timeoutMs: 60_000 };
  const events: unknown[] = [];
  const result = checkCompleted(await runPiTask('Run the scripted fictional file checks.', { ...options, onEvent: event => events.push(event) }));
  assert.equal(result.toolResults.length, calls.length);
  assert.equal(result.toolResults[0].isError, true);
  assert.match(result.toolResults[0].text, /outside this task's materials\./);
  assert.equal(result.toolResults[1].isError, false);
  assert.ok(result.toolResults[1].text.includes(permitted));
  assert.equal(result.toolResults[2].isError, true);
  assert.equal(result.toolResults[3].isError, false, result.toolResults[3].text);
  assert.equal(result.toolResults[4].isError, true, 'fictional local-file URL is blocked before the unsafe adapter executes');
  assert.equal(result.toolResults[5].isError, false, result.toolResults[5].text);
  assert.match(result.toolResults[5].text, /Fictional HTTP page result/);
  assert.ok(JSON.stringify(requests).includes(permitted), 'the next scripted-model request contains the permitted read');
  const { readdir } = await import('node:fs/promises');
  const transcript = (await Promise.all((await readdir(sessions)).filter(name => name.endsWith('.jsonl')).map(name => readFile(join(sessions, name), 'utf8')))).join('\n');
  for (const surface of [JSON.stringify(events), JSON.stringify(result), JSON.stringify(requests), transcript]) assert.ok(!surface.includes(secret), 'outside content never enters any task surface');
});
