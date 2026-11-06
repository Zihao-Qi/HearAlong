import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { LiveEcho } from '../src/echo-audio.ts';
import { LiveCapture } from '../src/live.ts';
import { MeetingStore } from '../src/store.ts';
import { audioSpans, EchoProcessor } from '../src/echo-timeline.ts';
import { delayedAec } from './fixtures/delayed-aec.ts';
import { detectFrameCaptureGaps, captureDiscontinuities } from '../src/capture-gaps.ts';
import { SampleCaptureClock } from '../public/capture-clock.js';
import { observeEcho } from './helpers/observe-echo.ts';

const MIC = 'mic:00000000-0000-0000-0000-000000000021';
const CALL = 'app:00000000-0000-0000-0000-000000000022';
const OTHER = 'tab:00000000-0000-0000-0000-000000000023';
const zeros = () => Buffer.alloc(64000);
const workerScript = new URL('./fixtures/echo-worker.ts', import.meta.url);

test('review2 P1: suppressed 0.8 terminal sample followed by worker crash and silence returns literal raw, no old correction ramp', async () => {
  const logs: string[] = [], echo = new LiveEcho({ workerScript, leadMs: 295, log: line => logs.push(line) });
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 100000 });
    const first = zeros(); first.writeFloatLE(0.8, first.length - 4);
    const suppressed = await echo.microphone('m', MIC, 'first', first, { captureWallMs: 100000 });
    assert.ok(suppressed!.equals(zeros()));
    echo.reference('m', CALL, zeros(), { captureWallMs: 101000 });
    const raw = zeros(), next = await echo.microphone('m', MIC, 'crash', raw, { captureWallMs: 101000 });
    assert.ok(next!.equals(raw), 'fallback must not inject the preceding frame correction into silence');
    assert.equal(next!.readFloatLE(0), 0); assert.equal(next!.readFloatLE(78 * 4), 0);
    const later = echo.microphone('m', MIC, 'later', raw, { captureWallMs: 102000 });
    assert.ok(later === null || (await later).equals(raw));
    assert.equal(logs.length, 1);
  } finally { await echo.close(); }
});

test('review2: ended reference flushes covered final mic frame without an external flush or wait timeout, including FIRST mic arrival', async t => {
  const observed = observeEcho(t);
  for (const priorMic of [true, false]) {
    const echo = new LiveEcho({ leadMs: 0, workerScript: observed.workerScript });
    try {
      echo.reference('m', CALL, zeros(), { captureWallMs: 1000 });
      echo.reference('m', CALL, zeros(), { captureWallMs: 2000 });
      const first = priorMic ? echo.microphone('m', MIC, 'a', zeros(), { captureWallMs: 1000 }) : null;
      await echo.end('m', CALL);
      const raw = zeros(); raw.writeFloatLE(0.5, raw.length - 4);
      const id = `tail-${priorMic}`, tail = echo.microphone('m', MIC, id, raw, { captureWallMs: 2000 });
      assert.ok(tail, 'buffered ended call must support a delayed FIRST microphone upload');
      const out = await tail; await first;
      observed.assertReleased(id, 'reference-ended');
      assert.ok(out.readFloatLE(out.length - 4) > 0.1);
      assert.equal(echo.stats().missingSamples, 0);
    } finally { await echo.close(); }
  }
});

test('review2: expired ended-reference grace frees history, no later raw promises or worker retention', async () => {
  let now = 0;
  const echo = new LiveEcho({ workerScript, leadMs: 0, clock: () => now });
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 1000 }); await echo.end('m', CALL);
    now = 9999; assert.equal(echo.buffered().referenceFrames, 1);
    now = 10001;
    assert.equal(echo.microphone('m', MIC, 'late', zeros(), { captureWallMs: 1000 }), null);
    assert.equal(echo.buffered().meetings, 0); assert.equal(echo.buffered().referenceFrames, 0);
  } finally { await echo.close(); }
});

