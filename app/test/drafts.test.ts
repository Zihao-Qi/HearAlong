import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDrafts } from '../src/drafts.ts';

const worker = new URL('./fixtures/fake-stream-worker.ts', import.meta.url);
const pcm = (first: number) => { const a = new Float32Array(16000); a[0] = first; return a; };
import { until } from './helpers/until.ts';

test('drafts follow their window and drop cleanly; a crashed worker only costs the draft', async () => {
  const logs: string[] = [];
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript: worker, log: m => logs.push(m) });
  try {
    assert.equal(drafts.begin('m', 'mic:a', 'w0', 0), true);
    drafts.feed('w0', pcm(1)); drafts.feed('w0', pcm(2));
    await until(() => drafts.drafts('m')[0]?.coveredUntilMs === 2000);
    assert.deepEqual(drafts.drafts('m').map(d => [d.window, d.text, d.behind, d.coveredUntilMs]), [['w0', 'w1 w2', false, 2000]]);
    assert.equal(drafts.begin('m', 'mic:b', 'v0', 0), true);
    assert.equal(drafts.begin('m', 'mic:c', 'u0', 0), false, 'at most two live sources get drafts');
    drafts.drop('w0');
    assert.deepEqual(drafts.drafts('m').map(d => d.window), ['v0']);
    drafts.feed('v0', pcm(4));
    await until(() => drafts.drafts('m')[0]?.text === 'w4');
    drafts.feed('v0', pcm(7)); // the worker exits
    await until(() => logs.some(l => /exited/.test(l)));
    assert.deepEqual(drafts.drafts('m').map(d => [d.text, d.behind]), [['w4', true]]);
    assert.ok(logs.some(l => /exited/.test(l)));
    drafts.drop('v0');
    assert.equal(drafts.begin('m', 'mic:b', 'v1', 0), true, 'a new window gets a fresh worker');
    drafts.feed('v1', pcm(5));
    await until(() => drafts.drafts('m')[0]?.text === 'w5');
    assert.equal(drafts.drafts('m')[0].text, 'w5');
  } finally { await drafts.close(); }
});

test('a hung worker is killed by the watchdog even after its window is behind and no more audio arrives', async t => {
  const logs: string[] = [];
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Backlog limit below the hang limit (as in the defaults): "behind" must not hide the hang.
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript: worker, maxBacklogMs: 100, hangMs: 400, log: m => logs.push(m) });
  try {
    drafts.begin('m', 'mic:a', 'w0', 0);
    drafts.feed('w0', pcm(2));
    await until(() => drafts.drafts('m')[0]?.text === 'w2'); // loaded and feeding
    drafts.feed('w0', pcm(9)); // hangs the worker's queue
    now = 200;
    drafts.feed('w0', pcm(1)); // refused: behind
    assert.equal(drafts.drafts('m')[0].behind, true);
    drafts.drop('w0'); // a seal; the hung feed is still unanswered
    now = 700;
    t.mock.timers.tick(200); // silence: only the watchdog can notice the unanswered feed
    assert.ok(logs.some(l => /stopped answering/.test(l)), 'killed by the timer');
    assert.equal(drafts.begin('m', 'mic:a', 'w1', 0), true);
    drafts.feed('w1', pcm(3));
    await until(() => drafts.drafts('m')[0]?.text === 'w3');
    assert.deepEqual(drafts.drafts('m').map(d => [d.text, d.behind]), [['w3', false]]);
  } finally { await drafts.close(); }
});

test('a burst after a cut is not "behind"', async () => {
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript: worker, maxBacklogMs: 300, hangMs: 60_000 });
  try {
    drafts.begin('m', 'mic:a', 'w0', 0);
    for (let n = 11; n <= 18; n++) drafts.feed('w0', pcm(n)); // 8 s replayed at once (7 and 9 are the fake's signals)
    await until(() => drafts.drafts('m')[0]?.text.split(' ').length === 8);
    assert.deepEqual(drafts.drafts('m').map(d => [d.text.split(' ').length, d.behind]), [[8, false]]);
  } finally { await drafts.close(); }
});

test('a model that never loads holds a bounded queue, drops discard queued audio, and the worker is killed', async t => {
  const logs: string[] = [];
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  process.env.FAKE_NEVER_READY = '1';
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript: worker, maxQueued: 3, loadMs: 300, log: m => logs.push(m) });
  try {
    drafts.begin('m', 'mic:a', 'w0', 0); // 1 queued (begin)
    for (let n = 1; n <= 5; n++) drafts.feed('w0', pcm(n));
    assert.equal(drafts.drafts('m')[0].behind, true, 'the queue limit marks the window behind');
    drafts.drop('w0');
    drafts.begin('m', 'mic:a', 'w1', 0);
    drafts.feed('w1', pcm(1));
    assert.equal(drafts.drafts('m')[0].behind, false, 'the dropped window freed its queue');
    now = 1200;
    t.mock.timers.tick(1000);
    assert.ok(logs.some(l => /did not load/.test(l)));
    assert.equal(drafts.drafts('m')[0].behind, true);
  } finally { delete process.env.FAKE_NEVER_READY; await drafts.close(); }
});
