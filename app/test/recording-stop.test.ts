import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// The page may discard its capture session, but must hand the end message to a separately owned retry queue.
test('endSource retains a failed source end outside the finished capture session', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('function endSource('), app.indexOf('/** Stops the physical input'));
  let attempts = 0, finished = false;
  const pending: { path: string; value: unknown }[] = [];
  const attempt = async () => { attempts++; throw new Error('Fictional lost connection'); };
  const source: any = { kind: 'mic', sourceId: 'mic:fictional', sequence: 1, uploads: Promise.resolve(), node: { disconnect() {}, port: { postMessage() { source.flushResolve(); } } } };
  const session = { path: '/api/meetings/fictional', sources: new Map([['mic', source]]), stopping: true };
  const end = runInNewContext(`${code}\nendSource`, { Date, Promise, setTimeout: () => 0, SOURCE_NAMES: { mic: 'Microphone' },
    freezeSource() {}, apiWithin: attempt, log() {}, async finishSession() { finished = true; }, controls() {}, renderLive() {}, lastSnapshot: null,
    recordingEnds: { async end(path: string, value: unknown) { pending.push({ path, value }); return attempt(); } },
  });
  await end(session, source);
  assert.equal(attempts, 1); assert.equal(finished, true); assert.equal(session.sources.size, 0);
  assert.equal(pending.length, 1, 'end message remains owned after the capture session is discarded');
  assert.equal(pending[0].path, '/api/meetings/fictional/pcm/end');
  assert.deepEqual(JSON.parse(JSON.stringify(pending[0].value)), { source: source.sourceId, lastSequence: 0, stopping: true });
});
