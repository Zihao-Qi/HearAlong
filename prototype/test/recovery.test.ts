import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFraction, normalized, splitPoint, transcribeRecovering, type Pass } from '../src/recovery.ts';

const RATE = 16_000;
function tone(seconds: number, amplitude: number, silentFrom?: number, silentTo?: number) {
  const pcm = new Float32Array(seconds * RATE);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    pcm[i] = silentFrom !== undefined && t >= silentFrom && t < silentTo! ? 0 : amplitude * Math.sin(2 * Math.PI * 220 * t);
  }
  return pcm;
}

test('silence is never retried; loud empty windows try halves, then normalization', async () => {
  const calls: number[] = [];
  const empty = async (pcm: Float32Array): Promise<Pass> => { calls.push(pcm.length); return { text: '', words: [] }; };
  const quiet = await transcribeRecovering(new Float32Array(20 * RATE), empty);
  assert.equal(quiet.retries, 0);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const loud = tone(20, 0.3, 9.5, 10.2); // a pause just before the middle
  const halves = await transcribeRecovering(loud, async pcm => {
    calls.push(pcm.length);
    return calls.length === 3 ? { text: 'second half', words: [{ text: 'second', t0Ms: 100, t1Ms: 400 }] } : { text: '', words: [] };
  });
  assert.equal(halves.recoveredBy, 'halves');
  assert.equal(halves.text, 'second half');
  const cutSeconds = calls[1] / RATE;
  assert.ok(cutSeconds >= 9.5 && cutSeconds <= 10.2, `cut in the pause, got ${cutSeconds}`);
  assert.ok(Math.abs(halves.words[0].t0Ms - (cutSeconds * 1000 + 100)) < 1, 'second-half word times are offset');

  calls.length = 0;
  const louder = await transcribeRecovering(tone(20, 0.05), async pcm => {
    calls.push(pcm.length);
    return calls.length === 4 ? { text: 'recovered', words: [] } : { text: '', words: [] };
  });
  assert.equal(louder.recoveredBy, 'normalized');
  assert.equal(louder.retries, 2);
});

test('normalization has bounded gain and never clips beyond ±1', () => {
  const faint = tone(2, 0.001);
  assert.ok(activeFraction(faint) < 0.15);
  const boosted = normalized(faint);
  const peak = Math.max(...boosted.map(Math.abs));
  assert.ok(peak <= 0.0101 && peak > 0.009, 'gain is capped at +20 dB');
  assert.ok(Math.max(...normalized(tone(2, 0.9), 0, 20).map(Math.abs)) <= 1);
  assert.equal(splitPoint(new Float32Array(0)), 0);
});
