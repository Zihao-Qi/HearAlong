import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncServer, type AsyncRequestListener } from './helpers/http.ts';
import { connect } from 'node:net';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { normalizeContext } from '@earendil-works/pi-ai';
import { piLaunch } from '../src/pi-command.ts';
import { localProvider } from '../pi-extensions/local-models.ts';

async function serve(t: any, handler: AsyncRequestListener) {
  const server = createAsyncServer(t, handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
const sse = (res: import('node:http').ServerResponse) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"id":"fake","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"fake","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
const context = normalizeContext({ messages: [{ role: 'user', content: 'FICTIONAL_MEETING_CANARY', timestamp: 1 }] });
async function catalog(t: any, chat: AsyncRequestListener) {
  return serve(t, (req, res) => {
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'fictional:8b' }] }));
    else if (req.url === '/api/ps') res.end(JSON.stringify({ models: [{ name: 'fictional:8b', context_length: 8192 }] }));
    else if (req.url === '/v1/chat/completions') return chat(req, res);
    else { res.statusCode = 404; res.end('{}'); }
  });
}
async function model(provider: ReturnType<typeof localProvider>) {
  await provider.refreshModels!({ allowNetwork: false, signal: AbortSignal.timeout(3000), publish: async p => { p.update?.(); return true; } });
  return provider.getModels()[0];
}

test('FIX1 local child environment removes every case of proxy configuration', () => {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const launch = piLaunch([], { mode: 'local', env: Object.fromEntries(names.map(name => [name, 'fictional-proxy'])) });
  for (const name of names) assert.equal(launch.env[name], undefined, name);
});

test('FIX1 discovery and both inference methods bypass an environment CONNECT proxy', async t => {
  let tunnels = 0, direct = 0;
  const endpoint = await catalog(t, (_req, res) => { direct++; sse(res); });
  const proxy = await serve(t, (_req, res) => { res.statusCode = 502; res.end(); });
  const sockets = new Set<import('node:stream').Duplex>();
  proxy.server.on('connect', (req, client, head) => {
    tunnels++;
    const target = new URL(`http://${req.url}`);
    assert.equal(target.hostname, '127.0.0.1');
    const upstream = connect(Number(target.port), '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(upstream); sockets.add(client);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  const provider = localProvider('ollama', endpoint.base + '/v1');
  const m = await model(provider);
  const original = getGlobalDispatcher();
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: proxy.base, httpsProxy: proxy.base, noProxy: '' });
  setGlobalDispatcher(dispatcher);
  t.after(async () => { setGlobalDispatcher(original); for (const socket of sockets) socket.destroy(); await dispatcher.destroy(); });
  await model(provider);
  for (const method of ['stream', 'streamSimple'] as const) {
    const result = await provider[method](m, context, { apiKey: 'local', maxRetries: 0, signal: AbortSignal.timeout(3000) }).result();
    assert.equal(result.stopReason, 'stop');
  }
  assert.equal(tunnels, 0, 'Neither discovery nor inference may use a global proxy dispatcher.');
  assert.equal(direct, 2);
});

for (const method of ['stream', 'streamSimple'] as const) test(`FIX1 ${method} refuses 307 before forwarding any meeting text`, async t => {
  let received = 0;
  const sink = await serve(t, async (req, res) => { for await (const _ of req) {} received++; sse(res); });
  const endpoint = await catalog(t, (_req, res) => { res.writeHead(307, { Location: sink.base + '/v1/chat/completions' }); res.end(); });
  const provider = localProvider('ollama', endpoint.base + '/v1');
  const m = await model(provider);
  const result = await provider[method](m, context, { apiKey: 'local', maxRetries: 0, signal: AbortSignal.timeout(3000) }).result();
  assert.equal(received, 0);
  assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage ?? '', /redirect/i);
});

test('FIX1 discovery refuses redirects without contacting a second origin', async t => {
  let received = 0;
  const sink = await serve(t, (_req, res) => { received++; res.end('{}'); });
  const origin = await serve(t, (_req, res) => { res.writeHead(307, { Location: sink.base }); res.end(); });
  const provider = localProvider('ollama', origin.base + '/v1');
  await model(provider); assert.equal(received, 0); assert.equal(provider.getModels().length, 0);
});
