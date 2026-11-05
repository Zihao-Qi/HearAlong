import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { audioSpans, referenceBlock, EchoProcessor } from '../src/echo-timeline.ts';
import { LiveEcho } from '../src/echo-audio.ts';
import { LiveCapture } from '../src/live.ts';
import { MeetingStore } from '../src/store.ts';
import type { LiveDrafts } from '../src/drafts.ts';

const pcm = (value = 0.1, samples = 16000) => Buffer.from(new Float32Array(samples).fill(value).buffer);
const audio = (wallMs: number, value = 0.1, samples = 16000) => ({ pcm: new Float32Array(samples).fill(value), timing: { captureWallMs: wallMs } });
const workerScript = new URL('./fixtures/echo-worker.ts', import.meta.url);
const mic = 'mic:00000000-0000-0000-0000-000000000001', call = 'tab:00000000-0000-0000-0000-000000000002';

test('wall-clock alignment is per frame: reference early/late, lead, drift, out-of-order spans', () => {
  const spans = [...audioSpans(audio(2001, 0.2)), ...audioSpans(audio(1000, 0.1))].sort((a, b) => a.wallMs - b.wallMs);
  assert.ok(Math.abs(referenceBlock(spans, 1990, 160).pcm[0] - 0.1) < 1e-7);
  assert.equal(referenceBlock(spans, 2000, 160).missing, 16, '1 ms clock drift is not compressed away');
  assert.ok(Math.abs(referenceBlock(spans, 2001, 160).pcm[0] - 0.2) < 1e-7);
  assert.equal(referenceBlock(audioSpans(audio(1100), 100), 1000, 160).missing, 0, 'lead corrects a late timestamp');
  assert.equal(referenceBlock(audioSpans(audio(1100)), 1000, 160).missing, 160);
  assert.equal(referenceBlock(audioSpans(audio(900)), 1000, 160).missing, 0, 'early reference covers capture');
});

test('wall-clock discontinuities inside a frame leave a real gap, not compressed reference audio', () => {
  const spans = audioSpans({ ...audio(1000), timing: { captureWallMs: 1000, discontinuities: [{ offsetSamples: 8000, fromWallMs: 1500, toWallMs: 11500 }] } });
  assert.deepEqual(spans.map(span => [span.wallMs, span.pcm.length]), [[1000, 8000], [11500, 8000]]);
  assert.equal(referenceBlock(spans, 2000, 160).missing, 160);
  assert.equal(referenceBlock(spans, 11500, 160).missing, 0);
});

test('no call or no shared wall clock is synchronous pass-through with no worker', async () => {
  const echo = new LiveEcho();
  try {
    assert.equal(echo.microphone('m', mic, '1', pcm(), { captureWallMs: 1000 }), null);
    echo.reference('m', call, pcm());
    assert.equal(echo.microphone('m', mic, '2', pcm(), { captureWallMs: 1000 }), null);
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    assert.equal(echo.microphone('m', mic, '3', pcm()), null);
    assert.equal(echo.stats().frames, 0);
  } finally { await echo.close(); }
});

test('reference arrival unblocks capture, including cross-source out-of-order arrival', async () => {
  const echo = new LiveEcho({ leadMs: 0, waitMs: 500, deadlineMs: 2000 });
  try {
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    let resolved = false;
    const pending = echo.microphone('m', mic, '1', pcm(), { captureWallMs: 2000 })!.then(value => { resolved = true; return value; });
    await delay(100);
    assert.equal(resolved, false, 'do not process beyond arrived reference');
    echo.reference('m', call, pcm(0.2), { captureWallMs: 2000 });
    const cleaned = await pending;
    assert.equal(cleaned.length, pcm().length);
    assert.equal(echo.stats().missingSamples, 0);
  } finally { await echo.close(); }
});

test('missing reference times out and passes through exactly; late data cannot rewrite emitted audio', async () => {
  const echo = new LiveEcho({ leadMs: 0, waitMs: 80, deadlineMs: 2000 });
  try {
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    const raw = pcm(0.123), start = performance.now();
    const cleaned = await echo.microphone('m', mic, '1', raw, { captureWallMs: 3000 });
    assert.ok(cleaned!.equals(raw));
    assert.ok(performance.now() - start >= 70);
    echo.reference('m', call, pcm(), { captureWallMs: 3000 });
    assert.ok(cleaned!.equals(raw));
    assert.equal(echo.stats().missingSamples, 16000);
  } finally { await echo.close(); }
});

