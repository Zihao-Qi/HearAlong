import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDrafts } from '../src/drafts.ts';
import type { Chunk } from '../src/store.ts';
const workerScript = new URL('./fixtures/fake-stream-worker.ts', import.meta.url);
const pcm = (n: number) => { const a = new Float32Array(16000); a[0] = n; return a; };
async function until(condition: () => boolean) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw new Error('Timed out waiting for fake stream'); await new Promise(r => setTimeout(r, 20)); } }
const chunk = (id: string, startMs: number, seconds: number): Pick<Chunk, 'id' | 'source' | 'startMs' | 'seconds' | 'status' | 'text'> => ({ id, source: 'mic:a', startMs, seconds, status: 'queued', text: '' });

test('M9a pending: final before slow replay retires only before the cut; replay retirement survives the next seal and Stop', async () => {
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const c1 = chunk('c1', 10_000, 2), c2 = chunk('c2', 12_000, 2);
  const chunks = [c1, c2];
  try {
    drafts.begin('m', 'mic:a', 'w0', 10_000);
    for (const n of [1, 2, 3, 4]) drafts.feed('w0', pcm(n));
    await until(() => drafts.drafts('m')[0]?.words.length === 4);
    assert.deepEqual(drafts.drafts('m')[0].words[0], { text: 'w1', startMs: 10_000, endMs: 11_000 });
    drafts.seal('w0', c1);
    drafts.begin('m', 'mic:a', 'w2', 12_000);
    assert.equal(drafts.pending('m', chunks, new Set())[0].text, 'w1 w2 w3 w4');
    c1.status = 'completed'; c1.text = 'final first';
    assert.equal(drafts.pending('m', chunks, new Set())[0].text, 'w1 w2 w3 w4', 'not retired until final is in this response');
    assert.equal(drafts.pending('m', chunks, new Set(['c1']))[0].text, 'w3 w4', 'after-cut words survive an early final');
    drafts.feed('w2', pcm(3));
    await until(() => drafts.drafts('m')[0]?.words.length === 1);
    assert.equal(drafts.pending('m', chunks, new Set(['c1']))[0].text, 'w4', 'only the part covered by active is retired');
    drafts.seal('w2', c2); drafts.release('mic:a');
    assert.deepEqual(drafts.pending('m', chunks, new Set(['c1'])).map(p => [p.chunkId, p.text]), [['c1', 'w4'], ['c2', 'w3']], 'two pending blocks survive Stop and recognizer release');
    c2.status = 'completed'; c2.text = 'final second';
    assert.deepEqual(drafts.pending('m', chunks, new Set(['c1', 'c2'])), [], 'a later final also replaces the old preview tail in its interval');
  } finally { await drafts.close(); }
});
test('M9a pending: unlimited blocks; empty, failed and cancelled chunks retire when terminal, not at Stop', async () => {
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const chunks = Array.from({ length: 4 }, (_, i) => chunk(`c${i}`, i * 1000, 1));
  try {
    for (const [i, c] of chunks.entries()) {
      drafts.begin('m', 'mic:a', `w${i}`, i * 1000); drafts.feed(`w${i}`, pcm(i + 1));
      await until(() => drafts.drafts('m').find(w => w.window === `w${i}`)?.words.length === 1);
      drafts.seal(`w${i}`, c);
    }
    drafts.release('mic:a');
    assert.equal(drafts.pending('m', chunks, new Set()).length, 4);
    chunks[0].status = 'completed'; chunks[1].status = 'failed'; chunks[2].status = 'cancelled';
    assert.deepEqual(drafts.pending('m', chunks, new Set()).map(p => p.chunkId), ['c3']);
    assert.equal(drafts.drafts('m').length, 0);
  } finally { await drafts.close(); }
});
