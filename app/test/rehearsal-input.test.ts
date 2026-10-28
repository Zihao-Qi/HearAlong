import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, parseArgs, parseWav, trimWav } from '../scripts/rehearsal-input.ts';

function wav(rate: number, seconds: number, bits = 16, format = 1, channels = 1) {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(format); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels * bits / 8, 8); fmt.writeUInt16LE(channels * bits / 8, 12); fmt.writeUInt16LE(bits, 14);
  // An odd-sized metadata chunk before fmt/data exercises RIFF padding.
  const data = Buffer.alloc(rate * seconds * channels * bits / 8);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const result = Buffer.alloc(12 + 10 + 24 + 8 + data.length + data.length % 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8);
  result.write('JUNK', 12); result.writeUInt32LE(1, 16); result[20] = 7;
  result.write('fmt ', 22); result.writeUInt32LE(16, 26); fmt.copy(result, 30);
  result.write('data', 46); result.writeUInt32LE(data.length, 50); data.copy(result, 54);
  return result;
}

test('rehearsal arguments: defaults, offset, fractional minutes, two sources, test mode, reopen', () => {
  assert.deepEqual(parseArgs(['mic.wav']), { mic: 'mic.wav', from: 0, withModels: false, headless: false });
  assert.deepEqual(parseArgs(['mic.wav', '--from', '10:03', '--minutes', '.5', '--them', 'them.wav', '--with-models', '--headless']), {
    mic: 'mic.wav', from: 603, minutes: .5, them: 'them.wav', withModels: true, headless: true,
  });
  assert.deepEqual(parseArgs(['--open', 'a run', '--headless']), { open: 'a run', from: 0, withModels: false, headless: true });
  assert.equal(clock(603.9), '10:03');
});

test('rehearsal arguments reject missing, unknown, duplicate and conflicting inputs', () => {
  for (const args of [[], ['a', 'b'], ['a', '--keep'], ['a', '--from'], ['a', '--them', '--headless'],
    ['a', '--from', '10:60'], ['a', '--from', '-1:00'], ['a', '--from', '2'], ['a', '--from', '1:2'],
    ['a', '--minutes', '0'], ['a', '--minutes', '-1'], ['a', '--minutes', 'Infinity'], ['a', '--minutes', 'NaN'],
    ['a', '--minutes', '1e309'], ['a', '--minutes', '1', '--minutes', '2'], ['a', '--open', 'run'],
    ['--open', 'run', '--from', '0:00'], ['--open', 'run', '--minutes', '1'], ['--open', 'run', '--them', 'a'],
  ]) assert.throws(() => parseArgs(args), args.join(' '));
});

for (const rate of [8000, 16000, 44100, 48000]) {
  test(`WAV trims at sample boundaries, offsets and lengths at ${rate} Hz`, () => {
    const original = wav(rate, 3), parsed = parseWav(original);
    const all = trimWav(original);
    assert.equal(all.seconds, 3); assert.equal(all.samples, rate * 3);
    assert.deepEqual(parseWav(all.bytes).data, parsed.data);
    const trimmed = trimWav(original, 1, 1 / 60);
    assert.equal(trimmed.seconds, 1); assert.equal(trimmed.sampleRate, rate);
    assert.equal(trimmed.samples, rate);
    assert.deepEqual(parseWav(trimmed.bytes).data, parsed.data.subarray(rate * 2, rate * 4));
    assert.equal(trimWav(original, 2, 10).seconds, 1); // Limits clamp to EOF, never pad or loop.
    const partial = trimWav(original, 1.25, .25 / 60);
    assert.deepEqual(parseWav(partial.bytes).data, parsed.data.subarray(Math.floor(rate * 1.25) * 2, (Math.floor(rate * 1.25) + Math.floor(rate * .25)) * 2));
    assert.throws(() => trimWav(original, 3), /beyond the end/);
    assert.throws(() => trimWav(original, 300), /beyond the end/);
    assert.throws(() => trimWav(original, -1), /Invalid/);
    assert.throws(() => trimWav(original, 0, 0), /Invalid/);
  });
}

function extensible(original: Buffer, validBits: number, format = 1) {
  const result = Buffer.alloc(original.length + 24);
  original.copy(result, 0, 0, 46); original.copy(result, 70, 46);
  result.writeUInt32LE(result.length - 8, 4); result.writeUInt32LE(40, 26);
  result.writeUInt16LE(0xfffe, 30); result.writeUInt16LE(22, 46); result.writeUInt16LE(validBits, 48);
  Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(result, 54);
  result.writeUInt16LE(format, 54);
  return result;
}

function assertPcm16(bytes: Buffer, rate: number, samples: number) {
  const parsed = parseWav(bytes);
  assert.equal(parsed.fmt.length, 16);
  assert.equal(parsed.fmt.readUInt16LE(0), 1); // Plain PCM, not extensible or float.
  assert.equal(parsed.fmt.readUInt16LE(2), 1);
  assert.equal(parsed.fmt.readUInt16LE(14), 16);
  assert.equal(parsed.sampleRate, rate);
  assert.equal(parsed.samples, samples);
  assert.equal(parsed.data.length, samples * 2);
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  return parsed.data;
}

