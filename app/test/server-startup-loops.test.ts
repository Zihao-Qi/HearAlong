import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

// A loop tick can land during any await of startup on a slow machine. Fire every repeating timer once as it is created:
// a loop that reads something startup has not created yet fails here instead of only on a busy CI runner.
test('every server loop can tick as soon as it is scheduled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-loops-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const interval = globalThis.setInterval, ticks: string[] = [];
  t.mock.method(globalThis, 'setInterval', (fn: (...args: any[]) => unknown, ms: number, ...args: any[]) => {
    ticks.push(String(ms));
    const result = fn(...args); // Synchronous, like a tick that arrives during the next await.
    if (result instanceof Promise) result.catch(error => { throw error; });
    return interval(fn, ms, ...args);
  });
  const app = await startServer({ directory, port: 0, drafts: null,
    recognizer: { available: () => true, transcribe: async () => { throw new Error('unused'); }, close() {} },
    setup: { scan: { home: directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  t.after(() => app.close());
  assert.ok(ticks.length >= 2, `loops scheduled: ${ticks.join(', ')}`);
  assert.equal((await fetch(app.url)).ok, true);
});
