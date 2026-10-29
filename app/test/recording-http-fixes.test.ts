import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';
import { uploadWithRetry } from '../public/upload-retry.js';

const result = { text: 'Fictional recording.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'recording-http-fixes-'));
  let now = 100_000;
  const options = { directory, port: 0, setup: await dashboardSetup(directory), recognizer: { async transcribe() { return result; }, close() {} },
    drafts: null, quick: null, heavy: null, notes: null, actions: null, board: null, plans: null, clock: () => now };
  let app = await startServer(options);
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie')!.split(';')[0];
  const meeting = app.store.createMeeting('Fictional restart'), source = `mic:${randomUUID()}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init,
    headers: { Cookie: cookie, Origin: app.url, 'X-Page': 'fictional-page', 'Content-Type': 'application/json', ...init.headers } });
  return { directory, meeting, source, cookie, page, get app() { return app; }, request,
    frame: (sequence: number) => request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: {
      'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000),
    } }),
    end: () => request(`/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', body: JSON.stringify({ source, lastSequence: null }) }),
    advance(ms: number) { now += ms; },
    async restart() { await app.close(); app = await startServer(options); },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a recording cookie survives restart through real HTTP checks, without another navigation', async () => {
  const f = await fixture();
  try {
    assert.match(f.page.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\//);
    assert.equal((await f.frame(0)).status, 201);
    await f.restart();
    assert.equal((await f.frame(1)).status, 201, 'the original page cookie can continue its sequence');
    assert.equal((await f.request('/api/status')).status, 200);
    assert.equal((await fetch(`${f.app.url}/api/status`)).status, 403);
    assert.equal((await f.request('/api/meetings', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await f.request('/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.end()).status, 200);
    assert.equal((await f.frame(2)).status, 409, 'a late frame cannot reopen a finished source');
    assert.equal(f.app.store.recordingUnended(f.meeting.id), false);
    const tokenPath = join(f.directory, 'session-token');
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    const token = await readFile(tokenPath, 'utf8');
    assert.match(token, /^[a-f0-9]{64}$/);
    await f.restart();
    assert.equal(await readFile(tokenPath, 'utf8'), token, 'normal restarts do not rotate the token');
    await writeFile(tokenPath, 'interrupted/corrupt token');
    await f.restart();
    assert.notEqual(await readFile(tokenPath, 'utf8'), token, 'unusable token is replaced atomically');
    assert.equal((await f.request('/api/status')).status, 403, 'a replaced token does not accept the old cookie');
  } finally { await f.close(); }
});

test('operational frame failures are retryable, but sequence conflicts are still permanent', async t => {
  const f = await fixture();
  try {
    const original = f.app.store.addFrame.bind(f.app.store);
    let calls = 0;
    t.mock.method(f.app.store, 'addFrame', async (...args: Parameters<typeof original>) => {
      if (++calls === 1) throw Object.assign(new Error('Fictional transient storage error'), { code: 'EIO' });
      return original(...args);
    });
    const statuses: number[] = [];
    await uploadWithRetry({ sleep: async () => {}, attempt: async () => {
      const reply = await f.frame(0); statuses.push(reply.status);
      if (!reply.ok) throw Object.assign(new Error((await reply.json()).error), { status: reply.status });
      return reply;
    } });
    assert.deepEqual(statuses, [503, 201]);
    assert.equal((await f.frame(2)).status, 409);
    assert.equal((await f.end()).status, 200);
  } finally { await f.close(); }
});

test('a post-commit seal error does not revoke the frame acknowledgement; held audio can seal later', async t => {
  const f = await fixture();
  try {
    const original = f.app.store.sealWindow.bind(f.app.store);
    let calls = 0;
    t.mock.method(f.app.store, 'sealWindow', async (...args: Parameters<typeof original>) => {
      if (++calls === 1) throw Object.assign(new Error('Fictional temporary seal error'), { code: 'EIO' });
      return original(...args);
    });
    for (let n = 0; n < 24; n++) assert.equal((await f.frame(n)).status, 201, `frame ${n} is durable`);
    assert.equal(f.app.store.lastFrameSequence(f.meeting.id, f.source), 23);
    assert.equal(f.app.store.heldFrames(f.meeting.id).length, 24);
    assert.equal((await f.end()).status, 200);
    await f.app.jobs.wait();
    assert.equal(f.app.store.heldFrames(f.meeting.id).length, 0);
    assert.equal(f.app.store.chunks(f.meeting.id).reduce((sum, c) => sum + c.seconds, 0), 24);
  } finally { await f.close(); }
});

test('a status heartbeat after restart cannot reopen a source the page no longer captures', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.frame(0)).status, 201);
    await f.restart();
    // Establish a current cookie separately so this tests source recovery independently of token persistence.
    const cookie = (await fetch(f.app.url)).headers.get('set-cookie')!.split(';')[0];
    await fetch(`${f.app.url}/api/status`, { headers: { Cookie: cookie, 'X-Page': 'fictional-page' } });
    assert.equal(f.app.store.openRecordings()[0].state, 'recovering');
    f.advance(61_000); await f.app.capture.sweep();
    assert.equal(f.app.store.recordingUnended(f.meeting.id), false);
  } finally { await f.close(); }
});