for (const transition of ['stale', 'ended'] as const) test(`review2: pinned ${transition} switches live standby in the existing worker, never retires or logs stale`, async () => {
  let now = 0;
  const logs: string[] = [], echo = new LiveEcho({ workerScript, leadMs: 297, clock: () => now, log: line => logs.push(line) });
  const marker = (value: number) => Buffer.from(new Float32Array(16000).fill(value).buffer);
  try {
    echo.reference('m', CALL, marker(0.1), { captureWallMs: 1000 });
    echo.reference('m', OTHER, marker(0.2), { captureWallMs: 1000 });
    const first = echo.microphone('m', MIC, 'first', zeros(), { captureWallMs: 1000 }); await echo.flush(MIC); await first;
    now = transition === 'stale' ? 3500 : 1000;
    echo.reference('m', OTHER, marker(0.2), { captureWallMs: 2000 });
    if (transition === 'ended') await echo.end('m', CALL);
    const next = echo.microphone('m', MIC, 'next', zeros(), { captureWallMs: 2000 });
    assert.equal(echo.buffered().sessions, 1); assert.equal(echo.buffered().retiring, 0);
    await echo.flush(MIC);
    assert.ok(Math.abs((await next)!.readFloatLE(8000 * 4) - 0.2) < 1e-6);
    assert.deepEqual(logs, []); assert.equal(echo.stats().failures, 0);
  } finally { await echo.close(); }
});

test('review2: global flush awaits retirement; retirement clears owned references and later mic is synchronous raw', async () => {
  const echo = new LiveEcho({ workerScript, leadMs: 0 });
  try {
    echo.reference('m', CALL, zeros(), { captureWallMs: 1000 });
    const first = echo.microphone('m', MIC, 'first', zeros(), { captureWallMs: 1000 }); await echo.flush(MIC); await first;
    await echo.end('m', CALL);
    const crossed = echo.microphone('m', MIC, 'crossed', zeros(), { captureWallMs: 3000 }); if (crossed) await crossed;
    await echo.flush();
    assert.equal(echo.buffered().retiring, 0); assert.equal(echo.buffered().sessions, 0);
    assert.equal(echo.buffered().meetings, 0); assert.equal(echo.buffered().referenceFrames, 0);
    assert.equal(echo.microphone('m', MIC, 'next', zeros(), { captureWallMs: 4000 }), null);
  } finally { await echo.close(); }
});

