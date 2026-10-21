import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { randomUUID } from 'node:crypto';

test('deleting a watched meeting prunes server state without breaking later board ticks', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-delete-watched-'));
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./helpers/delete-watched-meeting.ts', import.meta.url)), directory],
    { env: { ...process.env, MEETING_CLOUD: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    assert.equal(await exited, 0, output);
    assert.match(output, /PASS: real board ticks prune deleted IDs/);
  } finally {
    clearTimeout(watchdog); child.kill('SIGKILL'); await exited.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('deletion prunes an abandoned capture from global live/status readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-delete-abandoned-'));
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts: null, recognizer: {
    async transcribe() { return { text: 'Saved transcript.', backend: 'test', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' }; }, close() {},
  } });
  try {
    const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init,
      headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...init.headers } });
    const meeting = app.store.createMeeting('Abandoned then deleted'), source = `mic:${randomUUID()}`;
    assert.equal((await request(`/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(16000 * 4), headers: {
      'X-Page': 'departing-page', 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0',
    } })).status, 201);
    assert.equal((await request('/api/bye?page=departing-page', { method: 'POST', body: '{}' })).status, 204);
    await app.jobs!.wait();
    assert.equal(app.store.recordingUnended(meeting.id), false);
    app.store.deleteMeeting(meeting.id);
    const response = await request('/api/live');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).recording, null);
    assert.equal((await (await request('/api/live/window')).json()).show, false);
    assert.equal((await (await request('/api/status')).json()).recording, false);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
