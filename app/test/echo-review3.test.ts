import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveEcho } from '../src/echo-audio.ts';
import { EchoProcessor, referenceBlock } from '../src/echo-timeline.ts';
import { EchoScheduler } from '../src/echo-scheduler.ts';
import { delayedAec } from './fixtures/delayed-aec.ts';

const audio = (wall: number, samples = 16000) => ({ pcm: new Float32Array(samples), timing: { captureWallMs: wall } });
const raw = () => Buffer.from(new Float32Array(16000).fill(0.2).buffer);
const fake = new URL('./fixtures/echo-worker.ts', import.meta.url);

test('review3: worker-local -1 s UTC step cannot extend a reference wait or disable AEC', async () => {
  const logs: string[] = [], echo = new LiveEcho({ leadMs: 0, waitMs: 120, deadlineMs: 600,
    workerScript: new URL('./fixtures/echo-date-step-worker.ts', import.meta.url), log: line => logs.push(line) });
  try {
    echo.reference('m', 'app:call', raw(), { captureWallMs: 1000 });
    const start = performance.now();
    await echo.microphone('m', 'mic', 'a', raw(), { captureWallMs: 1500 });
    assert.ok(performance.now() - start < 550); assert.equal(echo.stats().failures, 0); assert.deepEqual(logs, []);
    echo.reference('m', 'app:call', raw(), { captureWallMs: 2000 });
    const next = echo.microphone('m', 'mic', 'b', raw(), { captureWallMs: 2000 });
    assert.ok(next, 'the recording still has an active canceller'); await echo.flush(); await next;
  } finally { await echo.close(); }
});

test('review3: watchdog with UTC far below monotonic elapsed is resumable, not a fatal recording disable', async () => {
  let wallOffset = 0;
  const logs: string[] = [], echo = new LiveEcho({ leadMs: 296, deadlineMs: 150, workerScript: fake,
    wallClock: () => Date.now() + wallOffset, log: line => logs.push(line) });
  try {
    echo.reference('m', 'app:call', raw(), { captureWallMs: 1000 });
    const stalled = echo.microphone('m', 'mic', 'stall', raw(), { captureWallMs: 1000 });
    wallOffset = -1000; assert.ok((await stalled)!.equals(raw()));
    echo.reference('m', 'app:call', raw(), { captureWallMs: 2000 });
    const resumed = echo.microphone('m', 'mic', 'resume', raw(), { captureWallMs: 2000 });
    assert.ok(resumed); await echo.flush();
    assert.ok(Math.abs((await resumed)!.readFloatLE(8000 * 4) - 0.1) < 1e-6);
    assert.equal(logs.length, 1); assert.equal(echo.stats().failures, 1);
  } finally { await echo.close(); }
});

test('review3: staleness/grace use injectable monotonic elapsed, independent of signed capture-wall steps', async () => {
  let now = 0;
  const echo = new LiveEcho({ leadMs: 0, workerScript: fake, clock: () => now });
  try {
    echo.reference('m', 'app:call', raw(), { captureWallMs: 100000 });
    const first = echo.microphone('m', 'mic', 'a', raw(), { captureWallMs: 100000 }); await echo.flush(); await first;
    now = 2000; echo.reference('m', 'app:call', raw(), { captureWallMs: 99000 });
    const next = echo.microphone('m', 'mic', 'b', raw(), { captureWallMs: 99000 }); assert.ok(next); await echo.flush(); await next;
    await echo.end('m', 'app:call');
    now = 11999; assert.equal(echo.buffered().referenceFrames, 1);
    now = 12001; assert.equal(echo.microphone('m', 'mic', 'late', raw(), { captureWallMs: 98000 }), null);
  } finally { await echo.close(); }
});

test('review3: backward reference step drops old high-water render and waits for NEW reference, not old same-wall samples', () => {
  const processor = new EchoProcessor(delayedAec().module, 100), scheduler = new EchoScheduler(processor, 1500);
  try {
    for (let second = 0; second < 5; second++) scheduler.reference(audio(10000 + second * 1000));
    assert.equal(processor.referenceEndMs, 14900);
    scheduler.reference(audio(11000));
    assert.equal(processor.referenceEndMs, 11900); assert.equal(processor.buffered().referenceFrames, 1);
    scheduler.admit('new', { pcm: rawFloats(), timing: { captureWallMs: 12000 } }, 100);
    scheduler.admit('next', audio(13000, 320), 100);
    assert.equal(scheduler.drain(100).length, 0); assert.equal(scheduler.buffered().pending, 2);
    scheduler.reference(audio(12000)); scheduler.reference(audio(13000));
    assert.equal(scheduler.drain(200)[0].missingSamples, 0);
    // A backward cut inside a reference frame also discards its pre-step prefix.
    scheduler.reference({ pcm: new Float32Array(16000), timing: { captureWallMs: 14000,
      discontinuities: [{ offsetSamples: 8000, fromWallMs: 14500, toWallMs: 10500 }] } });
    assert.equal(processor.referenceEndMs, 10900);
  } finally { processor.close(); }
});
const rawFloats = () => new Float32Array(16000).fill(0.2);

