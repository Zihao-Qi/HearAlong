import '../scripts/check-isolation.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type ClientRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serveMeetingAudio } from '../src/listen.ts';
import type { MeetingStore } from '../src/store.ts';

const meeting = { audioRemovedAt: null, audioRemovedAfter: null, audioEmpty: 0 };
function fictionalWav(seconds: number) {
  const b = Buffer.alloc(44 + seconds * 32000);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let i = 0; i < seconds * 16000; i++) b.writeInt16LE(4096 * (1 + Math.floor(i / 320000)), 44 + i * 2);
  return b;
}

test('import playback shares bounded original-window decodes and limits decoder concurrency', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'listen-import-fix-'));
  const previous = process.env.MEETING_FFMPEG;
  const log = join(directory, 'decoders.jsonl'), worker = join(directory, 'decoder.cjs'), shim = join(directory, 'ffmpeg-shim');
  await writeFile(log, '');
  // Instrument real FFmpeg, with a short delay so concurrent requests deterministically overlap.
  await writeFile(worker, `const {spawn}=require('node:child_process'); const {appendFileSync}=require('node:fs');
const log=${JSON.stringify(log)}; const record=event=>appendFileSync(log,JSON.stringify({event,pid:process.pid})+'\\n');
record('start'); setTimeout(()=>{ const c=spawn('ffmpeg',process.argv.slice(2),{stdio:'inherit'});
c.on('error',()=>{record('end');process.exit(1)});c.on('exit',code=>{record('end');process.exit(code??1)}); },100);
`);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await writeFile(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(worker)} "$@"\n`, { mode: 0o700 });
  process.env.MEETING_FFMPEG = shim;
  const fixture = join(directory, 'fictional.wav'); await writeFile(fixture, fictionalWav(120));
  const chunks = Array.from({ length: 6 }, (_, i) => ({ id: `import-${i}`, source: 'file:fiction', path: fixture, startMs: i * 20000, seconds: 20, sampleRate: null, decodeStart: i * 20 }));
  const store = { meeting: () => meeting, chunks: () => chunks, heldFrames: () => [], audioEndMs: () => 120000, resolvePath: (p: string) => p } as unknown as MeetingStore;
  const server = createServer((req, res) => { void serveMeetingAudio(req, res, store, 'fictional', false, false); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/audio`;
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s) as { event: string; pid: number });
  try {
    await t.test('two-minute traversal starts one decoder per original 20-second window', async () => {
      const response = await fetch(url); assert.equal(response.status, 200);
      const wav = Buffer.from(await response.arrayBuffer()); assert.equal(wav.length, 44 + 120 * 32000);
      for (let i = 0; i < 6; i++) assert.ok(Math.abs(wav.readInt16LE(44 + (i * 20 + 10) * 32000) - 4096 * (i + 1)) <= 1);
      const count = (await events()).filter(e => e.event === 'start').length;
      console.log(`single traversal decoder starts: ${count}`); assert.equal(count, 6);
    });
    await t.test('two overlapping traversals share in-flight decodes', async () => {
      // A new immutable file makes this a cold-cache measurement independent of the previous traversal.
      const path = join(directory, 'fictional-overlap.wav'); await writeFile(path, fictionalWav(120)); chunks.forEach(c => { c.path = path; });
      const before = (await events()).filter(e => e.event === 'start').length;
      const responses = await Promise.all([fetch(url), fetch(url)]);
      const [a, b] = await Promise.all(responses.map(async r => { assert.equal(r.status, 200); return Buffer.from(await r.arrayBuffer()); }));
      assert.deepEqual(a, b); assert.equal(a.length, 44 + 120 * 32000);
      const count = (await events()).filter(e => e.event === 'start').length - before;
      console.log(`overlapping traversals decoder starts: ${count}`); assert.equal(count, 6);
    });
    await t.test('four simultaneous cold seeks never run more than two decoders', async () => {
      const path = join(directory, 'fictional-seeks.wav'); await writeFile(path, fictionalWav(120)); chunks.forEach(c => { c.path = path; });
      const before = (await events()).length;
      await Promise.all([0, 1, 2, 3].map(async i => {
        const from = 44 + i * 20 * 32000;
        const r = await fetch(url, { headers: { Range: `bytes=${from}-${from + 31999}` } }); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 32000);
      }));
      let active = 0, peak = 0; for (const event of (await events()).slice(before)) { active += event.event === 'start' ? 1 : -1; peak = Math.max(peak, active); }
      console.log(`simultaneous decoders: ${peak}`); assert.ok(peak <= 2, `peak=${peak}`); assert.equal(active, 0);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MEETING_FFMPEG; else process.env.MEETING_FFMPEG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('disconnect during preflight settles promptly without reading the remaining windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'listen-cancel-fix-'));
  const raw = join(directory, 'fictional.f32'); await writeFile(raw, Buffer.from(new Float32Array(16000).fill(.125).buffer));
  const windows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), source: `mic:${String(i).padStart(3, '0')}`, path: `fictional-${i}`, startMs: 0, seconds: 1, sampleRate: 16000, decodeStart: 0 }));
  let resolutions = 0, closedAt = 0, settled = false, client: ClientRequest;
  const store = { meeting: () => meeting, chunks: () => windows, heldFrames: () => [], audioEndMs: () => 1000,
    resolvePath: () => { resolutions++; if (resolutions === 1) setImmediate(() => client.destroy()); return raw; } } as unknown as MeetingStore;
  const server = createServer((req, res) => {
    res.once('close', () => { closedAt = resolutions; });
    void serveMeetingAudio(req, res, store, 'fictional', false, false).finally(() => { settled = true; });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = request(`http://127.0.0.1:${(server.address() as { port: number }).port}/audio`); client.on('error', () => {}); client.end();
    const until = Date.now() + 1000;
    while (!settled && Date.now() < until) await delay(10);
    console.log(JSON.stringify({ probe: 'preflight disconnect', closedAt, resolutions, settled }));
    assert.ok(closedAt > 0 && closedAt < 100, 'disconnect happened during preflight');
    assert.equal(settled, true, 'handler must settle within one second'); assert.equal(resolutions, closedAt, 'no reads/resolutions after response close');
    await delay(30); assert.equal(resolutions, closedAt);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});
