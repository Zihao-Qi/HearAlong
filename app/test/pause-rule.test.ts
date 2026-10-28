import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryAt, chooseWindowCut, dbfs, pauseThreshold, RATE, RULES, type Boundary } from '../src/pause-rule.ts';
import { chooseCut } from '../src/live.ts';
const frames = (n: number) => Array.from({ length: n }, () => ({ samples: RATE }));
const b = (pause = false, quietness = 1): Boundary => ({ pause, quietness, todayLoudness: quietness, threshold: -50, leftDb: -20, rightDb: -20 });

test('RMS dBFS, silence and strict two-sided threshold', () => {
  assert.ok(Math.abs(dbfs(new Float32Array(3200).fill(.1)) + 20) < .00001);
  assert.equal(dbfs(new Float32Array(3200)), -Infinity);
  const audio = new Float32Array(2 * RATE).fill(.1);
  audio.fill(0, RATE - 3200, RATE + 3200);
  assert.equal(boundaryAt(audio, RATE).pause, true);
  audio.fill(.1, RATE, RATE + 3200);
  assert.equal(boundaryAt(audio, RATE).pause, false, 'both sides must be quiet');
  assert.throws(() => boundaryAt(audio.subarray(0, RATE), RATE), /right-hand/);
});
test('startup is -50 until 50 blocks, nearest-rank tenth percentile over last 50, clamped floor+6', () => {
  assert.equal(pauseThreshold(Array(49).fill(-90)), -50);
  assert.equal(pauseThreshold(Array(50).fill(-50)), -44);
  assert.equal(pauseThreshold(Array(50).fill(-90)), -60);
  assert.equal(pauseThreshold(Array(50).fill(-20)), -38);
  assert.equal(pauseThreshold(Array(50).fill(-Infinity)), -60);
  assert.equal(pauseThreshold([...Array(4).fill(-90), ...Array(46).fill(-51)]), -45);
  assert.equal(pauseThreshold([...Array(50).fill(-90), ...Array(50).fill(-48)]), -42, 'old blocks leave the floor');
  assert.equal(boundaryAt(new Float32Array(9 * RATE), 8 * RATE).threshold, -50);
  assert.equal(boundaryAt(new Float32Array(10 * RATE), 9 * RATE).threshold, -60);
});
test('sources and source restart history do not share or reset their floor', () => {
  const quiet = new Float32Array(11 * RATE).fill(.001), loud = new Float32Array(11 * RATE).fill(.1);
  assert.ok(Math.abs(boundaryAt(quiet, 10 * RATE).threshold + 54) < .001);
  assert.equal(boundaryAt(loud, 10 * RATE).threshold, -38);
  const recovered = quiet.slice(-10 * RATE);
  assert.equal(boundaryAt(recovered, 9 * RATE).threshold, boundaryAt(quiet, 10 * RATE).threshold);
});
test('pause: first eligible at MIN, never judge a boundary without the right-hand frame', () => {
  const rule = RULES[1];
  assert.equal(chooseWindowCut(rule, frames(8), () => { throw new Error('not eligible'); }), null);
  assert.equal(chooseWindowCut(rule, frames(9), () => b(true)), 8);
  assert.equal(chooseWindowCut(rule, frames(11), i => b(i >= 9)), 9);
  assert.equal(chooseWindowCut(rule, frames(10), i => b(i === 7)), null);
});
test('MAX fallback uses quietest eligible boundary, later on ties, not MAX without lookahead', () => {
  const rule = RULES[1];
  assert.equal(chooseWindowCut(rule, frames(11), () => b()), null);
  assert.equal(chooseWindowCut(rule, frames(12), i => { assert.ok(i >= 8 && i <= 11); return b(false, i === 9 ? .01 : 1); }), 9);
  assert.equal(chooseWindowCut(rule, frames(12), () => b()), 11);
  assert.equal(chooseWindowCut(rule, frames(13), i => b(false, i === 12 ? .01 : 1)), 12);
});
test('today delegates existing chooseCut, fixed 12 needs no lookahead; end/idle take all', () => {
  const f = frames(24), ev = (i: number) => b(false, i === 19 ? .01 : 1);
  assert.equal(chooseWindowCut(RULES[0], frames(23), ev), null);
  assert.equal(chooseWindowCut(RULES[0], f, ev), chooseCut(f, i => ev(i).todayLoudness));
  assert.equal(chooseWindowCut(RULES[3], frames(11), ev), null);
  assert.equal(chooseWindowCut(RULES[3], frames(12), ev), 12);
  for (const r of RULES) {
    assert.equal(chooseWindowCut(r, [{ samples: 5000 }], ev, true), 1);
    assert.equal(chooseWindowCut(r, [], ev, true), null);
  }
});
