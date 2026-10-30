import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperStatus, type HelperActivity } from '../src/helper-status.ts';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { NotesJobs } from '../src/notes.ts';
import { ActionJobs } from '../src/actions.ts';
import { Proposals } from '../src/proposals.ts';
import { Boards } from '../src/board.ts';
import { Corrector } from '../src/correction.ts';
import { ModelDownload } from '../src/setup/model-download.ts';

const labels: Record<HelperActivity, string> = {
  'the notes': 'Writing notes', 'the plans': 'Making plans', 'an action': 'Writing answers',
  'the memory update': 'Updating memory', 'a board scan': 'Scanning the Board',
  'the glossary corrections': 'Correcting the transcript', 'the glossary build': 'Building the glossary',
  'the recording': 'Finishing the recording', 'the replay': 'Finishing the replay',
  'the transcription': 'Transcribing audio', 'the import': 'Importing audio', 'the speech download': 'Downloading the speech model',
};
for (const [activity, label] of Object.entries(labels)) test(`helper endpoint body: ${activity}`, () => {
  for (const pageOpen of [false, true]) {
    const status = helperStatus(pageOpen, true, { activity, title: 'Weekly sync' });
    assert.equal(status.pageOpen, pageOpen);
    assert.equal(status.working, true);
    assert.equal(status.label, `${label} for Weekly sync`);
    assert.equal(status.title, 'Weekly sync');
    assert.ok(status.kind);
  }
});
test('helper endpoint body: idle, unknown work, missing and long titles', () => {
  assert.deepEqual(helperStatus(false, false), { pageOpen: false, working: false, label: 'Finishing work in the background', kind: null, title: null });
  assert.equal(helperStatus(true, true, { activity: 'unknown' }).label, 'Finishing work in the background');
  assert.equal(helperStatus(false, true, { activity: 'the speech download' }).label, 'Downloading the speech model');
  assert.equal(helperStatus(false, true, { activity: 'the notes', title: '  Weekly\nsync  ' }).label, 'Writing notes for Weekly sync');
  assert.equal(helperStatus(false, true, { activity: 'the notes', title: '🎵'.repeat(50) }).title, '🎵'.repeat(39) + '…');
  assert.equal(helperStatus(false, false, { activity: 'the notes', title: 'Weekly sync' }).kind, null);
});

async function fixture(extra: Parameters<typeof startServer>[0] = {}, directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'hearalong-helper-status-'));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null, ...extra });
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = (path: string, init: RequestInit = {}) => fetch(app.url + path, { ...init,
    headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...init.headers } });
  const status = async () => {
    const response = await call('/api/helper/status');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  return { app, directory, cookie, call, status, async close() { await app.close(); await rm(directory!, { recursive: true, force: true }); } };
}

