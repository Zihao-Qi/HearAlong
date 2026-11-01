import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, get, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

type Reply = { status: number | undefined; headers: IncomingHttpHeaders; socket: Socket; reused: boolean; freedAt: number };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'server-keepalive-'));
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { agent.destroy(); await app?.close(); await rm(directory, { recursive: true, force: true }); });
  app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true),
    quick: null, heavy: null, recognizer: null, drafts: null, board: null });
  const url = app.url;
  const request = (path: string, cookie?: string) => new Promise<Reply>((resolve, reject) => {
    let status: number | undefined, headers: IncomingHttpHeaders;
    // Wait for the actual agent free event, not merely response headers: the next delay is socket idle time.
    const free = (socket: Socket) => resolve({ status, headers, socket, reused: req.reusedSocket, freedAt: performance.now() });
    agent.once('free', free);
    const req = get(url + path, { agent, headers: cookie ? { Cookie: cookie } : {} }, res => {
      status = res.statusCode; headers = res.headers;
      res.once('error', error => { agent.off('free', free); reject(error); });
      res.resume();
    });
    req.once('error', error => { agent.off('free', free); reject(error); });
  });
  const first = await request('/mini.html');
  assert.equal(first.status, 200);
  const cookie = first.headers['set-cookie']![0].split(';')[0];
  const meeting = app.store.createMeeting('Fictional seed library');
  return { app, agent, request: () => request(`/api/meetings/${meeting.id}/board`, cookie) };
}

test('loopback keep-alive survives three old six-second expiry windows on the same connection', async t => {
  const { request } = await fixture(t);
  let previous = await request();
  const socket = previous.socket, idle: number[] = [];
  assert.equal(previous.status, 200);
  for (let i = 0; i < 3; i++) {
    // The old 5000 ms timeout plus Node 22's 1000 ms buffer races a client just under six seconds idle.
    await sleep(5990);
    idle.push(performance.now() - previous.freedAt);
    const reply = await request();
    assert.equal(reply.status, 200);
    assert.equal(reply.reused, true, 'no reconnect may hide an idle-connection reset');
    assert.equal(reply.socket, socket, 'every refresh must use the original socket');
    previous = reply;
  }
  // A timing-only test might get lucky on old code: assert the actual advertised policy as well.
  assert.match(String(previous.headers['keep-alive']), /\btimeout=65\b/);
  t.diagnostic(`three socket idle windows (ms): ${idle.map(ms => ms.toFixed(2)).join(', ')}`);
});

for (const method of ['close', 'shutdown'] as const) {
  test(`loopback ${method} promptly closes an idle keep-alive connection`, async t => {
    const { app, agent, request } = await fixture(t);
    const reply = await request();
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers['keep-alive']), /\btimeout=65\b/);
    assert.ok(Object.values(agent.freeSockets).flat().includes(reply.socket), 'the connection is idle in the agent');
    assert.equal(reply.socket.destroyed, false);
    const closed = once(reply.socket, 'close');
    const started = performance.now();
    await app[method]();
    await closed;
    const ms = performance.now() - started;
    // Shutdown deliberately gives pages 2500 ms; neither path may wait for the 65 s idle expiry or 5 s force-close.
    assert.ok(ms < (method === 'close' ? 2000 : 4500), `${method} with idle connection took ${ms.toFixed(2)} ms`);
    t.diagnostic(`${method} with idle connection: ${ms.toFixed(2)} ms`);
  });
}
