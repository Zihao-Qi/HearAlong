import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startServer } from '../src/server.ts';
import { LocalRecognizer } from '../src/recognizer.ts';
import { LiveDrafts } from '../src/drafts.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Recording did not settle.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('record, preview, transcribe and listen without FFmpeg; imports alone require it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-no-ffmpeg-'));
  const previous = { MEETING_FFMPEG: process.env.MEETING_FFMPEG, MEETING_FFPROBE: process.env.MEETING_FFPROBE };
  const stub = join(directory, 'no-decoder'), log = join(directory, 'decoder-calls');
  await writeFile(stub, `#!/bin/sh\necho called >> '${log.replaceAll("'", "'\\''")}'\nexit 91\n`, { mode: 0o700 });
  process.env.MEETING_FFMPEG = stub; process.env.MEETING_FFPROBE = stub;
  const setup = await dashboardSetup(directory, true);
  setup.ffmpeg = async () => ({ found: false, error: 'Fictional missing decoders.' });
  const recognizer = new LocalRecognizer('/fictional/model', new URL('./fixtures/recording-worker.ts', import.meta.url));
  const drafts = new LiveDrafts({ modelPath: '/fictional/model', workerScript: new URL('./fixtures/fake-stream-worker.ts', import.meta.url) });
  const app = await startServer({ directory, port: 0, setup, recognizer, drafts, quick: null, heavy: null, actions: null, board: null });
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  const root = await fetch(app.url, { redirect: 'manual' });
  const Cookie = root.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, options: RequestInit = {}) => fetch(`${app.url}${path}`, { ...options, headers: { Cookie, Origin: app.url, ...options.headers } });
  await t.test('speech is ready and the returning user reaches the dashboard', async () => {
    assert.equal(root.status, 200);
    const status = await (await request('/api/setup')).json();
    assert.equal(status.rows.find((row: any) => row.id === 'speech').state, 'ready');
    assert.deepEqual(status.rows.filter((row: any) => row.id === 'ffmpeg').map((row: any) => [row.needed, row.state]), [[false, 'missing']]);
  });
  const meeting = app.store.createMeeting('Fictional meeting'), source = `mic:${randomUUID()}`;
  for (const [sequence, samples] of [16000, 4000].entries()) {
    const response = await request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', headers: {
      'X-Audio-Source': source, 'X-Sequence': String(sequence), 'X-Sample-Rate': '16000', 'X-Start-Ms': String(sequence * 1000),
    }, body: Buffer.from(new Float32Array(samples).fill(.125).buffer) });
    assert.equal(response.status, 201, await response.text());
  }
  await until(() => drafts.drafts(meeting.id).some(draft => draft.text.includes('w0.125')));
  const ended = await request(`/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, lastSequence: 1 }) });
  assert.equal(ended.status, 200);
  await until(() => app.store.chunks(meeting.id).some(chunk => chunk.status === 'completed' || chunk.error));
  const chunk = app.store.chunks(meeting.id)[0];
  assert.equal(chunk.status, 'completed', chunk.error ?? '');
  assert.equal(chunk.text, 'Fictional meeting recorded.');
  assert.equal(JSON.parse(chunk.metrics!).audioSeconds, 1.25);
  const response = await request(`/api/meetings/${meeting.id}/audio`);
  assert.equal(response.status, 200);
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.length, 44 + 20000 * 2);
  assert.equal(wav.readInt16LE(44), Math.round(.125 * 32767));
  await t.test('playback ignores a trailing partial sample, as on a file still being appended to', async () => {
    const path = app.store.resolvePath(chunk.path);
    const original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from([1])]));
      const partial = await request(`/api/meetings/${meeting.id}/audio`);
      assert.equal(partial.status, 200);
      const body = Buffer.from(await partial.arrayBuffer());
      assert.equal(body.length, 44 + 20000 * 2);
      assert.equal(body.readInt16LE(44), Math.round(.125 * 32767));
    } finally { await writeFile(path, original); }
  });
  await t.test('import is refused with an actionable message before calling a decoder', async () => {
    const imported = await request(`/api/meetings/${meeting.id}/upload`, { method: 'POST', body: Buffer.from('fictional media') });
    assert.equal(imported.status, 400);
    assert.match((await imported.json()).error, /importing audio\/video files needs FFmpeg/i);
  });
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '', 'recordings and refused imports must not invoke either decoder');
});

test('setup open button and Speech badge ignore the optional missing FFmpeg row', async () => {
  const setup = await readFile(new URL('../public/setup.js', import.meta.url), 'utf8');
  const open = { disabled: true };
  const callback = setup.slice(setup.indexOf('onStatus(status) {') + 'onStatus(status) {'.length, setup.indexOf('\n  },'));
  runInNewContext(`(status => {${callback}})(status)`, { open, status: { rows: [{ id: 'speech', state: 'ready' }, { id: 'ffmpeg', state: 'missing' }] } });
  assert.equal(open.disabled, false);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // Evaluate the production badge expression; no browser or page initialization.
  const badge = app.slice(app.indexOf('  const speechReady ='), app.indexOf('  // Nothing to show when all is well:'));
  for (const [speech, expected] of [[{ state: 'ready' }, ''], [{ state: 'missing' }, 'Speech off'], [{ state: 'ready', pending: {} }, 'Speech off']] as const) {
    const result = runInNewContext(`${badge}\nword`, { speech, failed: 0, capture: null, status: { config: { available: true }, capabilities: { cloudModels: false } }, setupSnapshot: { rows: [{ id: 'ffmpeg', state: 'missing' }] } });
    assert.equal(result, expected);
  }
});