test('call ending flushes pending raw immediately and stops AEC while mic continues', async () => {
  const echo = new LiveEcho({ leadMs: 0, waitMs: 1500 });
  try {
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    const raw = pcm(), pending = echo.microphone('m', mic, '1', raw, { captureWallMs: 3000 });
    const start = performance.now();
    await echo.end('m', call);
    assert.ok((await pending)!.equals(raw));
    assert.ok(performance.now() - start < 1400, 'end flush does not wait the reference timeout');
    assert.equal(echo.microphone('m', mic, '2', raw, { captureWallMs: 4000 }), null);
    assert.equal(echo.stats().frames, 1, 'completed stats survive worker retirement');
  } finally { await echo.close(); }
});

for (const leadMs of [299, 298]) test(`worker ${leadMs === 299 ? 'failure' : 'stall'} is bounded, logs once and disables AEC for the recording`, async () => {
  const logs: string[] = [], echo = new LiveEcho({ workerScript, leadMs, deadlineMs: 150, log: line => logs.push(line) });
  try {
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    const raw = pcm(), results = await Promise.all([echo.microphone('m', mic, 'a', raw, { captureWallMs: 1000 }), echo.microphone('m', mic, 'b', raw, { captureWallMs: 2000 })]);
    assert.ok(results.every(result => result!.equals(raw)));
    assert.equal(echo.microphone('m', mic, 'c', raw, { captureWallMs: 3000 }), null);
    assert.equal(logs.length, 1);
  } finally { await echo.close(); }
});

test('durable raw/dedup is unchanged, but previews and seal use cleaned PCM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-live-')), store = new MeetingStore(directory);
  const meeting = store.createMeeting(), feeds: Float32Array[] = [], sealed: string[] = [];
  const drafts = { begin: () => true, feed: (_window: string, data: Float32Array) => feeds.push(data),
    seal: (window: string) => sealed.push(window), release() {}, drop() {} } as unknown as LiveDrafts;
  const live = new LiveCapture(store, { drafts, echo: { workerScript, leadMs: 0 } });
  try {
    await live.accept(meeting.id, call, 0, 0, pcm(0.2), undefined, { captureWallMs: 1000 });
    const raw = pcm(0.4), frame = await live.accept(meeting.id, mic, 0, 0, raw, undefined, { captureWallMs: 1000 });
    assert.ok((await readFile(store.resolvePath(frame.path))).equals(raw), 'acknowledged durable file is still raw');
    await live.accept(meeting.id, mic, 0, 0, raw, undefined, { captureWallMs: 1000 });
    await live.end(meeting.id, mic, 0);
    const chunk = store.chunks(meeting.id).find(chunk => chunk.source === mic)!;
    assert.ok((await readFile(store.resolvePath(chunk.path))).equals(pcm(0.2)), 'chunk contains cleaned audio');
    assert.equal(frame.hash, createHash('sha256').update(raw).digest('hex'));
    assert.equal(chunk.hash, createHash('sha256').update(pcm(0.2)).digest('hex'));
    assert.equal(feeds.length, 2, 'one call feed and one cleaned mic feed, never a duplicate');
    assert.ok(Math.abs(feeds[1][0] - 0.2) < 1e-7);
    assert.equal(live.echoStats()!.frames, 1);
    assert.equal(sealed.length, 1);
    await assert.rejects(readFile(store.resolvePath(frame.path)), { code: 'ENOENT' });
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recovered frames seal raw, even when new call frames create an AEC session after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-recovery-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const raw = pcm(0.4);
  await store.addFrame(meeting.id, mic, 0, 0, raw, { captureWallMs: 1000 });
  const live = new LiveCapture(store, { echo: { workerScript, leadMs: 0 } });
  try {
    await live.accept(meeting.id, call, 0, 0, pcm(0.2), undefined, { captureWallMs: 1000 });
    await live.accept(meeting.id, mic, 1, 1000, raw, undefined, { captureWallMs: 2000 });
    await live.end(meeting.id, mic, 1);
    const chunk = store.chunks(meeting.id).find(chunk => chunk.source === mic)!;
    assert.ok((await readFile(store.resolvePath(chunk.path))).equals(Buffer.concat([raw, pcm(0.2)])));
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});


