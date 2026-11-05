import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { EchoProcessor, referenceBlock, audioSpans, processingDelay } from '../src/echo-timeline.ts';
import { LiveEcho } from '../src/echo-audio.ts';
import { EchoScheduler } from '../src/echo-scheduler.ts';
import { LiveCapture } from '../src/live.ts';
import { MeetingStore } from '../src/store.ts';
import { SampleCaptureClock } from '../public/capture-clock.js';
import { delayedAec } from './fixtures/delayed-aec.ts';

const frame = (wall: number, samples = 16000) => ({ pcm: new Float32Array(samples), timing: { captureWallMs: wall } });
const bytes = (pcm: Float32Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const zeros = () => Buffer.alloc(64000);
const equal = (a: Float32Array, b: Float32Array) => assert.ok(bytes(a).equals(bytes(b)), 'every input sample is present once, at its own position');
const MIC = 'mic:00000000-0000-0000-0000-000000000011', CALL = 'app:00000000-0000-0000-0000-000000000012';
const fake = new URL('./fixtures/echo-worker.ts', import.meta.url);

test('P1: known delayed kernel preserves every sample over clean/raw transitions, frame edges and Stop tail', () => {
  const { module } = delayedAec(), processor = new EchoProcessor(module, 0);
  try {
    assert.equal(processingDelay(module), 165);
    const input = Float32Array.from({ length: 48000 }, (_, i) => (i % 65521 + 1) / 65536);
    for (const at of [0, 1, 159, 160, 161, 15989, 15990, 15999, 16000, 16001, 31999, 32000, 47999]) input[at] = -0.75;
    processor.reference(frame(1000, 12000)); processor.reference(frame(2500, 20000));
    const output: Float32Array[] = [];
    for (let n = 0; n < 3; n++) {
      processor.push(String(n), { pcm: input.subarray(n * 16000, (n + 1) * 16000), timing: { captureWallMs: 1000 + n * 1000 } });
      output.push(...processor.takeReady().map(result => result.pcm));
    }
    processor.flush(); output.push(...processor.takeReady().map(result => result.pcm));
    assert.equal(output.length, 3);
    output.forEach((pcm, n) => equal(pcm, input.subarray(n * 16000, (n + 1) * 16000)));
  } finally { processor.close(); }
});

test('P1: actual WASM impulse peaks stay at every frame/block edge and the final ten samples survive flush', async () => {
  const module = await WebRtcAec3();
  for (const at of [0, 1, 159, 160, 161, 15989, 15990, 15999, 16000, 16001, 31999]) {
    const processor = new EchoProcessor(module, 0), input = new Float32Array(32000); input[at] = 0.5;
    try {
      processor.reference(frame(1000, 32000));
      processor.push('a', { pcm: input.subarray(0, 16000), timing: { captureWallMs: 1000 } });
      processor.push('b', { pcm: input.subarray(16000), timing: { captureWallMs: 2000 } });
      processor.flush();
      const results = processor.takeReady(), out = new Float32Array(32000);
      assert.equal(results.length, 2); out.set(results[0].pcm); out.set(results[1].pcm, 16000);
      let peak = 0; for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
      assert.equal(peak, at, `impulse at ${at} was not shifted, duplicated or discarded`);
      assert.ok(Math.abs(out[at]) > 0.1);
    } finally { processor.close(); }
  }
});

test('clean/raw crossfades blend aligned values over <=80 samples, not previous audio', () => {
  const { module } = delayedAec(165, 2), processor = new EchoProcessor(module, 0), input = new Float32Array(6400).fill(1);
  try {
    processor.reference(frame(1000, 6400)); processor.open('f', input);
    processor.append('f', 0, input.subarray(0, 3200), 1000);
    processor.append('f', 3200, input.subarray(3200, 4800), 1200, false);
    processor.append('f', 4800, input.subarray(4800), 1300);
    processor.flush(); const out = processor.takeReady()[0].pcm;
    assert.equal(out[79], 2); assert.equal(out[3119], 2); assert.equal(out[3199], 1);
    assert.equal(out[3200], 1); assert.equal(out[4799], 1); assert.equal(out[4879], 2);
    assert.equal(out[6399], 2, 'Stop flushes the actual cleaned tail, not a substituted raw tail');
    for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) <= 1 / 80 + 1e-6);
  } finally { processor.close(); }
});

