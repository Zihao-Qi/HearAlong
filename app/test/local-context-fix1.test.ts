import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncServer } from './helpers/http.ts';
import { normalizeContext } from '@earendil-works/pi-ai';
import { localProvider } from '../pi-extensions/local-models.ts';
import { assertLocalContext } from '../src/local-ai.ts';
import { NOTES_PARTS, notesInstructions, partInstructions } from '../src/notes.ts';

async function fixture(t: any, kind: 'ollama' | 'lmstudio', initial: number | null, missing = false, legacy = false) {
  let loaded = initial;
  const requests: string[] = [], bodies: any[] = [];
  const server = createAsyncServer(t, async (req, res) => {
    requests.push(req.url!); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'fictional:8b' }] }));
    else if (req.url === '/api/show') res.end(JSON.stringify({ model_info: { 'qwen3.context_length': 131072 } }));
    else if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'fictional:8b', max_context_length: 131072 }] }));
    else if (req.url === '/api/ps') res.end(JSON.stringify({ models: loaded === null ? [] : [{ name: 'fictional:8b', context_length: missing ? undefined : loaded }] }));
    else if (req.url === '/api/v1/models' && !legacy) res.end(JSON.stringify({ models: [{ key: 'fictional:8b', loaded_instances: loaded === null ? [] : [{ id: 'instance', config: { context_length: missing ? undefined : loaded } }] }] }));
    else if (req.url === '/api/v0/models') res.end(JSON.stringify({ data: [{ id: 'fictional:8b', state: loaded === null ? 'not-loaded' : 'loaded', loaded_context_length: missing ? undefined : loaded }] }));
    else if (req.url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body); bodies.push(value);
      if (value.stream === false) { loaded = 4096; res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); }
      else { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"id":"fake","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"fake","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const provider = localProvider(kind, `http://127.0.0.1:${address.port}/v1`);
  const refresh = () => provider.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(3000), publish: async p => { p.update?.(); return true; } });
  await refresh();
  const ask = (text: string) => provider.streamSimple(provider.getModels()[0], normalizeContext({ messages: [{ role: 'user', content: text, timestamp: 1 }] }), { apiKey: 'local', maxRetries: 0, signal: AbortSignal.timeout(4000) }).result();
  return { provider, requests, bodies, ask, refresh, setContext: (n: number) => { loaded = n; } };
}

for (const kind of ['ollama', 'lmstudio'] as const) test(`FIX1 ${kind}: not loaded → one fixed-word load → measured context, short notes accepted`, async t => {
  const f = await fixture(t, kind, null);
  const instructions = partInstructions(notesInstructions(), NOTES_PARTS.project);
  const result = await f.ask(instructions + '\nS1 [00:00] A fictional short meeting.');
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[0].max_tokens, 1); assert.equal(f.bodies[0].stream, false);
  assert.deepEqual(f.bodies[0].messages, [{ role: 'user', content: 'Hi' }]);
  assert.ok(JSON.stringify(f.bodies[1]).includes('A fictional short meeting.'));
  const load = f.requests.indexOf('/v1/chat/completions');
  assert.equal(f.requests[load + 1], kind === 'ollama' ? '/api/ps' : '/api/v1/models');
});

for (const kind of ['ollama', 'lmstudio'] as const) test(`FIX1 ${kind}: use loaded context, never trained maximum; re-measure changes before sending text`, async t => {
  const f = await fixture(t, kind, 32768);
  assert.equal(f.provider.getModels()[0].contextWindow, 32768);
  for (const keys of Object.values(NOTES_PARTS)) assert.doesNotThrow(() => assertLocalContext(`${kind}/fictional:8b`, 4096, 1024, partInstructions(notesInstructions(), keys) + '\nS1 [00:00] A short meeting.'));
  assert.equal((await f.ask('A short fictional meeting.')).stopReason, 'stop');
  assert.equal(f.bodies.length, 1, 'An already-loaded model must not be warmed again.');
  f.setContext(4096);
  const result = await f.ask('Fictional transcript text. '.repeat(3000));
  assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage ?? '', /context|how much text/i);
  assert.equal(f.bodies.length, 1, 'No overlong prompt is sent for the server to truncate.');
});

for (const kind of ['ollama', 'lmstudio'] as const) test(`FIX1 ${kind}: missing effective context refuses with actionable guidance`, async t => {
  const f = await fixture(t, kind, 8192, true);
  const result = await f.ask('A short fictional meeting.');
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /Couldn’t learn how much text.*fictional:8b.*can read/);
  assert.match(result.errorMessage ?? '', kind === 'ollama' ? /OLLAMA_CONTEXT_LENGTH.*restart Ollama/ : /context length when loading the model/);
  assert.equal(f.bodies.some(body => JSON.stringify(body).includes('fictional meeting.')), false);
});

test('FIX1 LM Studio legacy REST metadata uses loaded_context_length, not max_context_length', async t => {
  const f = await fixture(t, 'lmstudio', 8192, false, true);
  assert.equal(f.provider.getModels()[0].contextWindow, 8192);
});
