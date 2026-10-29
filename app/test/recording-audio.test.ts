import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as audio from '../src/audio.ts';

const RATE = audio.SAMPLE_RATE;
test('recorded f32le windows read exact samples, clamp at EOF and own their buffers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.f32');
  const expected = Float32Array.from({ length: RATE * 2 + 7 }, (_, i) => ((i % 257) - 128) / 256);
  await writeFile(path, Buffer.from(expected.buffer));
  let ffmpeg = true;
  try { await audio.runBinary('ffmpeg', ['-version']); } catch { ffmpeg = false; }
  for (const [start, seconds] of [[0, 1], [1, 1], [17 / RATE, 31 / RATE], [2, 1], [0, 10], [2 + 6 / RATE, 1]]) {
    const actual = await audio.readRecordingChunk(path, start, seconds);
    assert.deepEqual(actual, expected.slice(Math.round(start * RATE), Math.round((start + seconds) * RATE)));
    assert.equal(actual.byteOffset, 0);
    assert.equal(actual.buffer.byteLength, actual.byteLength);
    if (ffmpeg) assert.deepEqual(actual, await audio.decodeChunk(path, start, seconds, RATE));
  }
  for (const count of [1, 3, 17]) {
    await writeFile(path, Buffer.from(expected.slice(0, count).buffer));
    const actual = await audio.readRecordingChunk(path, 0, 1);
    assert.deepEqual(actual, expected.slice(0, count));
    if (ffmpeg) assert.deepEqual(actual, await audio.decodeChunk(path, 0, 1, RATE));
  }
  t.diagnostic(ffmpeg ? 'Compared every nonempty window sample-for-sample against FFmpeg.' : 'FFmpeg unavailable; compared against expected synthetic arrays.');
});

test('recording reads reject empty ranges and partial samples without padding or truncation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'recording-boundaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.f32');
  await writeFile(path, Buffer.alloc(0));
  await assert.rejects(audio.readRecordingChunk(path, 0, 1), /no usable audio/i);
  await writeFile(path, Buffer.from(new Float32Array([.125]).buffer));
  for (const [start, seconds] of [[1 / RATE, 1], [5, 1], [0, 0]]) {
    await assert.rejects(audio.readRecordingChunk(path, start, seconds), /no usable audio/i);
  }
  // A file being appended to may end mid-sample: the partial sample is ignored, as FFmpeg's raw decoding did.
  for (const trailing of [1, 2, 3]) {
    await writeFile(path, Buffer.concat([Buffer.from(new Float32Array([.25]).buffer), Buffer.alloc(trailing, 0x7f)]));
    assert.deepEqual([...await audio.readRecordingChunk(path, 0, 1)], [.25]);
  }
  for (const [start, seconds] of [[-1, 1], [NaN, 1], [0, Infinity], [0, -1]]) {
    await assert.rejects(audio.readRecordingChunk(path, start, seconds), /invalid recording window/i);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(audio.readRecordingChunk(path, 0, 1, controller.signal), { name: 'AbortError' });
});
