import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';

async function setup(extra: Parameters<typeof startServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-server-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: {
    async transcribe() { return { text: 'Test transcript', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; },
    close() {},
  }, ...extra });
  const page = await fetch(app.url);
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}${path}`, {
    ...options, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...options.headers },
  });
  return { directory, app, request, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('server close aborts and awaits glossary builds before releasing the store lock', async () => {
  let signal: AbortSignal | undefined;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let finish!: () => void;
  const work = new Promise<never>((_resolve, reject) => { finish = () => reject(new Error('cancelled build')); });
  const fixture = await setup({ heavy: async (_prompt, options) => { signal = options.signal; began(); return work; } });
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    const meeting = fixture.app.store.createMeeting('M');
    const base = `/api/meetings/${meeting.id}`;
    await fixture.request(`${base}/materials`, { method: 'POST', body: JSON.stringify({ path: fixture.directory }) });
    assert.equal((await fixture.request(`${base}/glossary/build`, { method: 'POST', body: '{}' })).status, 202);
    await started;
    closing = fixture.app.close().then(() => { closed = true; });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(signal?.aborted, true, 'the running Pi task receives cancellation');
    assert.equal(closed, false, 'close waits for the task cleanup');
    assert.equal(existsSync(join(fixture.directory, 'server.lock')), true);
    assert.equal(fixture.app.store.meetings().length, 1, 'the store stays open until the build settles');
    finish();
    await closing;
    assert.equal(existsSync(join(fixture.directory, 'server.lock')), false);
  } finally { finish(); await closing; await fixture.close(); }
});

test('mini view keeps the current recording when an older meeting sends a late frame', async () => {
  let now = 100_000;
  const fixture = await setup({ clock: () => now });
  try {
    const old = fixture.app.store.createMeeting('Old'), current = fixture.app.store.createMeeting('Current');
    const oldSource = `mic:${randomUUID()}`, currentSource = `mic:${randomUUID()}`;
    const oldRecording = randomUUID(), currentRecording = randomUUID();
    const frame = async (meeting: string, source: string, recording: string, sequence: number) => {
      const response = await fixture.request(`/api/meetings/${meeting}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
        'X-Audio-Source': source, 'X-Recording': recording, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000),
      } });
      assert.equal(response.status, 201);
      now += 1000;
    };
    await frame(old.id, oldSource, oldRecording, 0);
    await frame(current.id, currentSource, currentRecording, 0);
    const before = (await (await fixture.request('/api/live')).json()).recording;
    await frame(old.id, oldSource, oldRecording, 1);
    const after = (await (await fixture.request('/api/live')).json()).recording;
    assert.equal(after?.meetingId, current.id);
    assert.equal(after.session, before.session);
    assert.deepEqual(after.drafts.map((d: any) => d.source), [currentSource]);
  } finally { await fixture.close(); }
});

test('capture settings can be updated on a later frame when a tab is attached', async () => {
  const fixture = await setup();
  try {
    const meeting = fixture.app.store.createMeeting('M');
    const source = `mic:${randomUUID()}`;
    for (let sequence = 0; sequence < 2; sequence++) {
      const response = await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
        'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000),
        'X-Capture-Settings': JSON.stringify({ kind: 'mic', echoCancellation: sequence > 0, roomMode: sequence === 0 }),
      } });
      assert.equal(response.status, 201);
    }
    assert.deepEqual(fixture.app.store.sourceSettings(meeting.id)[source], { kind: 'mic', echoCancellation: true, roomMode: false });
  } finally { await fixture.close(); }
});

test('API requires a local session and same-origin mutations; no recording starts automatically', async () => {
  const fixture = await setup();
  try {
    const unauthenticated = await fetch(`${fixture.app.url}/api/status`);
    assert.equal(unauthenticated.status, 403);
    const blocked = await fixture.request('/api/meetings', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } });
    assert.equal(blocked.status, 403);
    const status = await (await fixture.request('/api/status')).json();
    assert.equal(status.meetings.length, 0);
    assert.equal(status.queued, 0);
    assert.equal(status.capabilities.systemAudio, false);
    assert.equal(status.capabilities.cloudModels, false);
    const create = await fixture.request('/api/meetings', { method: 'POST', body: '{}' });
    assert.equal(create.status, 201);
    assert.equal((await create.json()).mode, 'periodic');
    const script = await fetch(`${fixture.app.url}/app.js`);
    assert.match(await script.text(), /getUserMedia/);
  } finally { await fixture.close(); }
});

