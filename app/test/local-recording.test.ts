import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import { Corrector } from '../src/correction.ts';
import { Boards } from '../src/board.ts';
import { ModelRpc } from '../src/pi-rpc.ts';
import { fakePi, table, until } from './helpers/setup-pi.ts';

test('local board and correction schedulers wait through recording and resume after Stop', async t => {
  let remove!: () => unknown;
  const f = await fakePi({ after: fn => { remove = fn; } }, { table: table(['ollama example 32K 4K no no']) });
  const directory = join(f.directory, 'data'); await mkdir(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ aiMode: 'local', setupSeen: true, localMainModel: 'ollama/example', localQuickModel: 'ollama/example' }));
  let corrections = 0, boards = 0, interrupts = 0;
  const interrupt = ModelRpc.prototype.interrupt;
  t.mock.method(ModelRpc.prototype, 'interrupt', function (this: ModelRpc) { interrupts++; interrupt.call(this); });
  t.mock.method(Corrector.prototype, 'tick', async () => { corrections++; return 'done'; });
  t.mock.method(Boards.prototype, 'tick', async () => { boards++; });
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn: (...args: any[]) => void, ms: number, ...args: any[]) => interval(fn, ms === 5000 ? 20 : ms, ...args));
  const app = await startServer({ directory, port: 0, recognizer: { available: () => true, transcribe: async () => ({ text: 'Example fictional transcript.', words: [], backend: 'fake', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }), close() {} }, drafts: null, correctionTickMs: 20,
    ai: { env: f.env }, setup: { scan: { home: f.directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(async () => { await app.close(); await remove(); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, init: RequestInit = {}) => fetch(app.url + path, { ...init, headers: { Cookie: cookie, Origin: app.url, ...init.headers } });
  await request('/api/setup/ai/models');
  const meeting = app.store.createMeeting('Example deferred board'), source = `mic:${randomUUID()}`;
  const path = `/api/meetings/${meeting.id}`;
  for (let i = 0; i < 25; i++) {
    const response = await request(path + '/pcm', { method: 'POST', body: Buffer.alloc(64000), headers: { 'X-Audio-Source': source, 'X-Sequence': String(i), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(i * 1000) } });
    assert.equal(response.status, 201);
    if (i === 0) { corrections = 0; boards = 0; }
  }
  await delay(100);
  assert.equal(corrections, 0); assert.equal(boards, 0);
  assert.ok(interrupts >= 2, 'recording interrupts both real RPC lanes, including already-running work');
  assert.equal((await f.calls()).some(call => call.args.includes('json') || call.args.includes('rpc')), false);
  assert.equal((await request(path + '/board/scan', { method: 'POST', body: '{}' })).status, 409);
  const stopped = await request(path + '/pcm/end', { method: 'POST', body: JSON.stringify({ source, lastSequence: 24, stopping: true }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(stopped.status, 200);
  await until(() => corrections > 0 && boards > 0);
});
