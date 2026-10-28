import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LiveDrafts } from '../src/drafts.ts';
import { startServer } from '../src/server.ts';
import { composePreview } from '../public/preview-composition.js';
import { transcriptRows } from '../public/transcript-view.js';
import type { Chunk } from '../src/store.ts';
const workerScript = new URL('./fixtures/m9a-hypothesis-worker.ts', import.meta.url);
const pcm = (code: number) => { const samples = new Float32Array(16000); samples[0] = code; return samples; };
async function until(condition: () => boolean) { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw new Error('Timed out waiting for hypothesis'); await new Promise(r => setTimeout(r, 20)); } }
const chunk = (id: string, startMs: number, seconds: number): Pick<Chunk, 'id' | 'source' | 'startMs' | 'seconds' | 'status' | 'text'> => ({ id, source: 'mic:a', startMs, seconds, status: 'queued', text: '' });

test('M9a fix 2: tentative replay masks pending words reversibly; only committed coverage retires them', async () => {
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const a = chunk('a', 0, 16);
  try {
    drafts.begin('m', a.source, 'old', 0); drafts.feed('old', pcm(1));
    await until(() => drafts.drafts('m')[0]?.words.length === 3);
    drafts.seal('old', a); drafts.begin('m', a.source, 'replay', 16000);
    drafts.feed('replay', pcm(2)); await until(() => drafts.drafts('m')[0]?.text === 'stable carry');
    assert.equal(drafts.drafts('m')[0].committedUntilMs, 16400);
    assert.equal(drafts.drafts('m')[0].coveredUntilMs, 17300);
    const waiting = () => drafts.pending('m', [a], new Set());
    const shown = () => composePreview(drafts.drafts('m'), waiting()).flatMap(p => p.words.map(w => w.text));
    assert.ok(waiting()[0].words.some(w => w.text === 'carry'), '17.1 s pending word must not be deleted by a tentative suffix reaching 17.3 s');
    assert.equal(shown().filter(w => w === 'carry').length, 1, 'tentative text masks, rather than duplicates, the pending word');
    drafts.feed('replay', pcm(3)); await until(() => drafts.drafts('m')[0]?.text === 'stable');
    assert.equal(drafts.drafts('m')[0].coveredUntilMs, 16400, 'display coverage retracts with the current hypothesis');
    assert.equal(shown().filter(w => w === 'carry').length, 1, 'retracting the tentative suffix restores the pending word');
    drafts.feed('replay', pcm(6)); await until(() => drafts.drafts('m')[0]?.text === 'stable far');
    assert.deepEqual(shown(), ['before', 'stable', 'carry', 'tail', 'far'], 'a far tentative word must not mask or move ahead of pending words in its gap');
    drafts.feed('replay', pcm(4)); await until(() => drafts.drafts('m')[0]?.text === 'stable carry');
    assert.ok(!waiting()[0].words.some(w => w.text === 'carry'), 'committing through 17.3 s permanently retires that word');
  } finally { await drafts.close(); }
});
test('M9a fix 2: pending gaps split display runs without duplicating chunk row keys', () => {
  const older = { source: 'mic:a', window: 'old', chunkId: 'a', windowStartMs: 0, cutMs: 16000,
    committedUntilMs: 24000, coveredUntilMs: 24000, behind: false, text: 'carry', words: [{ text: 'carry', startMs: 18100, endMs: 18300 }] };
  const newer = { ...older, window: 'new', chunkId: 'b', windowStartMs: 16000, cutMs: 24000,
    committedUntilMs: 16400, coveredUntilMs: 23600, words: [{ text: 'stable', startMs: 16100, endMs: 16200 }, { text: 'far', startMs: 23400, endMs: 23600 }] };
  const rows = transcriptRows({ segments: [], drafts: [], pending: [older, newer] });
  assert.deepEqual(rows.flatMap(r => r.preview!.words.map(w => w.text)), ['stable', 'carry', 'far']);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
});