test('a timeout checkpoint fades its emitted tail before a later raw span, not after the edge has already escaped', () => {
  const processor = new EchoProcessor(delayedAec(165, 2).module, 0), scheduler = new EchoScheduler(processor, 1500);
  try {
    scheduler.reference(frame(1000, 3200));
    scheduler.admit('a', { pcm: new Float32Array(3200).fill(1), timing: { captureWallMs: 1000 } }, 1200);
    assert.equal(scheduler.drain(1200).length, 0);
    const before = scheduler.drain(2700)[0].pcm;
    scheduler.referenceEnded();
    scheduler.admit('b', { pcm: new Float32Array(1600).fill(1), timing: { captureWallMs: 1200 } }, 2800);
    const after = scheduler.drain(2800)[0].pcm;
    assert.equal(before.at(-1), 1); assert.equal(after[0], 1);
    for (let i = before.length - 80; i < before.length; i++) assert.ok(Math.abs(before[i] - before[i - 1]) <= 1 / 80 + 1e-6);
  } finally { processor.close(); }
});

test('partial blocks carry across contiguous spans; sleep/reset flushes both sides at original sample offsets', () => {
  const { module, counts } = delayedAec(), processor = new EchoProcessor(module, 0);
  const input = Float32Array.from({ length: 777 }, (_, i) => (i + 1) / 1024);
  try {
    processor.reference(frame(1000, 1000)); processor.open('partial', input);
    let offset = 0;
    for (const count of [47, 113, 141, 19, 159, 1, 297]) {
      processor.append('partial', offset, input.subarray(offset, offset + count), 1000 + offset / 16); offset += count;
    }
    assert.equal(counts.constructed, 2, 'calibration + ONE continuous kernel, no partial-span padding/reset');
    processor.flush(); equal(processor.takeReady()[0].pcm, input);
    const timing = { captureWallMs: 2000, discontinuities: [{ offsetSamples: 159, fromWallMs: 2000 + 159 / 16, toWallMs: 12000 + 159 / 16 }] };
    processor.reference({ pcm: new Float32Array(input.length), timing });
    processor.push('sleep', { pcm: input, timing }); processor.flush();
    equal(processor.takeReady()[0].pcm, input);
    assert.deepEqual(processor.buffered(), { frames: 0, targets: 0, partialSamples: 0, referenceFrames: 2 });
  } finally { processor.close(); }
});

test('confirmed reference gaps <=5 ms are held; larger/unknown gaps remain missing', () => {
  for (const gap of [1 / 16, 1, 5, 5 + 1 / 16]) {
    const first = { ...frame(1000), pcm: new Float32Array(16000).fill(0.25) };
    const spans = [...audioSpans(first), ...audioSpans(frame(2000 + gap))];
    assert.equal(referenceBlock(spans, 1999, 160).missing === 0, gap <= 5);
    if (gap <= 5) assert.equal(referenceBlock(spans, 2000, 16).pcm[0], 0.25);
  }
  assert.equal(referenceBlock(audioSpans(frame(1000)), 2000, 16).missing, 16, 'never invent future reference');
});

test('page clock slews accumulated +/-200 ppm drift at frame boundaries, never makes a 100 ms step', () => {
  for (const ppm of [-200, 200]) {
    const clock = new SampleCaptureClock(); let previous = 0, origin = 0;
    for (let quantum = 0; quantum <= 125 * 900; quantum++) {
      const sample = quantum * 128, wall = 100000 + sample / 16 * (1 + ppm / 1e6);
      const time = clock.at(sample, 16000, wall, false);
      if (quantum % 125 === 0) {
        const next = clock.frame(sample, 16000, wall);
        if (quantum) assert.ok(Math.abs(next - previous - 1000) <= 2.000001, 'slew bounded per one-second frame');
        previous = next;
        assert.ok(Math.abs(next - wall) <= 5.3);
        assert.ok(Math.abs((next - sample / 16) - origin) <= 2.000001 || quantum === 0);
        origin = next - sample / 16;
      } else assert.ok(Number.isFinite(time));
    }
  }
});

