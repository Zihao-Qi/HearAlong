// Bounded synthetic event simulation using the EXACT scheduler used by echo-worker, not a second model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { EchoProcessor, type EchoModule, type EchoOutput, type TimedAudio } from '../../src/echo-timeline.ts';
import { EchoScheduler } from '../../src/echo-scheduler.ts';

export async function simulateEchoCall(module: EchoModule, options: { frames?: number; exact: boolean; ppm?: number }) {
  const frames = options.frames ?? 7200, ppm = options.ppm ?? 200;
  const processor = new EchoProcessor(module, 100), scheduler = new EchoScheduler(processor, 1500);
  const base = 100000, sleepAt = frames * 1000 / 2, stepAt = frames * 1000 / 3;
  const delivery = (time: number) => base + time + (time >= sleepAt ? 10000 : 0);
  const wall = (time: number) => delivery(time) + (time >= stepAt ? 30000 : 0);
  const leaveAt = delivery(frames * 1000 * 2 / 3), rejoinAt = leaveAt + 5000;
  const duration = (drift: number) => 1000 * (1 + drift / 1e6);
  const micStep = duration(ppm), refStep = duration(-ppm);
  const expected = new Map<string, { pcm: Float32Array; at: number }>();
  const inputHash = createHash('sha256'), outputHash = createHash('sha256');
  let nMic = 0, nRef = 0, nextOutput = 0, now = base, left = false, rejoined = false, active = true;
  let samples = 0, missing = 0, maxWaitMs = 0, maxFrames = 0, maxTargets = 0, maxPending = 0, maxExpected = 0;
  let maxArrayBuffers = 0, maxHeap = 0, minCorrelation = 1, seed = 17;
  let delayed: TimedAudio | null = null, deliveredPreSleepAfterWake = false;
  const timing = (index: number, step: number): TimedAudio['timing'] => {
    const first = index * step, last = first + step;
    const captureWallMs = wall(first);
    const discontinuities = [];
    for (const [at, delta] of [[stepAt, 30000], [sleepAt, 10000]]) if (first < at && last > at) {
      const offsetSamples = Math.round((at - first) / step * 16000);
      if (offsetSamples > 0 && offsetSamples < 16000) {
        const toWallMs = wall(at), fromWallMs = toWallMs - delta;
        discontinuities.push({ offsetSamples, fromWallMs, toWallMs });
      }
    }
    return { captureWallMs, discontinuities };
  };
  const emit = (results: EchoOutput[]) => {
    for (const result of results) {
      assert.equal(result.id, String(nextOutput++), 'no duplicate/reordered/missing frames');
      const input = expected.get(result.id)!; assert.ok(input); expected.delete(result.id);
      assert.equal(result.pcm.length, input.pcm.length); assert.ok(result.pcm.every(Number.isFinite));
      const rawBytes = Buffer.from(input.pcm.buffer), outBytes = Buffer.from(result.pcm.buffer);
      if (options.exact) assert.ok(outBytes.equals(rawBytes), `input sample identity lost in frame ${result.id}`);
      else {
        // The split/merge FIR is dispersive: its impulse peak delay is 165, while a 500 Hz
        // tone retains ~2 samples of phase coloration. This is NOT another frame/tail shift.
        // Require high correlation within +/-2 samples; uncompensated 165-sample output fails.
        let correlation = -1;
        for (let lag = -2; lag <= 2; lag++) {
          let xy = 0, xx = 0, yy = 0;
          for (let i = 128; i < result.pcm.length - 128; i++) { xy += result.pcm[i] * input.pcm[i - lag]; xx += input.pcm[i - lag] ** 2; yy += result.pcm[i] ** 2; }
          correlation = Math.max(correlation, xy / Math.sqrt(xx * yy));
        }
        minCorrelation = Math.min(minCorrelation, correlation);
        // Reset/raw-transition windows include the <=5 ms crossfade and FIR startup transient.
        assert.ok(correlation > 0.98, `real WASM no-echo near signal lost alignment: frame ${result.id}, correlation ${correlation}`);
        assert.ok(result.pcm.subarray(0, 16).some(value => Math.abs(value) > 0.1), 'first-sample impulse vanished');
        assert.ok(result.pcm.subarray(15984).some(value => Math.abs(value) > 0.1), 'last-sample impulse vanished');
      }
      outputHash.update(outBytes); samples += result.pcm.length; missing += result.missingSamples;
      maxWaitMs = Math.max(maxWaitMs, now - input.at);
      assert.ok(now - input.at <= 1500.001, 'worker reference/lookahead wait is bounded');
    }
  };
  try {
    while (nMic < frames) {
      const nextMic = delivery((nMic + 1) * micStep), nextRef = delivery((nRef + 1) * refStep);
      const transition = !left ? leaveAt : !rejoined ? rejoinAt : Infinity;
      now = Math.min(nextMic, nextRef, transition, scheduler.deadline);
      if (now === transition) {
        if (!left) {
          emit(scheduler.drain(now, true, true)); processor.resetReference(); scheduler.referenceEnded(); left = true; active = false;
        } else { emit(scheduler.switchReference([], now)); rejoined = true; active = true; }
      }
      if (now === nextRef) {
        const start = delivery(nRef * refStep);
        const audio = { pcm: new Float32Array(16000), timing: timing(nRef, refStep) };
        // A pre-sleep callback can be queued until wake; its timestamp is its old capture epoch.
        if (nRef === Math.floor(sleepAt / refStep) - 1) delayed = audio;
        else if (active && !(start < rejoinAt && nextRef > leaveAt)) scheduler.reference(audio);
        if (delayed && nRef * refStep >= sleepAt) {
          scheduler.reference(delayed); delayed = null; deliveredPreSleepAfterWake = true;
        }
        nRef++;
      }
      if (now === nextMic) {
        const pcm = new Float32Array(16000);
        for (let i = 0; i < pcm.length; i++) {
          if (options.exact) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm[i] = (seed % 65535 - 32767) / 131072; }
          else pcm[i] = 0.02 * Math.sin(i * 2 * Math.PI * 500 / 16000);
        }
        pcm[0] = 0.5; pcm[pcm.length - 1] = 0.5;
        const id = String(nMic++); expected.set(id, { pcm, at: now }); inputHash.update(Buffer.from(pcm.buffer));
        scheduler.admit(id, { pcm, timing: timing(nMic - 1, micStep) }, now);
      }
      emit(scheduler.drain(now));
      const buffered = scheduler.buffered();
      maxFrames = Math.max(maxFrames, buffered.frames); maxTargets = Math.max(maxTargets, buffered.targets);
      maxPending = Math.max(maxPending, buffered.pending); maxExpected = Math.max(maxExpected, expected.size);
      assert.ok(buffered.frames <= 3 && buffered.targets <= 8 && buffered.pending <= 2 && buffered.referenceFrames <= 10 && expected.size <= 3, 'audio memory must stay bounded');
      if (nMic % 60 === 0) { const usage = process.memoryUsage(); maxArrayBuffers = Math.max(maxArrayBuffers, usage.arrayBuffers); maxHeap = Math.max(maxHeap, usage.heapUsed); await yieldTurn(); }
    }
    emit(scheduler.drain(now, true));
    assert.equal(nextOutput, frames); assert.equal(samples, frames * 16000); assert.equal(expected.size, 0);
    assert.ok(deliveredPreSleepAfterWake, 'pre-sleep reference callback was delivered after wake on its original epoch');
    assert.ok(1 - missing / samples > 0.99, 'AEC must remain active most of the call');
    const inputSha256 = inputHash.digest('hex'), outputSha256 = outputHash.digest('hex');
    if (options.exact) assert.equal(inputSha256, outputSha256);
    assert.ok(maxArrayBuffers < 128 * 1024 * 1024 && maxHeap < 128 * 1024 * 1024, 'no long-call heap/PCM growth');
    return { frames, audioSeconds: frames, samples, ppm: { mic: ppm, call: -ppm }, sleepSeconds: 10, callLeaveSeconds: 5, wallClockStepSeconds: 30, deliveredPreSleepAfterWake,
      identityKernel: options.exact, inputSha256, outputSha256, processingDelaySamples: processor.delaySamples,
      activeFraction: 1 - missing / samples, maxWaitMs, maxFrames, maxTargets, maxPending, maxExpected, maxArrayBuffers, maxHeap, minCorrelation };
  } finally { processor.close(); }
}