for (const source of ['ended', 'new'] as const) for (const body of ['valid', 'empty', 'invalid'] as const) {
  test(`rejected ${body} PCM from an ${source} source after Stop preserves idle state and retention`, async () => {
    const f = await fixture();
    try {
      assert.equal((await f.frame(0)).status, 201);
      assert.equal((await f.end()).status, 200);
      await f.app.jobs.wait(); f.app.audioRetention.observe();
      const doneAt = f.app.store.meeting(f.meeting.id).audioDoneAt;
      assert.notEqual(doneAt, null); assert.deepEqual(f.app.busy(f.meeting.id), []);
      f.advance(5000);
      const pcm = body === 'empty' ? Buffer.alloc(0) : Buffer.alloc(4);
      if (body === 'invalid') pcm.writeFloatLE(NaN);
      const response = await f.request(`/api/meetings/${f.meeting.id}/pcm`, { method: 'POST', body: pcm, headers: {
        'X-Audio-Source': source === 'ended' ? f.source : `mic:${randomUUID()}`,
        'X-Sequence': '1', 'X-Sample-Rate': '16000', 'X-Start-Ms': '1000',
      } });
      assert.equal(response.status, body === 'valid' ? 409 : 400);
      assert.deepEqual(f.app.busy(f.meeting.id), [], 'rejected PCM is not recording activity');
      assert.equal(f.app.store.recordingUnended(f.meeting.id), false);
      assert.equal(f.app.capture.active(f.meeting.id), false);
      const status = await (await f.request('/api/status')).json();
      assert.equal(status.recordingAnywhere, false);
      f.app.audioRetention.observe();
      assert.equal(f.app.store.meeting(f.meeting.id).audioDoneAt, doneAt, 'a rejection must not restart the retention clock');
      assert.doesNotThrow(() => f.app.store.deleteMeeting(f.meeting.id), 'a rejected request must not block deletion');
    } finally { await f.close(); }
  });
}

test('pending PCM bodies protect against removal without changing the retention clock, and release on rejection', async () => {
  const f = await fixture();
  const requests: ReturnType<typeof httpRequest>[] = [];
  try {
    assert.equal((await f.frame(0)).status, 201); assert.equal((await f.end()).status, 200);
    await f.app.jobs.wait(); f.app.audioRetention.observe();
    const doneAt = f.app.store.meeting(f.meeting.id).audioDoneAt;
    assert.notEqual(doneAt, null);
    const start = () => {
      let request!: ReturnType<typeof httpRequest>;
      const response = new Promise<number>((resolve, reject) => {
        request = httpRequest(`${f.app.url}/api/meetings/${f.meeting.id}/pcm`, { method: 'POST', headers: {
          Cookie: f.cookie, Origin: f.app.url, Expect: '100-continue', 'Content-Length': '8', 'X-Audio-Source': `mic:${randomUUID()}`,
          'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '1000',
        } }, reply => { reply.resume(); reply.once('end', () => resolve(reply.statusCode!)); });
        request.once('error', reject);
      });
      void response.catch(() => {}); // Early assertion cleanup may abort a still-pending fictional request.
      const arrived = new Promise<void>(resolve => request.once('continue', resolve));
      requests.push(request); request.write(Buffer.alloc(4));
      return { request, response, arrived };
    };
    const first = start(); await first.arrived;
    const second = start(); await second.arrived;
    f.app.audioRetention.observe();
    assert.equal(f.app.store.meeting(f.meeting.id).audioDoneAt, doneAt, 'an unvalidated body must not clear completion');
    assert.throws(() => f.app.store.inspectMeetingDeletion(f.meeting.id), /server activity/);
    const invalid = Buffer.alloc(4); invalid.writeFloatLE(NaN);
    first.request.end(invalid); assert.equal(await first.response, 400);
    assert.ok(f.app.busy(f.meeting.id).length > 0, 'the second upload still owns its guard');
    assert.throws(() => f.app.store.inspectMeetingDeletion(f.meeting.id), /server activity/);
    second.request.end(invalid); assert.equal(await second.response, 400);
    assert.deepEqual(f.app.busy(f.meeting.id), []);
    f.app.audioRetention.observe(); assert.equal(f.app.store.meeting(f.meeting.id).audioDoneAt, doneAt);
    assert.doesNotThrow(() => f.app.store.deleteMeeting(f.meeting.id));
  } finally { for (const request of requests) request.destroy(); await f.close(); }
});

test('accepted PCM after Stop starts recording activity and resets completion only on success', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.frame(0)).status, 201); assert.equal((await f.end()).status, 200);
    await f.app.jobs.wait(); f.app.audioRetention.observe();
    assert.notEqual(f.app.store.meeting(f.meeting.id).audioDoneAt, null);
    const response = await f.request(`/api/meetings/${f.meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: {
      'X-Audio-Source': `mic:${randomUUID()}`, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '1000',
    } });
    assert.equal(response.status, 201);
    assert.deepEqual(f.app.busy(f.meeting.id), ['the recording']);
    assert.equal(f.app.store.recordingUnended(f.meeting.id), true);
    assert.equal(f.app.store.meeting(f.meeting.id).audioDoneAt, null);
  } finally { await f.close(); }
});

test('queue storage errors are exposed to the page without failing the status endpoint', async () => {
  const f = await fixture();
  try {
    (f.app.jobs as typeof f.app.jobs & { storageError: string | null }).storageError = 'Fictional storage error';
    const status = await (await f.request('/api/status')).json();
    assert.equal(status.transcriptionStorageError, 'Fictional storage error');
  } finally { await f.close(); }
});