test('helper HTTP endpoint: authenticated, host/cross-site checked, read-only, pages open/closed and idle', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.app.url + '/api/helper/status')).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(f.app.url + '/api/helper/status', { headers: { Cookie: f.cookie, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await f.call('/api/helper/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.call('/api/helper/status', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await f.status()).pageOpen, false, 'helper session and GET / do not claim a page');
    await f.call('/api/status', { headers: { 'X-Page': 'first' } });
    await f.call('/api/status', { headers: { 'X-Page': 'second' } });
    assert.deepEqual([(await f.status()).pageOpen, (await f.status()).working], [true, false]);
    await f.call('/api/bye?page=first', { method: 'POST' });
    assert.equal((await f.status()).pageOpen, true, 'other page still open');
    await f.call('/api/bye?page=second', { method: 'POST' });
    assert.deepEqual([(await f.status()).pageOpen, (await f.status()).working], [false, false]);
    assert.equal((await f.call('/api/helper/status', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await f.status()).working, false, 'a refused mutation releases its admission');
  } finally { await f.close(); }
});

// Unit-level HTTP tests inject only activity predicates, not the endpoint/formatter: both working() and labels must agree.
for (const kind of ['notes', 'plans', 'actions', 'memory', 'board', 'corrections'] as const) test(`helper HTTP endpoint labels ${kind} while a page is open or closed`, async t => {
  const f = await fixture(kind === 'corrections' ? { quick: { async ask() { return { text: '{"edits":[]}' }; } } } : {});
  try {
    f.app.store.createMeeting('Weekly sync');
    const mock = kind === 'notes' ? t.mock.method(NotesJobs.prototype, 'busy', () => true)
      : kind === 'plans' ? t.mock.method(f.app.explorations, 'busy', () => true)
      : kind === 'actions' ? t.mock.method(ActionJobs.prototype, 'busy', () => true)
      : kind === 'memory' ? t.mock.method(Proposals.prototype, 'busy', () => true)
      : kind === 'board' ? t.mock.method(Boards.prototype, 'busy', () => true)
      : t.mock.method(Corrector.prototype, 'isBusy', () => true);
    const label = { notes: 'Writing notes', plans: 'Making plans', actions: 'Writing answers', memory: 'Updating memory', board: 'Scanning the Board', corrections: 'Correcting the transcript' }[kind];
    assert.deepEqual(await f.status(), { pageOpen: false, working: true, label: `${label} for Weekly sync`, kind, title: 'Weekly sync' });
    await f.call('/api/status', { headers: { 'X-Page': 'window' } });
    assert.equal((await f.status()).pageOpen, true);
    await f.call('/api/bye?page=window', { method: 'POST' });
    assert.equal((await f.status()).pageOpen, false);
    mock.mock.restore();
    assert.equal((await f.status()).working, false);
  } finally { await f.close(); }
});

test('helper HTTP endpoint labels queued transcription, import, and speech download/checking', async () => {
  let download!: ModelDownload;
  const f = await fixture({ setup: { createDownload: options => (download = new ModelDownload(options)), ffmpeg: async () => ({ found: true, ffmpeg: '/fictional/ffmpeg', ffprobe: '/fictional/ffprobe' }) },
    recognizer: { async transcribe() { throw new Error('not used'); }, close() {} } });
  let upload: ReturnType<typeof httpRequest> | undefined;
  try {
    const meeting = f.app.store.createMeeting('Weekly sync');
    await download.ready;
    for (const state of [{ state: 'downloading', bytes: 0, total: 1, etaSeconds: null }, { state: 'checking' }] as const) {
      download.state = state;
      assert.deepEqual(await f.status(), { pageOpen: false, working: true, label: 'Downloading the speech model', kind: 'download', title: null });
    }
    download.state = { state: 'idle' };
    // An admitted streaming upload is held open; no ffmpeg process or external network is used.
    upload = httpRequest(f.app.url + `/api/meetings/${meeting.id}/upload`, { method: 'POST', headers: { Cookie: f.cookie, Origin: f.app.url } });
    upload.on('error', () => {});
    upload.write(Buffer.from('synthetic partial import'));
    let imported = false;
    for (let i = 0; i < 100; i++) {
      const status = await f.status();
      if (status.kind === 'import') { assert.equal(status.label, 'Importing audio for Weekly sync'); imported = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(imported);
    upload.destroy();
    // Stop the queue before adding synthetic durable audio so the endpoint sees its queued state.
    await f.app.jobs!.close();
    await f.app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(16000 * 4));
    let status;
    for (let i = 0; i < 100; i++) {
      status = await f.status();
      if (status.kind === 'transcription') break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(status.kind, 'transcription');
    assert.equal(status.label, 'Transcribing audio for Weekly sync');
  } finally { upload?.destroy(); download.state = { state: 'idle' }; await f.close(); }
});

test('helper HTTP endpoint labels a recording and a replay', async () => {
  let now = Date.now();
  const f = await fixture({ clock: () => now, recognizer: { async transcribe() { throw new Error('not used'); }, close() {} } });
  try {
    await f.app.jobs!.close();
    const meeting = f.app.store.createMeeting('Weekly sync');
    const source = `mic:${randomUUID()}`;
    assert.equal((await f.call(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
      'X-Page': 'window', 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
    } })).status, 201);
    assert.deepEqual(await f.status(), { pageOpen: true, working: true, kind: 'recording', title: 'Weekly sync', label: 'Finishing the recording for Weekly sync' });
    await f.call('/api/bye?page=window', { method: 'POST' });
    assert.equal((await f.status()).pageOpen, false);
    const replay = f.app.store.createMeeting('Replay fixture');
    const chunk = await f.app.store.addPcm(replay.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(16000 * 4));
    f.app.store.completeChunk(chunk.id, { text: 'Synthetic transcript.', words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    f.app.store.startReplay(replay.id, 'mic:fixture', 1, now);
    assert.equal((await f.status()).label, 'Finishing the replay for Replay fixture');
    now += 2000;
    assert.notEqual((await f.status()).kind, 'replay');
  } finally { await f.close(); }
});

test('helper HTTP endpoint labels a glossary build', async () => {
  const materials = await mkdtemp(join(tmpdir(), 'hearalong-helper-materials-'));
  const f = await fixture({ heavy: async (_prompt, options) => new Promise((_, reject) => {
    const stop = () => reject(new Error('fixture stopped'));
    if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
  }) });
  try {
    const meeting = f.app.store.createMeeting('Weekly sync');
    const path = `/api/meetings/${meeting.id}`;
    assert.equal((await f.call(path + '/materials', { method: 'POST', body: JSON.stringify({ path: materials }) })).status, 201);
    assert.equal((await f.call(path + '/glossary/build', { method: 'POST', body: '{}' })).status, 202);
    assert.deepEqual(await f.status(), { pageOpen: false, working: true, label: 'Building the glossary for Weekly sync', kind: 'glossary', title: 'Weekly sync' });
  } finally { await f.close(); await rm(materials, { recursive: true, force: true }); }
});

test('helper HTTP endpoint expires silent pages even without idle-exit enabled', async t => {
  const f = await fixture();
  const dateNow = Date.now;
  let now = dateNow();
  const mock = t.mock.method(Date, 'now', () => now);
  try {
    await f.call('/api/status', { headers: { 'X-Page': 'silent-window' } });
    assert.equal((await f.status()).pageOpen, true);
    now += 180_001;
    assert.equal((await f.status()).pageOpen, false);
  } finally { mock.mock.restore(); await f.close(); }
});

test('interrupted notes can actually be written again through the Notes tab API after restart', async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture({ notes: async ({ signal }) => {
    began();
    return new Promise((_, reject) => {
      const stop = () => reject(new Error('stopped'));
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
  } });
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const meeting = f.app.store.createMeeting('Weekly sync');
    const chunk = await f.app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(16000 * 4));
    f.app.store.completeChunk(chunk.id, { text: 'Keep the painted lanterns on the rack until the parade.', words: [], backend: 'fixture', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    const path = `/api/meetings/${meeting.id}/notes`;
    assert.equal((await f.call(path, { method: 'POST', body: '{}' })).status, 202);
    await started;
    assert.equal((await f.status()).label, 'Writing notes for Weekly sync');
    await f.app.close();
    restarted = await fixture({ notes: async () => ({ text: JSON.stringify({ summary: [{ text: 'Keep the lanterns on the rack.', cites: ['S1'], quote: 'Keep the painted lanterns on the rack' }] }), model: 'fixture' }) }, f.directory);
    assert.equal((await (await restarted.call(path)).json()).job.state, 'interrupted');
    assert.equal((await restarted.call(path, { method: 'POST', body: '{}' })).status, 202);
    let saved;
    for (let i = 0; i < 200; i++) {
      saved = await (await restarted.call(path)).json();
      // Publication precedes job-file removal and release of busy(); wait for cleanup, not just the saved document.
      if (saved.notes && !saved.job) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(saved.notes?.version, 1);
    assert.equal(saved.job, null);
    assert.equal((await restarted.status()).working, false);
  } finally { await restarted?.close(); await f.close(); }
});
