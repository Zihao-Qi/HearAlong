import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncServer, type AsyncRequestListener } from './helpers/http.ts';
import { normalizeContext } from '@earendil-works/pi-ai';
import { localProvider } from '../pi-extensions/local-models.ts';
import { loadedContexts } from '../pi-extensions/local-context.ts';
import * as transport from '../pi-extensions/local-transport.ts';
import { checkNotesRun } from '../src/notes.ts';
import type { PiTaskResult } from '../src/pi-task.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function serve(t: any, handler: AsyncRequestListener) {
  const server = createAsyncServer(t, handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  assert.notEqual(address.port, 11434); assert.notEqual(address.port, 1234);
  return new URL(`http://127.0.0.1:${address.port}/v1`);
}
const sse = (res: import('node:http').ServerResponse, finish = 'stop') => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(`data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"${finish}"}]}\n\ndata: [DONE]\n\n`);
};
async function provider(base: URL) {
  const p = localProvider('ollama', base.href);
  await p.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(5000), publish: async p => { p.update?.(); return true; } });
  return p;
}
const context = normalizeContext({ messages: [{ role: 'user', content: 'Fictional lantern workshop meeting.', timestamp: 1 }] });
const ask = (p: ReturnType<typeof localProvider>, signal = AbortSignal.timeout(10_000)) => p.streamSimple(p.getModels()[0], context, { apiKey: 'local', maxRetries: 0, signal }).result();

// Reproduce the notes sibling-abort chain with separate provider processes represented by separate provider instances.
test('real local: slow cold load survives a sibling observing context_length zero', async t => {
  let loading = false, size = 0, posts = 0, cancelled = 0;
  const bodies: any[] = [];
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const base = await serve(t, async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fictional:4b' }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loading ? [{ name: 'fictional:4b', context_length: size }] : [] }));
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); bodies.push(value); posts++;
    if (value.stream === false) {
      loading = true; began(); res.on('close', () => { if (!res.writableEnded) cancelled++; });
      await pause(3500); size = 32768;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi' } }] }));
    } else sse(res);
  });
  const first = await provider(base), second = await provider(base), controller = new AbortController();
  const run = (p: typeof first) => ask(p, controller.signal).then(result => { if (result.stopReason === 'error') controller.abort(); return result; });
  const a = run(first); await started;
  const b = run(second);
  const results = await Promise.all([a, b]);
  console.log('slow load evidence', { stops: results.map(r => r.stopReason), cancelled, posts });
  assert.ok(results.every(r => r.stopReason === 'stop'), results.map(r => r.errorMessage).join('\n'));
  assert.equal(cancelled, 0); assert.equal(posts, 3);
  assert.ok(bodies.every(body => body.reasoning_effort === 'none'));
});

test('real local: metadata timing out during loading cannot impose its 1.5 s limit on warm-up', async t => {
  let reads = 0, warms = 0, loaded = false;
  const base = await serve(t, async (req, res) => {
    if (req.url === '/api/ps') {
      reads++;
      if (reads === 1) await pause(1800);
      return res.end(JSON.stringify({ models: loaded ? [{ name: 'fictional:4b', context_length: 32768 }] : [] }));
    }
    warms++; await pause(2500); loaded = true; res.end('{}');
  });
  assert.equal(await loadedContexts('ollama', base).require('fictional:4b', AbortSignal.timeout(8000)), 32768);
  assert.equal(warms, 1);
});

test('real local: warm-up callers do not inherit another caller’s cancellation', async t => {
  let loaded = false, warms = 0;
  const base = await serve(t, async (req, res) => {
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loaded ? [{ name: 'fictional:4b', context_length: 32768 }] : [] }));
    warms++; await pause(500); loaded = true; res.end('{}');
  });
  const contexts = loadedContexts('ollama', base);
  const controller = new AbortController();
  const first = contexts.require('fictional:4b', controller.signal).then(() => 'ok', () => 'cancelled');
  await pause(50);
  const second = contexts.require('fictional:4b', AbortSignal.timeout(3000));
  controller.abort();
  assert.equal(await first, 'cancelled');
  assert.equal(await second, 32768); assert.equal(warms, 1);
});

test('real local: failed load is distinguished from a loaded model with unknown context', async t => {
  let loaded = false;
  const base = await serve(t, (req, res) => {
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: loaded ? [{ name: 'fictional:4b' }] : [] }));
    res.statusCode = 500; res.end('{"error":"failed to load"}');
  });
  const contexts = loadedContexts('ollama', base);
  await assert.rejects(contexts.require('fictional:4b', AbortSignal.timeout(3000)), /fictional:4b.*failed to load.*Ollama/i);
  loaded = true;
  await assert.rejects(contexts.require('fictional:4b', AbortSignal.timeout(3000)), /Couldn’t learn how much text.*set the context length/);
});

test('real local: a model still loading at the bound names the model and Ollama, not context settings', async t => {
  const base = await serve(t, (_req, res) => res.end('{"models":[{"name":"fictional:4b","context_length":0}]}'));
  const contexts = loadedContexts('ollama', base, { loadMs: 180, pollMs: 40 });
  await assert.rejects(contexts.require('fictional:4b', AbortSignal.timeout(3000)), /fictional:4b.*did not finish loading.*Ollama/i);
});

test('real local: queued inference waits beyond the old scaled header limit, but hung streams fail', async t => {
  assert.deepEqual(transport.LOCAL_TRANSPORT_LIMITS, { headersMs: 600_000, idleMs: 300_000 });
  const fetch = transport.createLocalFetch({ headersMs: 2000, idleMs: 1000 });
  let queue = Promise.resolve();
  const bodies: any[] = [];
  const base = await serve(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    if (bodies.at(-1).hang) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: partial\n\n'); return; }
    queue = queue.then(async () => { await pause(650); sse(res); });
    await queue;
  });
  const replies = await Promise.all([1, 2].map(n => fetch(base, { method: 'POST', body: JSON.stringify({ n }) }).then(r => r.text())));
  assert.ok(replies.every(text => text.includes('[DONE]'))); assert.equal(bodies.length, 2);
  const hung = await fetch(base, { method: 'POST', body: '{"hang":true}' });
  await assert.rejects(hung.text(), /terminated|timeout/i);
  const stopped = await serve(t, (_req, res) => res.destroy());
  await assert.rejects(fetch(stopped), /fetch failed|socket|closed/i);
});

test('real local: Ollama reasoning is disabled and length exhaustion names the model plainly', async t => {
  const bodies: any[] = [];
  const base = await serve(t, async (req, res) => {
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"fictional:4b"}]}');
    if (req.url === '/api/ps') return res.end('{"models":[{"name":"fictional:4b","context_length":32768}]}');
    let body = ''; for await (const chunk of req) body += chunk; bodies.push(JSON.parse(body)); sse(res, 'length');
  });
  const reply = await ask(await provider(base));
  assert.equal(reply.stopReason, 'length'); assert.equal(bodies[0].reasoning_effort, 'none');
  const result = { ...reply, provider: 'ollama', model: 'fictional:4b', text: 'partial', exitCode: 0, exitSignal: null, settled: true, aborted: false, tools: [], toolEvents: 0 } as unknown as PiTaskResult;
  assert.throws(() => checkNotesRun(result), /ollama\/fictional:4b.*ran out of room to write its answer/);
});
