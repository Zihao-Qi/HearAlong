import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { piLaunch } from '../src/pi-command.ts';
import { MeetingStore } from '../src/store.ts';
import { ActionJobs } from '../src/actions.ts';
import { NotesJobs } from '../src/notes.ts';
import { Explorations } from '../src/explorations.ts';
import { Boards } from '../src/board.ts';
import { MemoryFiles } from '../src/memory-files.ts';
import { Proposals } from '../src/proposals.ts';
import { PdfText } from '../src/pdf-text.ts';
import { ModelRpc } from '../src/pi-rpc.ts';
import { AiSetup } from '../src/setup/ai.ts';
import { ApiKeys } from '../src/setup/api-keys.ts';
import { SpeechSetup } from '../src/setup/service.ts';
import { JobManager } from '../src/jobs.ts';
import { LiveCapture } from '../src/live.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

test('late startup failure leaves no lock, recognizer, Pi admission or repeating worker after restarting the same directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'late-startup-cleanup-'));
  const interval = globalThis.setInterval, clear = globalThis.clearInterval;
  const live = new Map<NodeJS.Timeout, number>();
  const created: number[] = [], events: string[] = [], loopsAtStoreClose: number[][] = [];
  t.mock.method(globalThis, 'setInterval', (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    const timer = interval(callback, ms, ...args);
    live.set(timer, ms); created.push(ms); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: NodeJS.Timeout | undefined) => {
    if (timer) live.delete(timer);
    clear(timer);
  });
  // Run the real asynchronous teardown. Logging after await detects forgotten awaits as well as omitted closes.
  type Closable = { close(): void | Promise<void> };
  function watchClose(name: string, prototype: Closable) {
    const close = prototype.close;
    t.mock.method(prototype, 'close', async function (this: Closable) {
      await close.call(this);
      events.push(name);
    });
  }
  watchClose('actions', ActionJobs.prototype);
  watchClose('notes', NotesJobs.prototype);
  watchClose('explorations', Explorations.prototype);
  watchClose('boards', Boards.prototype);
  watchClose('files', MemoryFiles.prototype);
  watchClose('proposals', Proposals.prototype);
  watchClose('pdf', PdfText.prototype);
  watchClose('gate', ModelRpc.prototype);
  watchClose('ai', AiSetup.prototype);
  watchClose('keys', ApiKeys.prototype);
  watchClose('speech', SpeechSetup.prototype);
  watchClose('jobs', JobManager.prototype);
  watchClose('capture', LiveCapture.prototype);
  const closeStore = MeetingStore.prototype.close;
  t.mock.method(MeetingStore.prototype, 'close', function (this: MeetingStore) {
    loopsAtStoreClose.push([...live.values()]); events.push('store'); closeStore.call(this);
  });
  const expected = ['actions', 'notes', 'explorations', 'boards', 'files', 'proposals', 'pdf', 'gate', 'ai', 'keys', 'speech', 'jobs', 'capture', 'quick', 'recognizer'];
  const options = { directory, port: 0, idleMs: 60000, setup: await dashboardSetup(directory),
    quick: { async ask() { throw new Error('unexpected fictional correction request'); }, async close() { events.push('quick'); } },
    heavy: async () => { throw new Error('unexpected fictional glossary request'); },
    notes: null, actions: null, plans: null, drafts: null,
    // Board's default ModelRpc is lazy: construct/close it, but never run a model.
    recognizer: { available: () => true, async transcribe() { throw new Error('unexpected fictional recognition'); }, close() { events.push('recognizer'); } } };
  const failure = new Error('fictional late listener failure');
  const listening = t.mock.method(Server.prototype, 'listen', function (this: Server) { this.emit('error', failure); return this; });
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await assert.rejects(startServer(options), error => error === failure);
    await assert.rejects(stat(join(directory, 'server.lock')), { code: 'ENOENT' });
    assert.doesNotThrow(() => piLaunch([], { model: 'fictional/model', env: {} }), 'failed startup released process-global Pi admission');
    const failureEvents = [...events], survivingFailureLoops = [...live.values()];
    assert.deepEqual(created.sort((a, b) => a - b), [1000, 1000, 2000, 5000, 5000, 3600000], 'exercise all six repeating handles, including correction');
    listening.mock.restore();
    app = await startServer(options);
    const response = await fetch(app.url);
    assert.equal(response.status, 200); await response.text();
    await app.close(); await app.close(); // Normal close is still idempotent.
    await assert.rejects(stat(join(directory, 'server.lock')), { code: 'ENOENT' });
    assert.doesNotThrow(() => piLaunch([], { model: 'fictional/model', env: {} }));
    assert.deepEqual(survivingFailureLoops, [], 'failed startup must clear every repeating handle');
    assert.deepEqual([...live.values()], [], 'no failed-start worker may survive restart and normal close');
    assert.deepEqual(loopsAtStoreClose, [[], []], 'loops stop before either store closes');
    for (const closed of [failureEvents, events.slice(failureEvents.length)]) {
      assert.equal(closed.at(-1), 'store');
      assert.deepEqual(closed.slice(0, -1).sort(), [...expected].sort(), 'each owned runtime must finish cleanup before its store closes');
    }
  } finally {
    listening.mock.restore(); await app?.close();
    for (const timer of live.keys()) clear(timer);
    live.clear();
    await rm(directory, { recursive: true, force: true });
  }
});