for (const status of ['completed', 'failed', 'cancelled'] as const) test(`M9a fix 2: ${status} successor owns its interval in older pending tails`, async () => {
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const a = chunk('a', 0, 16), b = chunk('b', 16000, 8);
  try {
    drafts.begin('m', a.source, 'old', 0); drafts.feed('old', pcm(1));
    await until(() => drafts.drafts('m')[0]?.words.length === 3);
    drafts.seal('old', a);
    drafts.begin('m', a.source, 'stop-tail', 16000); drafts.seal('stop-tail', b); drafts.release(a.source);
    a.status = 'completed'; a.text = 'before';
    assert.equal(drafts.pending('m', [a, b], new Set(['a']))[0].text, 'carry tail');
    b.status = status; // completed is deliberately empty; none of these have rendered segment ids.
    assert.deepEqual(drafts.pending('m', [a, b], new Set(['a'])), [], 'B must retire A’s words inside 16–24 s too');
  } finally { await drafts.close(); }
});

test('M9a fix 2: terminal intervals also mask active drafts in the HTTP snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm9a-terminal-active-'));
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts,
    recognizer: { async transcribe() { return { text: '', backend: 'scripted', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} } });
  try {
    const meeting = app.store.createMeeting(), source = `mic:${randomUUID()}`;
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: {
      Cookie: cookie, Origin: app.url, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source,
      'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
    }, body: Buffer.from(pcm(8).buffer) });
    assert.equal(response.status, 201);
    await until(() => drafts.drafts(meeting.id)[0]?.words.length === 1);
    const c = await app.store.sealWindow(meeting.id, app.store.heldFrames(meeting.id, source));
    // Leave the recognizer window active, as during asynchronous seal cleanup before the parent freezes it.
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      app.store.setStatus(c.id, status);
      const snapshot = await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers: { Cookie: cookie } })).json();
      assert.deepEqual(snapshot.drafts[0].words, [], `${status} interval must own active words too`);
      assert.equal(snapshot.drafts[0].text, '');
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('M9a fix 2: equal-time mic finals split around tab pending; all promoted text gets a placement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm9a-ties-'));
  const drafts = new LiveDrafts({ modelPath: 'unused', workerScript });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts,
    recognizer: { async transcribe() { return { text: '', backend: 'scripted', computeMs: 0, decodeMs: 0, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} } });
  try {
    const meeting = app.store.createMeeting(), mic = `mic:${randomUUID()}`, tab = `tab:${randomUUID()}`, recording = randomUUID();
    const cookie = (await fetch(`${app.url}/mini.html`)).headers.get('set-cookie')!.split(';')[0];
    for (const [source, seconds, code] of [[mic, 3, 0], [tab, 1, 8]] as const) for (let i = 0; i < seconds; i++) {
      const response = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: {
        Cookie: cookie, Origin: app.url, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source,
        'X-Sequence': String(i), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(i * 1000), 'X-Recording': recording,
      }, body: Buffer.from(pcm(code).buffer) });
      assert.equal(response.status, 201);
    }
    await until(() => drafts.drafts(meeting.id).some(d => d.source === tab && d.text === 'tab-tie'));
    const micChunk = await app.store.sealWindow(meeting.id, app.store.heldFrames(meeting.id, mic));
    const tabChunk = await app.store.sealWindow(meeting.id, app.store.heldFrames(meeting.id, tab));
    drafts.drop(`${mic}:0`); drafts.seal(`${tab}:0`, tabChunk);
    app.store.completeChunk(micChunk.id, { text: 'mic-zero mic-two', segments: [
      { text: 'mic-zero', t0Ms: 0, t1Ms: 500 }, { text: 'mic-two', t0Ms: 2000, t1Ms: 2500 },
    ], backend: 'scripted', computeMs: 0, decodeMs: 0, audioSeconds: 3, processRssBytes: 0, words: [], timestampKind: 'segment' });
    const model = (await (await fetch(`${app.url}/api/live`, { headers: { Cookie: cookie } })).json()).recording;
    assert.deepEqual(model.paragraphs.map((p: any) => p.text), ['mic-zero', 'mic-two'], 'the pending row at 0 s must split the mic paragraph between its 0 s and 2 s lines');
    const placement = model.pending.find((p: any) => p.chunkId === tabChunk.id).placements[0];
    assert.equal(placement.beforeKey, model.paragraphs[1].key);
    assert.equal(placement.text, 'tab-tie');
    assert.equal(model.drafts.find((d: any) => d.source === tab).text, '', 'placed text is not repeated in its slot');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