test('PCM is saved and processed; invalid samples/metadata are rejected', async () => {
  const fixture = await setup();
  try {
    const meeting = await (await fixture.request('/api/meetings', { method: 'POST', body: '{}' })).json();
    const source = `mic:${randomUUID()}`;
    const headers = { 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0' };
    const accepted = await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers, body: Buffer.alloc(16000 * 4) });
    assert.equal(accepted.status, 201);
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers, body: Buffer.alloc(16000 * 4) })).status, 201, 'a repeated frame is idempotent');
    const gap = await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: { ...headers, 'X-Sequence': '2' }, body: Buffer.alloc(16000 * 4) });
    assert.equal(gap.status, 409, 'a frame out of order is refused');
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: { ...headers, 'X-Sample-Rate': '48000' }, body: Buffer.alloc(16000 * 4) })).status, 400);
    assert.equal((await (await fixture.request(`/api/meetings/${meeting.id}`)).json()).audioEndMs, 1000, 'held audio counts for the next start');
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', body: JSON.stringify({ source, lastSequence: 1 }) })).status, 409, 'end waits for every frame');
    const ended = await fixture.request(`/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', body: JSON.stringify({ source, lastSequence: 0 }) });
    assert.deepEqual(await ended.json(), { sealed: 1 });
    assert.deepEqual(await (await fixture.request(`/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', body: JSON.stringify({ source, lastSequence: 0 }) })).json(), { sealed: 0 }, 'end is idempotent');
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: { ...headers, 'X-Sequence': '1' }, body: Buffer.alloc(16000 * 4) })).status, 409, 'an ended source takes no more audio');
    await fixture.app.jobs!.wait();
    const detail = await (await fixture.request(`/api/meetings/${meeting.id}`)).json();
    assert.equal(detail.chunks[0].text, 'Test transcript');
    assert.equal(detail.chunks[0].path, undefined);
    const bad = Buffer.alloc(4);
    bad.writeFloatLE(NaN);
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers, body: bad })).status, 400);
    const renamed = await fixture.request(`/api/meetings/${meeting.id}`, { method: 'PATCH', body: JSON.stringify({ title: '  Advisor\nmeeting  ' }) });
    assert.equal((await renamed.json()).title, 'Advisor meeting');
    assert.equal((await fixture.request(`/api/meetings/${meeting.id}`, { method: 'PATCH', body: '{"title":"  "}' })).status, 400);
    const wrongMode = await fixture.request(`/api/meetings/${meeting.id}`, { method: 'PATCH', body: '{"mode":"other","intervalSeconds":60}' });
    assert.equal(wrongMode.status, 400);
    const exported = await fixture.request(`/api/meetings/${meeting.id}/transcript.md`);
    assert.match(await exported.text(), /Test transcript/);
  } finally { await fixture.close(); }
});

test('one server owns a data directory at a time', async () => {
  const fixture = await setup();
  try { await assert.rejects(startServer({ directory: fixture.directory, port: 0, recognizer: null }), /owns this data directory/); }
  finally { await fixture.close(); }
});

test('segments snapshot, glossary build/edit, and correction run through the API with fake models', async () => {
  const prompts: string[] = [];
  const views: string[] = [];
  const fixture = await setup({
    correctionTickMs: 20,
    quick: { async ask(prompt) { prompts.push(prompt); const id = prompt.match(/\[([^\]]+)\] Test transcript/)?.[1]; return { text: JSON.stringify({ edits: id ? [{ id, from: 'Test', to: 'Texts' }] : [] }) }; } },
    heavy: async (_prompt, o) => { views.push(existsSync(join(o.cwd, 'pdf-text')) ? join(o.cwd, 'pdf-text') : ''); return { text: '```json\n{"terms":[{"term":"Texts","spokenVariants":["test"]}]}\n```', provider: 'fake', model: 'sol' }; },
  });
  try {
    const meeting = await (await fixture.request('/api/meetings', { method: 'POST', body: '{}' })).json();
    const base = `/api/meetings/${meeting.id}`;
    assert.equal((await fixture.request(`${base}/glossary/build`, { method: 'POST', body: '{}' })).status, 400, 'needs materials');
    const materials = await mkdtemp(join(tmpdir(), 'meeting-mat-'));
    await fixture.request(`${base}/materials`, { method: 'POST', body: JSON.stringify({ path: materials }) });
    assert.equal((await fixture.request(`${base}/glossary/build`, { method: 'POST', body: '{}' })).status, 202);
    let glossary;
    for (let i = 0; i < 50 && !glossary?.glossary; i++) { await new Promise(r => setTimeout(r, 20)); glossary = await (await fixture.request(`${base}/glossary`)).json(); }
    assert.equal(glossary.glossary.terms[0].term, 'Texts');
    assert.ok(views[0], 'the build had its own view of the PDF text');
    assert.equal(existsSync(views[0]), false, 'removed when the build ended');

    const source = `mic:${randomUUID()}`;
    const headers = { 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0' };
    await fixture.request(`${base}/pcm`, { method: 'POST', headers, body: Buffer.alloc(16000 * 4) });
    await fixture.request(`${base}/pcm/end`, { method: 'POST', body: JSON.stringify({ source, lastSequence: 0 }) });
    await fixture.app.jobs!.wait();
    let snapshot;
    for (let i = 0; i < 100; i++) {
      snapshot = await (await fixture.request(`${base}/segments`)).json();
      if (snapshot.segments[0]?.revision === 1) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.equal(snapshot.meetingId, meeting.id);
    assert.equal(snapshot.segments[0].text, 'Texts transcript');
    assert.equal(snapshot.segments[0].originalText, 'Test transcript');
    assert.deepEqual(snapshot.segments[0].edits, [{ start: 0, end: 5, from: 'Test', to: 'Texts' }]);
    assert.equal(prompts.length, 1, 'one correction call for one batch');
    assert.match(await (await fixture.request(`${base}/transcript.md?mode=raw`)).text(), /Test transcript/);

    const edited = await fixture.request(`${base}/glossary`, { method: 'PUT', body: JSON.stringify({ terms: [{ term: 'Coralbay' }] }) });
    assert.equal((await edited.json()).origin, 'user');
    await rm(materials, { recursive: true, force: true });
  } finally { await fixture.close(); }
});
