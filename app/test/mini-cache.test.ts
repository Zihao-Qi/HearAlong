import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import type { LiveDrafts, Draft, PendingDraft } from '../src/drafts.ts';
import { paragraphCachePrefix, paragraphsOf } from '../public/live-shared.js';
import { transcriptRows } from '../public/transcript-view.js';

const result = (text: string) => ({ text, words: [], backend: 'fixture', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' as const });
const mic = 'mic:fictional', tab = 'tab:fictional';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mini-cache-'));
  let drafts: Draft[] = [], pending: PendingDraft[] = [];
  const scripted = { begin: () => false, feed() {}, seal() {}, release() {}, drop() {}, setModel() {}, available: () => true,
    drafts: () => drafts, pending: () => pending, async close() {} } as unknown as LiveDrafts;
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts: scripted, echo: null,
    recognizer: { async transcribe() { return result(''); }, close() {} } });
  const meeting = app.store.createMeeting('Fictional clockwork garden'), sequences = new Map<string, number>();
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { Cookie: cookie, Origin: app.url };
  return {
    app, meeting,
    async add(source: string, startMs: number, text: string) {
      const n = sequences.get(source) ?? 0; sequences.set(source, n + 1);
      const chunk = await app.store.addPcm(meeting.id, source, n, startMs, 16000, Buffer.alloc(64000));
      app.store.completeChunk(chunk.id, result(text));
      app.store.db.prepare('UPDATE chunks SET completedAt=? WHERE id=?').run(Date.now() - 10000, chunk.id);
      return chunk;
    },
    async record(startMs: number) {
      const response = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: {
        ...headers, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': `tab:${randomUUID()}`, 'X-Sequence': '0',
        'X-Sample-Rate': '16000', 'X-Start-Ms': String(startMs), 'X-Recording': randomUUID(),
      } });
      assert.equal(response.status, 201, await response.text());
    },
    preview(kind: 'draft' | 'pending', startMs: number) {
      const draft: Draft = { meetingId: meeting.id, source: mic, window: 'fictional-window', windowStartMs: startMs,
        committedUntilMs: startMs, coveredUntilMs: startMs + 1000, text: 'copper wheels', behind: false,
        words: [{ text: 'copper wheels', startMs, endMs: startMs + 1000 }] };
      if (kind === 'draft') drafts = [draft]; else pending = [{ ...draft, chunkId: 'fictional-pending', cutMs: startMs + 1000 }];
    },
    clearPreviews() { drafts = []; pending = []; },
    async live(have = '') { return (await (await fetch(`${app.url}/api/live?have=${encodeURIComponent(have)}`, { headers })).json()).recording; },
    async snapshot() { return (await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers })).json()); },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('cache eligibility uses strict 10 s and 60 s time horizons, not a speaker lane or preview barrier flag', () => {
  const p = paragraphsOf([{ id: 'a', startMs: 0, endMs: 1000, text: 'Violet toy cranes', revision: 0, speaker: 'Me' }], [{ startMs: 1500, speaker: 'Me' }]);
  assert.equal(paragraphCachePrefix(p, 1500), 0, 'a paragraph behind a temporary barrier can still grow');
  assert.equal(paragraphCachePrefix(p, 10999), 0);
  assert.equal(paragraphCachePrefix(p, 11000), 1, '10 s is no longer joinable');
  const long = [{ startMs: 0, endMs: 59000 }];
  assert.equal(paragraphCachePrefix(long, 59999), 0);
  assert.equal(paragraphCachePrefix(long, 60000), 1, '60 s hard limit bounds mutability even when its last line is recent');
});