test('24-bit and float32/64 WAVs normalize to PCM16 at the original rate and trim interval', () => {
  for (const rate of [16000, 44100, 48000]) for (const [bits, format] of [[24, 1], [32, 3], [64, 3]]) {
    const input = wav(rate, 2, bits, format);
    const data = parseWav(input).data;
    const values = [0, .5, -.5, 1, -1, .25];
    for (let i = 0; i < rate * 2; i++) {
      const value = values[i % values.length], at = i * bits / 8;
      if (format === 1) data.writeIntLE(Math.min(2 ** (bits - 1) - 1, value * 2 ** (bits - 1)), at, bits / 8);
      else if (bits === 32) data.writeFloatLE(value, at);
      else data.writeDoubleLE(value, at);
    }
    const result = trimWav(input, 1, .5 / 60);
    assert.equal(result.seconds, .5);
    const pcm = assertPcm16(result.bytes, rate, rate / 2);
    for (let i = 0; i < 6; i++) assert.equal(pcm.readInt16LE(i * 2), Math.min(32767, values[(rate + i) % 6] * 32768));
  }
});

test('stereo WAVs downmix channels rather than selecting one, preserving sample count and rate', () => {
  for (const [bits, format] of [[16, 1], [24, 1], [32, 3]]) {
    const input = wav(48000, 1, bits, format, 2), data = parseWav(input).data;
    for (let i = 0; i < 48000; i++) for (let channel = 0; channel < 2; channel++) {
      const value = channel === 0 ? .75 : -.25, at = (i * 2 + channel) * bits / 8;
      if (format === 1) data.writeIntLE(value * 2 ** (bits - 1), at, bits / 8);
      else data.writeFloatLE(value, at);
    }
    const result = trimWav(input, .25, .5 / 60);
    assert.equal(result.seconds, .5);
    const pcm = assertPcm16(result.bytes, 48000, 24000);
    assert.equal(pcm.readInt16LE(0), 8192);
    assert.equal(pcm.readInt16LE(pcm.length - 2), 8192);
  }
});

test('extensible WAVs honor valid bits, normalize the container, and reject compressed subtypes', () => {
  for (const [bits, validBits] of [[16, 16], [24, 20], [32, 24]]) {
    const original = wav(16000, 1, bits), data = parseWav(original).data;
    for (let i = 0; i < 16000; i++) data.writeIntLE((i % 2 ? -.5 : .5) * 2 ** (bits - 1), i * bits / 8, bits / 8);
    const input = extensible(original, validBits);
    const result = trimWav(input, .5);
    assert.equal(result.seconds, .5);
    const pcm = assertPcm16(result.bytes, 16000, 8000);
    assert.equal(pcm.readInt16LE(0), 16384); assert.equal(pcm.readInt16LE(2), -16384);
  }
  assert.throws(() => parseWav(extensible(wav(16000, 1), 16, 6)), /valid, uncompressed WAV/);
  for (const validBits of [0, 17]) assert.throws(() => parseWav(extensible(wav(16000, 1), validBits)), /valid, uncompressed WAV/);
});

test('WAV normalizes odd PCM8 and PCM32; rejects corrupt and compressed inputs', () => {
  for (const bits of [8, 32]) {
    const cut = trimWav(wav(16000, 1, bits), 0, 1 / 16000 / 60);
    assert.equal(cut.samples, 1);
    assertPcm16(cut.bytes, 16000, 1);
  }
  const badAlign = wav(16000, 1); badAlign.writeUInt16LE(2, 32); // Channels changed, block alignment not changed.
  const badSize = wav(16000, 1); badSize.writeUInt32LE(0xffffffff, 50);
  for (const input of [Buffer.from('not a wav'), wav(16000, 1).subarray(0, 70), badAlign, badSize, wav(16000, 1, 16, 6)]) {
    assert.throws(() => parseWav(input), /valid, uncompressed WAV/);
  }
});

test('float conversion clips over-range values and rejects non-finite samples with a plain error', () => {
  const input = wav(16000, 1, 32, 3), data = parseWav(input).data;
  data.writeFloatLE(2, 0); data.writeFloatLE(-2, 4);
  const pcm = assertPcm16(trimWav(input, 0, 2 / 16000 / 60).bytes, 16000, 2);
  assert.equal(pcm.readInt16LE(0), 32767); assert.equal(pcm.readInt16LE(2), -32768);
  for (const value of [NaN, Infinity, -Infinity]) {
    data.writeFloatLE(value, 0);
    assert.throws(() => trimWav(input, 0, 1 / 16000 / 60), /non-finite/);
  }
});