test('review2: mic Stop bypasses a normal seal already waiting for AEC, while validation/end state stays serialized', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-review2-seal-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const observed = observeEcho(t), live = new LiveCapture(store, { echo: { leadMs: 0, workerScript: observed.workerScript } });
  try {
    for (let n = 0; n < 23; n++) {
      await live.accept(meeting.id, CALL, n, n * 1000, zeros(), 'page', { captureWallMs: 100000 + n * 1000 });
      const frame = await live.accept(meeting.id, MIC, n, n * 1000, zeros(), 'page', { captureWallMs: 100000 + n * 1000 });
      // Do not mistake accumulated worker startup/DSP backlog for a reference wait at Stop.
      const admitted = await observed.waitFor(event => event.event === 'microphone' && event.id === frame.id);
      await observed.waitFor(event => event.event === 'drain', observed.events.indexOf(admitted) + 1);
    }
    let saved!: () => void; const durable = new Promise<void>(resolve => { saved = resolve; });
    const addFrame = store.addFrame.bind(store);
    store.addFrame = async (...args: Parameters<typeof store.addFrame>) => { const result = await addFrame(...args); if (args[1] === MIC && args[2] === 23) saved(); return result; };
    const input = zeros(); input.writeFloatLE(0.5, input.length - 4);
    const pending = live.accept(meeting.id, MIC, 23, 23000, input, 'page', { captureWallMs: 123000 });
    await durable;
    const held = store.heldFrames(meeting.id, MIC), blocked = held.find(frame => frame.sequence === 22)!.id;
    const last = held.find(frame => frame.sequence === 23)!.id;
    await observed.waitFor(event => event.event === 'microphone' && event.id === last);
    await observed.waitFor(event => event.event === 'drain' && event.pending === 1);
    const sealWindow = store.sealWindow.bind(store);
    store.sealWindow = async (...args: Parameters<typeof store.sealWindow>) => {
      if (args[1][0].source === MIC) observed.assertReleased(blocked, 'flush');
      return sealWindow(...args);
    };
    assert.equal(live.sourceEnded(MIC), false);
    const start = performance.now();
    await live.end(meeting.id, MIC, 23); await pending;
    observed.assertReleased(blocked, 'flush');
    observed.assertReleased(last, 'flush');
    assert.ok(performance.now() - start < 1400, 'secondary sanity bound below the 1500 ms reference wait');
    const chunks = store.chunks(meeting.id).filter(chunk => chunk.source === MIC).sort((a, b) => a.startMs - b.startMs);
    const output = Buffer.concat(await Promise.all(chunks.map(chunk => readFile(store.resolvePath(chunk.path)))));
    assert.equal(output.length, 24 * 64000); assert.equal(output.readFloatLE(output.length - 4), 0.5);
    await assert.rejects(live.accept(meeting.id, MIC, 24, 24000, zeros()), /ended/);
  } finally { await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const stop of ['end', 'invalid end', 'inactive', 'abandon', 'close'] as const) test(`review2: ${stop} checkpoint covers AEC admitted AFTER the early flush`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-review2-admission-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const observed = observeEcho(t), live = new LiveCapture(store, { echo: { leadMs: 0, workerScript: observed.workerScript } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    for (let n = 0; n < 23; n++) {
      await live.accept(meeting.id, CALL, n, n * 1000, zeros(), 'call-page', { captureWallMs: 100000 + n * 1000 });
      if (n < 22) await live.accept(meeting.id, MIC, n, n * 1000, zeros(), 'page', { captureWallMs: 100000 + n * 1000 });
    }
    let saved!: () => void;
    const durable = new Promise<void>(resolve => { saved = resolve; }), addFrame = store.addFrame.bind(store);
    store.addFrame = async (...args: Parameters<typeof store.addFrame>) => {
      const result = await addFrame(...args);
      if (args[1] === MIC && args[2] === 22) { saved(); await gate; }
      return result;
    };
    const before = live.accept(meeting.id, MIC, 22, 22000, zeros(), 'page', { captureWallMs: 122000 });
    await durable; // Raw frame is durable, but its AEC admission has not happened.
    const input = zeros(); input.writeFloatLE(0.5, input.length - 4);
    const pending = live.accept(meeting.id, MIC, 23, 23000, input, 'page', { captureWallMs: 123000 });
    const mark = observed.events.length;
    let inactive = true;
    const stopping = stop === 'close' ? live.close() : stop === 'abandon' ? live.abandonPage('page')
      : stop === 'inactive' ? live.endIfInactive(meeting.id, MIC, () => inactive)
      : live.end(meeting.id, MIC, stop === 'invalid end' ? 24 : 23);
    // Attach rejection handling before releasing the queue.
    const stopped = stop === 'invalid end' ? assert.rejects(stopping, /have not all arrived/) : stopping;
    await observed.waitFor(event => event.event === 'flush', mark);
    const blocked = store.heldFrames(meeting.id, MIC).find(frame => frame.sequence === 22)!;
    assert.equal(live.sourceEnded(MIC), false, 'early checkpoint cannot mutate serialized end state');
    assert.ok((await readFile(store.resolvePath(blocked.path))).equals(zeros()), 'raw admission is unchanged');
    inactive = false; // The queued inactive check must still be allowed to lose.
    release();
    await Promise.all([before, pending, stopped]);
    observed.assertReleased(blocked.id, 'flush');
    const micAt = observed.events.findIndex(event => event.event === 'microphone' && event.id === blocked.id);
    const emittedAt = observed.events.findIndex(event => event.event === 'drain' && event.ids?.includes(blocked.id));
    assert.ok(observed.events.slice(micAt + 1, emittedAt).some(event => event.event === 'flush'), 'a fresh checkpoint follows the late admission');
    if (stop === 'invalid end' || stop === 'inactive') {
      assert.equal(live.sourceEnded(MIC), false);
      const mark = observed.events.length;
      await live.accept(meeting.id, MIC, 24, 24000, zeros(), 'page', { captureWallMs: 124000 });
      const admitted = await observed.waitFor(event => event.event === 'microphone', mark);
      const waiting = await observed.waitFor(event => event.event === 'drain', observed.events.indexOf(admitted) + 1);
      assert.equal(waiting.force, false, 'a rejected/cancelled Stop does not leave checkpoint mode enabled');
      assert.ok(waiting.pending! > 0);
      await live.end(meeting.id, MIC, 24);
    }
  } finally { release(); await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('review2: Stop before the FIRST AEC session covers queued admission and overlapping checkpoints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-review2-first-')), store = new MeetingStore(directory), meeting = store.createMeeting();
  const observed = observeEcho(t), live = new LiveCapture(store, { echo: { leadMs: 0, workerScript: observed.workerScript } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    // Earlier mic audio is already raw; there was no call and therefore no AEC worker.
    for (let n = 0; n < 22; n++) await live.accept(meeting.id, MIC, n, n * 1000, zeros(), 'page', { captureWallMs: 100000 + n * 1000 });
    for (let n = 0; n < 23; n++) await live.accept(meeting.id, CALL, n, n * 1000, zeros(), 'call-page', { captureWallMs: 100000 + n * 1000 });
    let entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; }), addFrame = store.addFrame.bind(store);
    store.addFrame = async (...args: Parameters<typeof store.addFrame>) => {
      if (args[1] === MIC && args[2] === 22) { entered(); await gate; }
      return addFrame(...args);
    };
    const before = live.accept(meeting.id, MIC, 22, 22000, zeros(), 'page', { captureWallMs: 122000 });
    await saving;
    const input = zeros(); input.writeFloatLE(0.5, input.length - 4);
    const pending = live.accept(meeting.id, MIC, 23, 23000, input, 'page', { captureWallMs: 123000 });
    const invalid = assert.rejects(live.end(meeting.id, MIC, 24), /have not all arrived/);
    const stopping = live.end(meeting.id, MIC, 23);
    assert.equal(observed.events.length, 0, 'both early flushes have no worker to signal');
    assert.equal(live.sourceEnded(MIC), false);
    release();
    const blocked = await before;
    await Promise.all([pending, invalid, stopping]);
    observed.assertReleased(blocked.id, 'flush');
    assert.equal(live.sourceEnded(MIC), true);
    assert.equal(store.chunks(meeting.id).filter(chunk => chunk.source === MIC).reduce((sum, chunk) => sum + chunk.seconds, 0), 24);
  } finally { release(); await live.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('review2: post-cut span anchors at toWallMs, not a summed approximation 2000 ms early', () => {
  const spans = audioSpans({ pcm: new Float32Array(16000), timing: { captureWallMs: 100000,
    discontinuities: [{ offsetSamples: 8000, fromWallMs: 102500, toWallMs: 112500 }] } });
  assert.equal(spans[1].wallMs, 112500);
  const evidence = detectFrameCaptureGaps(undefined, { captureWallMs: 100000,
    discontinuities: [{ offsetSamples: 8000, fromWallMs: 102500, toWallMs: 112500 }] }, 0, 16000, 16000);
  assert.equal(evidence.endWallMs, 113000);
});

test('review2: worklet records 150 ms/3 s/2 s pauses inside a frame; no false 5500 ms boundary gap', async () => {
  const code = (await readFile(new URL('../public/pcm-worklet.js', import.meta.url), 'utf8')).replace(/^import .*;$/m, '');
  for (const short of [100, 150, 3000, 2000]) {
    let Processor: any; let now = 100000;
    const messages: any[] = [], sandbox: any = { SampleCaptureClock, sampleRate: 16000, currentFrame: 0, Date: { now: () => now },
      AudioWorkletProcessor: class { port = { postMessage: (message: any) => messages.push(structuredClone(message)) }; },
      registerProcessor: (_name: string, ctor: any) => { Processor = ctor; } };
    runInNewContext(code, sandbox); const p = new Processor(), input = new Float32Array(128).fill(0.25);
    let elapsed = 0;
    for (let quantum = 0; quantum < 250; quantum++) {
      if (quantum === 25) elapsed += short;
      if (quantum === 125 && short !== 150) elapsed += 2500;
      now = 100000 + quantum * 8 + elapsed; sandbox.currentFrame = quantum * 128; p.process([[input]], []);
    }
    assert.equal(messages.length, 2); assert.equal(messages[0].discontinuities.length, 1);
    const cut = messages[0].discontinuities[0]; assert.equal(cut.offsetSamples, 3200); assert.equal(cut.toWallMs - cut.fromWallMs, short);
    assert.equal(captureDiscontinuities(messages[0].discontinuities, 16000).length, 1);
    const before = detectFrameCaptureGaps(undefined, messages[0], 0, 16000, 16000);
    const after = detectFrameCaptureGaps({ captureWallMs: messages[0].captureWallMs, captureEndWallMs: before.endWallMs, samples: 16000 }, messages[1], 1000, 16000, 16000);
    assert.deepEqual(before.gaps, []); assert.deepEqual(after.gaps, [], 'two short pauses are not one false 5500 ms gap');
    assert.equal(after.endWallMs, 102000 + short + (short === 150 ? 0 : 2500));
    assert.equal(audioSpans({ pcm: new Float32Array(messages[0].buffer), timing: messages[0] })[1].wallMs, cut.toWallMs);
    for (const message of messages) assert.ok(new Float32Array(message.buffer).every(value => value === 0.25));
    if (short === 150) {
      const { module, counts } = delayedAec(), processor = new EchoProcessor(module, 0);
      try {
        for (const message of messages) processor.reference({ pcm: new Float32Array(16000), timing: message });
        for (const [index, message] of messages.entries()) processor.push(String(index), { pcm: new Float32Array(message.buffer), timing: message });
        processor.flush();
        assert.equal(counts.constructed, 3, 'calibration + initial kernel + one real pause reset, not a second reset at next frame');
        assert.equal(processor.takeReady().length, 2);
      } finally { processor.close(); }
    }
  }
});