for (const jump of [10000, 30000]) test(`review3: pinned reference survives mic-first in-frame +${jump} ms boundary then call arrives 20 ms later`, async () => {
  let now = 0;
  const logs: string[] = [], echo = new LiveEcho({ leadMs: 0, clock: () => now, log: line => logs.push(line) });
  try {
    echo.reference('m', 'app:call', raw(), { captureWallMs: 100000 });
    echo.reference('m', 'app:call', raw(), { captureWallMs: 101000 });
    const first = echo.microphone('m', 'mic', 'a', raw(), { captureWallMs: 100000 }); await echo.flush(); await first;
    now = 2000;
    echo.reference('m', 'app:call', raw(), { captureWallMs: 102000 });
    // Monotonic time can include sleep: the already-pinned session gets ONE normal wait across the cut.
    now += jump;
    const timing = { captureWallMs: 102000, discontinuities: [{ offsetSamples: 8000, fromWallMs: 102500, toWallMs: 102500 + jump }] };
    const pending = echo.microphone('m', 'mic', 'boundary', raw(), timing);
    assert.ok(pending, 'whole-frame end is not mistaken for a stale reference');
    await delay(20); echo.reference('m', 'app:call', raw(), timing);
    await echo.flush(); await pending;
    assert.equal(echo.buffered().sessions, 1); assert.equal(echo.buffered().retiring, 0); assert.deepEqual(logs, []);
  } finally { await echo.close(); }
});

test('review3: resumed reference clears ended and waits for lookahead instead of resetting every frame', () => {
  const { module, counts } = delayedAec(), processor = new EchoProcessor(module, 100), scheduler = new EchoScheduler(processor, 1500);
  try {
    scheduler.reference(audio(1000)); scheduler.reference(audio(2000));
    scheduler.admit('first', audio(1000), 10); scheduler.drain(10); scheduler.referenceEnded();
    assert.equal(scheduler.drain(10).length, 1);
    scheduler.reference(audio(5000)); scheduler.admit('resumed', audio(5000), 50);
    const freed = counts.freed; assert.equal(scheduler.drain(50).length, 0); assert.equal(counts.freed, freed);
    assert.ok(scheduler.buffered().pending > 0);
    scheduler.reference(audio(6000)); scheduler.admit('next', audio(6000, 320), 100);
    assert.equal(scheduler.drain(100)[0].id, 'resumed');
  } finally { processor.close(); }
});

test('review3: 40 covered samples fade all the way to raw at sample 39, not a 0.55-to-1 jump', () => {
  const processor = new EchoProcessor(delayedAec(165, 0.1).module, 0), scheduler = new EchoScheduler(processor, 1500);
  try {
    scheduler.reference(audio(1000, 40));
    scheduler.admit('a', { pcm: new Float32Array(160).fill(1), timing: { captureWallMs: 1000 } }, 10);
    assert.equal(scheduler.drain(10).length, 0);
    const out = scheduler.drain(1600)[0].pcm;
    assert.equal(out[39], 1); assert.equal(out[40], 1);
    for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) < 0.02);
  } finally { processor.close(); }
});

test('review3: expiry checkpoints reset the kernel after preserving aligned samples and all tails', () => {
  const { module, counts } = delayedAec(), processor = new EchoProcessor(module, 0), scheduler = new EchoScheduler(processor, 1500);
  try {
    for (let n = 0; n < 10; n++) {
      scheduler.reference(audio(1000 + n * 1000));
      const pcm = Float32Array.from({ length: 16000 }, (_, i) => (i % 251) / 1024); pcm[15999] = 0.5;
      scheduler.admit(String(n), { pcm, timing: { captureWallMs: 1000 + n * 1000 } }, n * 2000);
      scheduler.drain(n * 2000);
      assert.deepEqual(scheduler.drain(n * 2000 + 1500)[0].pcm, pcm);
      assert.equal(counts.constructed, n + 2, 'calibration plus a fresh kernel for each timeout window');
      assert.equal(counts.freed, n + 2, 'the checkpoint drains every tail, then frees its kernel');
    }
    processor.resetReference(); assert.equal(counts.freed, 11, 'no retained kernel remains to free');
    assert.equal(referenceBlock([], 1000, 40).missing, 40);
  } finally { processor.close(); }
});