test('stale and permanently lagging references do not wait; timing loss retires and timed resume reactivates', async () => {
  let now = 0; const logs: string[] = [], echo = new LiveEcho({ workerScript: fake, leadMs: 0, clock: () => now, log: line => logs.push(line) });
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 1000 });
    const pending = echo.microphone('m', MIC, 'a', zeros(), { captureWallMs: 1000 }); await echo.flush(MIC); await pending;
    now = 3001; const start = performance.now();
    const stale = echo.microphone('m', MIC, 'b', zeros(), { captureWallMs: 2000 }); if (stale) await stale;
    assert.ok(performance.now() - start < 500); assert.equal(logs.length, 1); assert.match(logs[0], /stale/);
    echo.reference('m', CALL, zeros(), { captureWallMs: 3000 });
    const resumed = echo.microphone('m', MIC, 'c', zeros(), { captureWallMs: 3000 }); await echo.flush(MIC); await resumed;
    assert.equal(echo.stats().frames, 2);
    echo.reference('m', CALL, zeros());
    assert.equal(echo.buffered().sessions, 0);
    const noClock = echo.microphone('m', MIC, 'd', zeros(), { captureWallMs: 4000 }); if (noClock) await noClock;
    assert.equal(logs.length, 1, 'one reason line per recording, even across several failures');
    now++;
    echo.reference('m', CALL, zeros(), { captureWallMs: 5000 });
    const lag = echo.microphone('m', MIC, 'e', zeros(), { captureWallMs: 15000 }); if (lag) await lag;
    assert.equal(echo.buffered().sessions, 0, 'permanently late reference does not keep a waiting worker');
  } finally { await echo.close(); }
});

test('a watchdog serviced after simulated whole-process sleep falls back raw without permanently disabling resumed AEC', async () => {
  let now = 0; const logs: string[] = [];
  const echo = new LiveEcho({ workerScript: fake, leadMs: 296, deadlineMs: 250, clock: () => now, log: line => logs.push(line) });
  const input = bytes(new Float32Array(16000).fill(0.4));
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 1000 });
    const old = echo.microphone('m', MIC, 'stall', input, { captureWallMs: 1000 });
    now = 10000;
    assert.ok((await old)!.equals(input));
    echo.reference('m', CALL, zeros(), { captureWallMs: 11000 });
    const resumed = echo.microphone('m', MIC, 'resume', input, { captureWallMs: 11000 });
    await echo.flush(MIC);
    assert.ok(Math.abs((await resumed)!.readFloatLE(8000 * 4) - 0.2) < 1e-6);
    assert.equal(echo.stats().failures, 1); assert.equal(logs.length, 1); assert.match(logs[0], /server paused/);
  } finally { await echo.close(); }
});

test('call ends first: retain and cancel the mic final second, then retire without waiting for future render', async () => {
  const echo = new LiveEcho({ leadMs: 0, waitMs: 1500 });
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 1000 }); echo.reference('m', CALL, zeros(), { captureWallMs: 2000 });
    const first = echo.microphone('m', MIC, 'a', zeros(), { captureWallMs: 1000 }); await echo.flush(MIC); await first;
    await echo.end('m', CALL);
    const mic = new Float32Array(16000); mic[15999] = 0.5;
    const tail = echo.microphone('m', MIC, 'b', bytes(mic), { captureWallMs: 2000 });
    const start = performance.now(); await echo.flush(MIC); const out = await tail;
    assert.ok(performance.now() - start < 500); assert.ok(out!.readFloatLE(15999 * 4) > 0.1);
    assert.equal(echo.stats().missingSamples, 0, 'call /end did not discard its final reference frame');
    const raw = echo.microphone('m', MIC, 'c', zeros(), { captureWallMs: 3000 }); if (raw) await raw;
    assert.equal(echo.buffered().sessions, 0);
  } finally { await echo.close(); }
});

