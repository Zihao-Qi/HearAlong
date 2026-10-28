import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import registerLocal, { localProvider } from '../pi-extensions/local-models.ts';

async function server(t: any) {
  const requests: string[] = [];
  const http = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'example:8b' }] } : req.url === '/api/ps' ? { models: [{ name: 'example:8b', context_length: 8192 }] } : req.url === '/api/v1/models' ? { models: [{ key: 'example-local', loaded_instances: [{ config: { context_length: 8192 } }] }] } : { data: [{ id: 'example-local', max_context_length: 8192 }] }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  return { http, requests, base: `http://127.0.0.1:${address.port}/v1` };
}

for (const kind of ['ollama', 'lmstudio'] as const) test(`${kind} discovers loopback models during offline refresh, and a down server lists none`, async t => {
  const f = await server(t);
  const provider = localProvider(kind, f.base);
  const refresh = () => provider.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(3000), publish: async publication => { publication.update?.(); return true; } });
  await refresh();
  assert.equal(provider.getModels()[0].id, kind === 'ollama' ? 'example:8b' : 'example-local');
  assert.deepEqual(f.requests, kind === 'ollama' ? ['/api/tags', '/api/ps'] : ['/v1/models', '/api/v1/models']);
  await new Promise<void>(resolve => f.http.close(() => resolve()));
  await refresh();
  assert.deepEqual(provider.getModels(), []);
});

test('the bundled extension refuses automatic compaction rather than summarize a transcript silently', async t => {
  const f = await server(t);
  const old = [process.env.MEETING_OLLAMA_BASE, process.env.MEETING_LMSTUDIO_BASE];
  process.env.MEETING_OLLAMA_BASE = f.base; process.env.MEETING_LMSTUDIO_BASE = f.base;
  t.after(() => { for (const [index, name] of ['MEETING_OLLAMA_BASE', 'MEETING_LMSTUDIO_BASE'].entries()) { if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index]; } });
  const handlers = new Map<string, () => Promise<unknown>>();
  await registerLocal({ on: (event: string, handler: () => Promise<unknown>) => handlers.set(event, handler), registerProvider() {} } as any);
  assert.deepEqual(await handlers.get('session_before_compact')!(), { cancel: true });
});

test('local provider refuses non-loopback endpoints before discovery', () => {
  for (const base of ['https://example.invalid/v1', 'http://192.0.2.1/v1', 'http://127.0.0.1.example.invalid/v1']) {
    assert.throws(() => localProvider('ollama', base), /loopback/i);
  }
});

test('pinned Pi lists explicit local providers offline without loading a discovered user extension', async t => {
  const f = await server(t);
  const directory = await mkdtemp(join(tmpdir(), 'local-pi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agent = join(directory, 'agent');
  await mkdir(join(agent, 'extensions'), { recursive: true });
  await writeFile(join(agent, 'extensions', 'unwanted.ts'), "throw new Error('USER_EXTENSION_LOADED');\n");
  const guard = join(directory, 'network-guard.mjs');
  await writeFile(guard, "const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.hostname !== '127.0.0.1') throw new Error('Non-loopback request refused'); return original(input, options); };\n");
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)),
    '--no-extensions', '-e', fileURLToPath(new URL('../pi-extensions/local-models.ts', import.meta.url)), '--no-skills', '--no-context-files', '--list-models',
  ], { cwd: directory, timeout: 20_000, env: {
    PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1',
    NODE_OPTIONS: `--import=${guard}`, MEETING_OLLAMA_BASE: f.base, MEETING_LMSTUDIO_BASE: f.base,
  } });
  assert.ok(f.requests.length > 0, `The extension made no discovery requests. Pi stderr: ${stderr}`);
  assert.match(stdout, /ollama\s+example:8b/, stderr);
  assert.match(stdout, /lmstudio\s+example-local/);
  assert.doesNotMatch(stderr, /USER_EXTENSION_LOADED/);
});
