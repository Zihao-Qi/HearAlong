import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignedCall, cancelEcho, energySummary, estimateDelay, f32Bytes, newOutputDirectory, parseRanges, readF32, trialModel } from '../scripts/aec-trial.ts';

const clock = { micStartMs: 0, callStartMs: 0 };

test('meeting-clock alignment: earlier/later reference, extra delay, no overlap', () => {
  const call = Float32Array.from([1, 2, 3, 4]);
  // One sample is 1/16 millisecond.
  assert.deepEqual([...alignedCall(call, 4, { micStartMs: 0.125, callStartMs: 0 })], [3, 4, 0, 0]);
  assert.deepEqual([...alignedCall(call, 4, { micStartMs: 0, callStartMs: 0.125 })], [0, 0, 1, 2]);
  assert.deepEqual([...alignedCall(call, 4, { ...clock, extraDelayMs: 0.0625 })], [0, 1, 2, 3]);
  assert.deepEqual([...alignedCall(call, 4, { micStartMs: 1000, callStartMs: 0 })], [0, 0, 0, 0]);
  assert.throws(() => alignedCall(call, 4, { ...clock, micStartMs: NaN }), /finite/);
});

test('ERLE requires explicitly known echo-only intervals and active reference', () => {
  const mic = new Float32Array(32_000).fill(0.1), cleaned = new Float32Array(32_000).fill(0.01);
  const summary = energySummary(mic, cleaned, mic, { ...clock, echoOnly: [{ start: 0, end: 1 }] });
  assert.ok(Math.abs(summary[0].erleDb! - 20) < 1e-5);
  assert.equal(summary[1].erleDb, null);
  assert.equal(energySummary(mic, cleaned, new Float32Array(32_000), { ...clock, echoOnly: [{ start: 0, end: 2 }] })[0].erleDb, null);
  assert.deepEqual(parseRanges('0:1,5.5:8'), [{ start: 0, end: 1 }, { start: 5.5, end: 8 }]);
  for (const invalid of ['', '1:0', 'NaN:3', '-1:2']) assert.throws(() => parseRanges(invalid));
});

test('raw f32 round-trip; reject empty, partial, nonfinite and out-of-range inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aec-pcm-')), path = join(directory, 'input.f32');
  const samples = Float32Array.from([-1, -0.25, 0, 0.5, 1]);
  await writeFile(path, f32Bytes(samples));
  assert.deepEqual(await readF32(path), samples);
  assert.deepEqual(await readFile(path), f32Bytes(samples));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(3), f32Bytes(Float32Array.of(NaN)), f32Bytes(Float32Array.of(Infinity)), f32Bytes(Float32Array.of(1.1))]) {
    await writeFile(path, bytes);
    await assert.rejects(readF32(path));
  }
});

test('output is a fresh directory: existing directories/files and symlinks are rejected', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'aec-output-')), path = join(parent, 'out');
  assert.equal(await newOutputDirectory(path), path);
  await assert.rejects(newOutputDirectory(path), { code: 'EEXIST' });
  await symlink(path, join(parent, 'link'));
  await assert.rejects(newOutputDirectory(join(parent, 'link')), { code: 'EEXIST' });
  await writeFile(join(parent, 'file'), 'unchanged');
  await assert.rejects(newOutputDirectory(join(parent, 'file')), { code: 'EEXIST' });
  assert.equal(await readFile(join(parent, 'file'), 'utf8'), 'unchanged');
});

test('diagnostic delay recovers both signs, and reports silence as unavailable', () => {
  const call = new Float32Array(48_000), mic = new Float32Array(call.length);
  let state = 7;
  for (let i = 0; i < call.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; call[i] = (state / 2 ** 32 - 0.5) * 0.1; }
  mic.set(call.subarray(0, call.length - 800), 800);
  assert.equal(estimateDelay(mic, call).lagMs, 50);
  assert.equal(estimateDelay(call, mic).lagMs, -50);
  assert.equal(estimateDelay(new Float32Array(32_000), new Float32Array(32_000)).lagMs, null);
});

test('real WASM handles short/final partial frames and repeated free/recreate without changing inputs', async () => {
  for (const length of [1, 159, 160, 161, 16_003]) {
    const mic = new Float32Array(length), call = new Float32Array(length);
    const before = mic.slice(), result = await cancelEcho(mic, call, clock);
    assert.equal(result.cleaned.length, length);
    assert.ok(result.cleaned.every(Number.isFinite));
    assert.deepEqual(mic, before);
    assert.ok(result.computeSeconds > 0 && result.realTimeFactor > 0);
  }
});

test('recognition without an explicit model fails before settings/cache discovery', async () => {
  const previous = process.env.MEETING_MODEL_PATH;
  delete process.env.MEETING_MODEL_PATH;
  try { await assert.rejects(trialModel(), /requires MEETING_MODEL_PATH/); }
  finally { if (previous !== undefined) process.env.MEETING_MODEL_PATH = previous; }
});