test('after one Me line then 30 minutes of Them, mini polls cache history instead of resending it', async () => {
  const f = await fixture();
  try {
    await f.add(tab, 0, '');
    await f.add(mic, 5000, 'Violet toy cranes wait.');
    for (let minute = 1; minute <= 30; minute++) await f.add(tab, minute * 60000, `The clockwork gardener counted parcel ${minute}.`);
    await f.record(1801000);
    const silence = await f.app.store.sealWindow(f.meeting.id, f.app.store.heldFrames(f.meeting.id));
    f.app.store.completeChunk(silence.id, result(''));
    assert.equal(f.app.store.heldFrames(f.meeting.id).length, 0, 'with no pending speech, eligibility uses the server recording clock');
    const first = await f.live();
    assert.equal(first.paragraphs.length, 31);
    assert.equal(Number(first.paragraphsTag.split('.')[1]), 30, 'the stale Me paragraph does not pin the cache to zero');
    const next = await f.live(first.paragraphsTag);
    assert.equal(next.paragraphsFrom, 30);
    assert.equal(next.paragraphs.length, 1);
    assert.equal(next.paragraphs[0].key, first.paragraphs[30].key);
    assert.ok(JSON.stringify(next).length < JSON.stringify(first).length / 2);
  } finally { await f.close(); }
});

for (const kind of ['draft', 'pending', 'queued', 'held-final'] as const) test(`${kind} start keeps a barrier-closed paragraph outside the cached prefix until finalization`, async () => {
  const f = await fixture();
  try {
    await f.add(tab, 0, 'Copper bells were counted.');
    await f.add(mic, 1000, 'Blue acorns were packed.');
    const beforeLine = await f.add(mic, 60000, 'The wooden wagon has');
    await f.add(tab, 62000, 'A violet clock chimes.');
    // A much later capture frame must not eclipse delayed recognition/preview time.
    await f.record(90000);
    let delayed;
    if (kind === 'draft' || kind === 'pending') f.preview(kind, 61500);
    else {
      delayed = await f.add(mic, 61500, kind === 'queued' ? '' : 'copper wheels.');
      if (kind === 'queued') f.app.store.setStatus(delayed.id, 'queued');
      else f.app.store.db.prepare('UPDATE chunks SET completedAt=? WHERE id=?').run(Date.now(), delayed.id);
      // Fresh microphone finals are display-held while a live call is active and undecided.
    }
    const first = await f.live();
    assert.equal(Number(first.paragraphsTag.split('.')[1]), 2, 'time horizon keeps the unfinished wagon paragraph mutable');
    assert.ok(first.paragraphs.some((p: { key: string }) => p.key === `${beforeLine.id}:0`));
    f.clearPreviews();
    if (delayed) f.app.store.completeChunk(delayed.id, result('copper wheels.'));
    else delayed = await f.add(mic, 61500, 'copper wheels.');
    // Release the bounded mic-final hold without waiting or changing the production rule.
    f.app.store.db.prepare('UPDATE chunks SET completedAt=? WHERE id=? OR id=?').run(Date.now() - 10000, beforeLine.id, delayed.id);
    const next = await f.live(first.paragraphsTag);
    assert.equal(next.paragraphsFrom, 2, 'the stable historical prefix survives finalization');
    assert.equal(next.paragraphs[0].key, `${beforeLine.id}:0`);
    assert.equal(next.paragraphs[0].text, 'The wooden wagon has copper wheels.');
  } finally { await f.close(); }
});

for (const status of ['failed', 'queued', 'cancelled'] as const) test(`segments wire response supplies ${status} chunk barriers used by screen and export`, async () => {
  const f = await fixture();
  try {
    await f.add(tab, 0, '');
    await f.add(mic, 1000, 'Violet toy cranes');
    const missing = await f.add(mic, 2500, '');
    f.app.store.setStatus(missing.id, status, '', 'Fictional delay');
    await f.add(tab, 3000, 'Blue acorns');
    await f.add(mic, 4000, 'were packed.');
    await f.add(tab, 5000, 'were counted.');
    const snapshot = await f.snapshot();
    assert.deepEqual(snapshot.paragraphBarriers, [{ startMs: 2500, speaker: 'Me' }]);
    const displayed = transcriptRows(snapshot).filter(p => p.kind === 'final').map(p => p.segments.map(s => s.text).join(' '));
    const exported = f.app.store.plainText(f.meeting.id).trim().split('\n\n').slice(1).filter(p => !p.startsWith('[')).map(p => p.replace(/^(Me|Them): /, ''));
    assert.deepEqual(displayed, ['Violet toy cranes', 'Blue acorns were counted.', 'were packed.']);
    assert.deepEqual(displayed, exported);
  } finally { await f.close(); }
});
