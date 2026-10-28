import '../scripts/check-isolation.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../src/server.ts';
import { runBinary } from '../src/audio.ts';
import { dashboardSetup } from './helpers/dashboard-setup.ts';

const pcm = (seconds: number, value: number, rate = 16000) => Buffer.from(new Float32Array(seconds * rate).fill(value).buffer);
const recognition = { text: 'Fictional audio.', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' as const };

test('listen WAV endpoint with fictional multi-source audio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'listen-test-'));
  const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true), recognizer: null, drafts: null, quick: null, heavy: null });
  try {
    const m = app.store.createMeeting('Fictional tones');
    for (const [source, seq, start, seconds, value] of [
      ['mic:fiction', 0, 0, 2, .125], ['tab:fiction', 0, 1000, 2, .25],
      ['mic:fiction', 1, 1000, 2, .125], ['mic:fiction', 2, 4000, 1, .5],
    ] as const) {
      const c = await app.store.addPcm(m.id, source, seq, start, 16000, pcm(seconds, value));
      app.store.completeChunk(c.id, recognition);
    }
    // Saved but not yet sealed: this is not active capture, only persisted evidence.
    await app.store.addFrame(m.id, 'mic:held', 0, 6000, pcm(1, .25));
    const root = await fetch(app.url, { redirect: 'manual' });
    const headers = { Cookie: root.headers.get('set-cookie')!.split(';')[0] };
    const url = `${app.url}/api/meetings/${m.id}/audio`;
    const get = (range?: string) => fetch(url, { headers: { ...headers, ...(range ? { Range: range } : {}) } });
    let wav = Buffer.alloc(0);
    await t.test('WAV header and timeline length', async () => {
      const r = await get(); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/wav');
      wav = Buffer.from(await r.arrayBuffer());
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt32LE(4), wav.length - 8); assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.readUInt32LE(40), 7 * 32000); assert.equal(wav.length, 44 + 7 * 32000);
    });
    const sample = async (at: number) => { const r = await get(`bytes=${44 + at * 32000}-${45 + at * 32000}`); assert.equal(r.status, 206); return Buffer.from(await r.arrayBuffer()).readInt16LE(); };
    await t.test('mix and same-source overlapping windows do not double audio', async () => { assert.equal(await sample(1.5), Math.round(.375 * 32767)); });
    await t.test('silence in a gap', async () => { assert.equal(await sample(3.5), 0); });
    await t.test('unsealed frames included', async () => { assert.equal(await sample(6.5), Math.round(.25 * 32767)); });
    for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=32045-64048', 32045, 64048], ['bytes=224040-', 224040, 224043], ['bytes=-9', 224035, 224043]] as const) {
      await t.test(`byte-exact ${range}`, async () => { const r = await get(range); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/224044`); assert.deepEqual(Buffer.from(await r.arrayBuffer()), wav.subarray(start, end + 1)); });
    }
    for (const range of ['bytes=224044-', 'bytes=8-3', 'bytes=0-1,4-5', 'bytes=nope']) await t.test(`invalid range ${range}`, async () => { const r = await get(range); assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */224044'); });
    await t.test('imported media uses decodeStart and append offset', async () => {
      const path = join(directory, 'fictional.wav');
      await writeFile(path, await runBinary('ffmpeg', ['-v', 'error', '-f', 'f32le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-f', 'wav', 'pipe:1'], { input: Buffer.concat([pcm(20, .125), pcm(1, .5)]) }));
      const imported = app.store.createMeeting('Imported fiction');
      const prefix = await app.store.addPcm(imported.id, 'mic:prefix', 0, 0, 16000, pcm(1, 0)); app.store.completeChunk(prefix.id, recognition);
      app.store.addMedia(imported.id, path, 21);
      const importUrl = `${app.url}/api/meetings/${imported.id}/audio`;
      const r = await fetch(importUrl, { headers: { ...headers, Range: `bytes=${44 + 21.5 * 32000}-${45 + 21.5 * 32000}` } });
      assert.equal(r.status, 206); assert.ok(Math.abs(Buffer.from(await r.arrayBuffer()).readInt16LE() - 16384) <= 2);
      const full = Buffer.from(await (await fetch(importUrl, { headers })).arrayBuffer());
      const slice = await fetch(importUrl, { headers: { ...headers, Range: 'bytes=640037-672001' } });
      assert.deepEqual(Buffer.from(await slice.arrayBuffer()), full.subarray(640037, 672002));
    });
    await t.test('deleted setting survives in 410', async () => {
      app.store.db.prepare('UPDATE meetings SET audioRemovedAt=1, audioRemovedAfter=? WHERE id=?').run('1 week', m.id);
      const r = await get(); assert.equal(r.status, 410); assert.deepEqual(await r.json(), { code: 'audio_gone', after: '1 week' });
      app.store.db.prepare('UPDATE meetings SET audioRemovedAt=NULL WHERE id=?').run(m.id);
    });
    await t.test('missing file is gone, empty meeting has no audio', async () => {
      await rm(app.store.resolvePath(app.store.chunks(m.id)[0].path)); assert.equal((await get()).status, 410);
      const empty = app.store.createMeeting('Empty fiction'); const r = await fetch(`${app.url}/api/meetings/${empty.id}/audio`, { headers });
      assert.equal(r.status, 404); assert.equal((await r.json()).code, 'audio_empty');
    });
    await t.test('authentication and exact host required', async () => {
      assert.equal((await fetch(url)).status, 403);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url, { headers: { ...headers, Host: 'localhost' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
      });
      assert.equal(status, 403);
    });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
