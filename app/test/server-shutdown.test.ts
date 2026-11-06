import { test, type TestContext } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { MeetingStore } from '../src/store.ts';
import { JobManager } from '../src/jobs.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'server-shutdown-'));
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  let recognizer: LocalRecognizer | undefined;
  const load = LocalRecognizer.prototype.load;
  t.mock.method(LocalRecognizer.prototype, 'load', function (this: LocalRecognizer) { recognizer = this; return load.call(this); });
  const setup = await dashboardSetup(directory, true);
  app = await startServer({ directory, port: 0, setup: { ...setup, worker: { workerScript: new URL('./fixtures/stt-child.ts', import.meta.url) } },
    drafts: null, echo: null, quick: null, heavy: null, board: null });
  assert.ok(recognizer, 'startup must warm the final recognizer in the background');
  await recognizer.load();
  return { app, directory, recognizer };
}

test('an idle quit with a warm recognizer skips the recording-page grace period and joins a clean worker exit', async t => {
  const { app, recognizer } = await fixture(t);
  const start = performance.now();
  await app.shutdown();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1500, `idle shutdown took ${elapsed} ms`);
  assert.deepEqual(recognizer.lastExit, { code: 0, signal: null }, 'no SIGKILL fallback');
  t.diagnostic(`warm idle shutdown: ${elapsed.toFixed(2)} ms`);
});

test('a quick quit during recognition leaves the saved chunk recoverable, without a fallback kill', async t => {
  const { app, directory, recognizer } = await fixture(t);
  const meeting = app.store.createMeeting('Fictional interrupted recognition');
  const pcm = Buffer.alloc(16000 * 4);
  const chunk = await app.store.addPcm(meeting.id, 'mic:fictional', 0, 0, 16000, pcm);
  app.jobs.kick();
  assert.equal(app.store.chunk(chunk.id)?.status, 'running');
  const start = performance.now();
  await app.shutdown();
  assert.ok(performance.now() - start < 1500, 'recognition alone must not trigger the page-stop delay');
  assert.deepEqual(recognizer.lastExit, { code: 0, signal: null });
  const recovered = new MeetingStore(directory);
  const jobs = new JobManager(recovered, { async transcribe(job) {
    assert.deepEqual(await readFile(job.path), pcm, 'all original samples survive');
    return { text: 'Fictional recovered transcript.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1,
      processRssBytes: 0, timestampKind: 'none', words: [] };
  }, close() {} });
  try {
    assert.equal(recovered.chunk(chunk.id)?.status, 'queued');
    assert.match(recovered.chunk(chunk.id)?.error ?? '', /Recovered an interrupted transcription/);
    jobs.kick(); await jobs.wait();
    assert.equal(recovered.chunk(chunk.id)?.status, 'completed');
    assert.equal(recovered.chunk(chunk.id)?.text, 'Fictional recovered transcript.');
  } finally { await jobs.close(); recovered.close(); }
});

for (const initial of ['saved frame', 'first frame body in flight']) test(`a recording with ${initial} retains its page-stop grace and final uploaded frame`, async t => {
  const { app, directory } = await fixture(t);
  const meeting = app.store.createMeeting('Fictional recording quit');
  const source = 'mic:00000000-0000-4000-8000-000000000001';
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body: BodyInit, headers = {}) => fetch(app.url + `/api/meetings/${meeting.id}` + path,
    { method: 'POST', body, headers: { Cookie: cookie, Origin: app.url, ...headers } });
  const frame = (sequence: number) => request('/pcm', Buffer.alloc(16000 * 4), {
    'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000),
  });
  let finishFirst: (() => Promise<void>) | undefined;
  if (initial === 'saved frame') assert.equal((await frame(0)).status, 201);
  else {
    // Headers and a partial first body are admitted, but no source is recording on disk yet.
    const first = httpRequest(app.url + `/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: {
      Cookie: cookie, Origin: app.url, 'Content-Length': 64000, 'X-Audio-Source': source,
      'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
    } });
    t.after(() => first.destroy());
    const response = new Promise<number | undefined>((resolve, reject) => {
      first.on('response', reply => { reply.resume(); reply.on('end', () => resolve(reply.statusCode)); });
      first.on('error', reject);
    });
    first.write(Buffer.alloc(4));
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = await (await fetch(app.url + '/api/status', { headers: { Cookie: cookie } })).json();
      if (status.recordingAnywhere) { assert.equal(status.recording, false); break; }
      assert.ok(Date.now() < deadline, 'first PCM body must be admitted');
      await sleep(20);
    }
    finishFirst = async () => { first.end(Buffer.alloc(64000 - 4)); assert.equal(await response, 201); };
  }
  const start = performance.now();
  const stopping = app.shutdown();
  try {
    await sleep(50);
    await finishFirst?.();
    const tail = await frame(1);
    assert.equal(tail.status, 201);
    assert.equal((await tail.json()).quit, true);
    const ended = await request('/pcm/end', JSON.stringify({ source, lastSequence: 1, stopping: true }), { 'Content-Type': 'application/json' });
    assert.equal(ended.status, 200);
  } finally { await stopping; }
  assert.ok(performance.now() - start >= 2400, 'the recording page must retain its existing grace period');
  const recovered = new MeetingStore(directory);
  try {
    assert.equal(recovered.chunks(meeting.id).reduce((sum, chunk) => sum + chunk.seconds, 0), 2);
    assert.equal(recovered.openRecordings().length, 0);
  } finally { recovered.close(); }
});