test('actual processor keeps both sides of an inside-frame sleep and sorts cross-source reference arrival', async () => {
  const module = await WebRtcAec3(), processor = new EchoProcessor(module, 0);
  const frame = { ...audio(1000), timing: { captureWallMs: 1000, discontinuities: [{ offsetSamples: 8000, fromWallMs: 1500, toWallMs: 11500 }] } };
  try {
    processor.reference(audio(12000));
    processor.reference(frame);
    assert.equal(processor.process(frame).missingSamples, 0, 'pre-sleep reference was not evicted by wall-clock pruning');
    assert.equal(processor.process(audio(12000)).missingSamples, 0);
  } finally { processor.close(); }
});

test('simultaneous mic/call Stop retires a worker once, without losing pending capture', async () => {
  const echo = new LiveEcho({ workerScript, leadMs: 0 });
  try {
    echo.reference('m', call, pcm(), { captureWallMs: 1000 });
    const pending = echo.microphone('m', mic, 'a', pcm(0.4), { captureWallMs: 1000 });
    await Promise.all([echo.end('m', call), echo.end('m', mic)]);
    assert.ok((await pending)!.equals(pcm(0.2)));
    assert.equal(echo.stats().frames, 1);
  } finally { await echo.close(); }
});

test('pause-cut preview replay uses cleaned remaining frames, and every cleaned sample seals once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-cut-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const feeds: { window: string; pcm: Buffer }[] = [];
  const drafts = { begin: () => true, feed: (window: string, data: Float32Array) => feeds.push({ window, pcm: Buffer.from(data.buffer) }), seal() {}, release() {}, drop() {} } as unknown as LiveDrafts;
  const live = new LiveCapture(store, { drafts, echo: { workerScript, leadMs: 0 } });
  const expected: Buffer[] = [];
  try {
    await live.accept(meeting.id, call, 0, 0, pcm(0.2), undefined, { captureWallMs: 1000 });
    for (let n = 0; n < 25; n++) {
      const data = new Float32Array(16000).fill(0.4); data[8000] += n / 1000;
      if (n === 20) { data.fill(0, 0, 1600); data.fill(0, 14400); }
      expected.push(Buffer.from(data.map(value => value / 2).buffer));
      await live.accept(meeting.id, mic, n, n * 1000, Buffer.from(data.buffer), undefined, { captureWallMs: 1000 + n * 1000 });
    }
    await live.end(meeting.id, mic, 24);
    const chunks = store.chunks(meeting.id).filter(chunk => chunk.source === mic);
    assert.deepEqual(chunks.map(chunk => chunk.sequence), [0, 21]);
    const replay = feeds.filter(feed => feed.window === `${mic}:21`);
    assert.ok(replay[0].pcm.equals(expected[21]), 'new preview replays the cleaned frame, not the raw file');
    assert.ok(Buffer.concat(await Promise.all(chunks.map(chunk => readFile(store.resolvePath(chunk.path))))).equals(Buffer.concat(expected)));
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a stuck worker cannot block a seal: unprocessed tail seals raw and logs once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-seal-fallback-')), store = new MeetingStore(directory), meeting = store.createMeeting(), logs: string[] = [];
  const live = new LiveCapture(store, { echo: { workerScript, leadMs: 298, deadlineMs: 100 }, log: line => logs.push(line) });
  try {
    await live.accept(meeting.id, call, 0, 0, pcm(), undefined, { captureWallMs: 1000 });
    const raw = pcm(0.4);
    await live.accept(meeting.id, mic, 0, 0, raw, undefined, { captureWallMs: 1000 });
    await live.accept(meeting.id, mic, 1, 1000, raw, undefined, { captureWallMs: 2000 });
    const start = performance.now();
    await live.end(meeting.id, mic, 1);
    assert.ok(performance.now() - start < 2000);
    const chunk = store.chunks(meeting.id).find(chunk => chunk.source === mic)!;
    assert.ok((await readFile(store.resolvePath(chunk.path))).equals(Buffer.concat([raw, raw])));
    assert.equal(logs.length, 1);
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
