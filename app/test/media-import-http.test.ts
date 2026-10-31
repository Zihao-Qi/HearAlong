import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';
import type { Chunk } from '../src/store.ts';

function gate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'media-import-http-'));
  const oldProbe = process.env.MEETING_FFPROBE;
  const probe = join(directory, 'fictional-ffprobe.cjs');
  const probeLog = join(directory, 'probe-args.json');
  await writeFile(probe, `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.argv.at(-1)));
`, { mode: 0o700 });
  process.env.MEETING_FFPROBE = probe;
  const release = gate(), entered = gate();
  const calls: Chunk[] = [];
  const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory),
    quick: null, heavy: null, notes: null, actions: null, board: null, plans: null, drafts: null,
    recognizer: { available: () => true, async transcribe(chunk) {
      calls.push(chunk); entered.open(); await release.ready;
      assert.ok((await readFile(chunk.path, 'utf8')).includes('duration'));
      return { text: `Fictional imported shell count ${chunk.sequence}.`, words: [], backend: 'fake', computeMs: 1, decodeMs: 1, audioSeconds: chunk.seconds, processRssBytes: 0, timestampKind: 'none' };
    }, close() { release.open(); } } });
  const page = await fetch(app.url);
  await page.text();
  const cookie = page.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, init: RequestInit = {}) => fetch(`${app.url}${path}`, { ...init,
    headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json', ...init.headers } });
  const response = await request('/api/meetings', { method: 'POST', body: JSON.stringify({ title: 'Fictional shell inventory import' }) });
  assert.equal(response.status, 201);
  const meeting = await response.json() as { id: string };
  const upload = (body: unknown) => request(`/api/meetings/${meeting.id}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: JSON.stringify(body) });
  return { directory, app, meeting, calls, release, entered, upload, request, probeLog,
    async close() {
      release.open();
      try { await app.close(); }
      finally {
        if (oldProbe === undefined) delete process.env.MEETING_FFPROBE; else process.env.MEETING_FFPROBE = oldProbe;
        await rm(directory, { recursive: true, force: true });
      }
    } };
}

test('HTTP media import probes the saved synthetic file, saves exact chunk windows, schedules recognition and returns the source', async () => {
  const f = await fixture();
  try {
    const media = { streams: [{ codec_type: 'audio' }], format: { duration: '45.25' } };
    const response = await f.upload(media);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.source, /^file:[\w-]+$/);
    assert.deepEqual(body, { source: body.source, duration: 45.25, chunkSeconds: 20 });
    await f.entered.ready;
    const chunks = f.app.store.chunks(f.meeting.id);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map(c => [c.source, c.sequence, c.decodeStart, c.startMs, c.seconds, c.sampleRate]), [
      [body.source, 0, 0, 0, 20, null], [body.source, 1, 20, 20000, 20, null], [body.source, 2, 40, 40000, 5.25, null],
    ]);
    assert.deepEqual(chunks.map(c => c.status), ['running', 'queued', 'queued']);
    assert.equal(f.app.store.queuedCount(), 3);
    const files = await readdir(join(f.directory, 'imports'));
    assert.equal(files.length, 1);
    const path = join(f.directory, 'imports', files[0]);
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(media));
    assert.ok(chunks.every(c => f.app.store.resolvePath(c.path) === path));
    const args = JSON.parse(await readFile(f.probeLog, 'utf8'));
    assert.deepEqual(args, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path]);
    f.release.open();
    await f.app.jobs.wait();
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.map(c => c.sequence), [0, 1, 2]);
    assert.ok(f.app.store.chunks(f.meeting.id).every(c => c.status === 'completed'));
    assert.equal(f.app.store.queuedCount(), 0);
    const segments = await f.request(`/api/meetings/${f.meeting.id}/segments`);
    assert.equal(segments.status, 200);
    assert.match(JSON.stringify(await segments.json()), /Fictional imported shell count 2/);
  } finally { await f.close(); }
});

test('HTTP media import refuses no audio, invalid, nonpositive and over-eight-hour durations without queued work or orphan files', async () => {
  const f = await fixture();
  try {
    const cases = [
      { streams: [], format: { duration: '1' } },
      { streams: [{ codec_type: 'audio' }], format: {} },
      ...['not-a-duration', 'Infinity', '0', '-1', String(8 * 3600 + 0.01)].map(duration => ({ streams: [{ codec_type: 'audio' }], format: { duration } })),
    ];
    for (const media of cases) {
      const response = await f.upload(media);
      assert.equal(response.status, 400, JSON.stringify(media));
      assert.match((await response.json()).error, /audio track and a known duration between 0 and 8 hours/);
      await f.app.jobs.wait();
      assert.deepEqual(f.app.store.chunks(f.meeting.id), []);
      assert.equal(f.app.store.queuedCount(), 0);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(await readdir(join(f.directory, 'imports')), []);
      assert.deepEqual(f.app.busy(f.meeting.id), []);
    }
  } finally { await f.close(); }
});