test('pin first remote; other remote frames/end cannot change or retire its session; switch after pinned end', async () => {
  const echo = new LiveEcho({ workerScript: fake, leadMs: 297 });
  const marker = (value: number) => bytes(new Float32Array(16000).fill(value));
  try {
    echo.reference('m', 'app:first', marker(0.1), { captureWallMs: 1000 }); echo.reference('m', 'tab:second', marker(0.2), { captureWallMs: 1000 });
    const a = echo.microphone('m', MIC, 'a', zeros(), { captureWallMs: 1000 }); await echo.flush(MIC);
    assert.ok(Math.abs((await a)!.readFloatLE(8000 * 4) - 0.1) < 1e-6);
    await echo.end('m', 'tab:second'); assert.equal(echo.buffered().sessions, 1);
    echo.reference('m', 'tab:second', marker(0.2), { captureWallMs: 2000 });
    const b = echo.microphone('m', MIC, 'b', zeros(), { captureWallMs: 1500 }); await echo.flush(MIC);
    assert.ok(Math.abs((await b)!.readFloatLE(8000 * 4) - 0.1) < 1e-6, 'standby did not replace the first render source');
    assert.equal(echo.stats().failures, 0); assert.equal(echo.buffered().sessions, 1);
    await echo.end('m', 'app:first');
    const c = echo.microphone('m', MIC, 'c', zeros(), { captureWallMs: 2000 }); await echo.flush(MIC);
    assert.ok(Math.abs((await c)!.readFloatLE(8000 * 4) - 0.2) < 1e-6, 'after pinned end a reset selected the live standby');
    assert.equal(echo.stats().frames, 3); assert.equal(echo.stats().failures, 0);
  } finally { await echo.close(); }
});

test('more than ten total seconds of live-call missing reference logs once, even with fresh endpoints', async () => {
  let now = 0; const logs: string[] = [], echo = new LiveEcho({ leadMs: 0, waitMs: 0, clock: () => now, log: line => logs.push(line) });
  try {
    for (let n = 0; n < 24; n++) {
      now = n * 1000;
      echo.reference('m', CALL, Buffer.alloc(8000 * 4), { captureWallMs: 1000 + n * 1000 + 500 });
      await echo.microphone('m', MIC, String(n), zeros(), { captureWallMs: 1000 + n * 1000 });
      if (n < 20) assert.equal(logs.length, 0);
    }
    assert.equal(logs.length, 1); assert.match(logs[0], /more than 10 s.*missing\/late reference/);
    assert.ok(echo.stats().missingSamples > 160000);
  } finally { await echo.close(); }
});

for (const stop of ['end', 'close', 'abandon', 'inactive'] as const) test(`P1: ${stop} signals flush before seal; last microphone impulse survives without reference timeout`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-review-seal-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const logs: string[] = [], live = new LiveCapture(store, { echo: { leadMs: 0 }, log: line => logs.push(line) });
  try {
    await live.accept(meeting.id, CALL, 0, 0, zeros(), 'page', { captureWallMs: 1000 });
    await live.accept(meeting.id, CALL, 1, 1000, zeros(), 'page', { captureWallMs: 2000 });
    const input = new Float32Array(16000); input[15990] = 0.5;
    await live.accept(meeting.id, MIC, 0, 0, bytes(input), 'page', { captureWallMs: 1000 });
    const start = performance.now();
    if (stop === 'end') await live.end(meeting.id, MIC, 0);
    else if (stop === 'close') await live.close();
    else if (stop === 'abandon') await live.abandonPage('page');
    else await live.endIfInactive(meeting.id, MIC, () => true);
    assert.ok(performance.now() - start < 1000, 'Stop must not wait for the 1.5-second reference/output timer');
    const chunk = store.chunks(meeting.id).find(chunk => chunk.source === MIC)!;
    const out = await readFile(store.resolvePath(chunk.path)); assert.equal(out.length, input.byteLength);
    assert.ok(out.readFloatLE(15990 * 4) > 0.1, 'last ten samples were flushed into sealed recognition audio');
    assert.equal(logs.length, 0);
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
