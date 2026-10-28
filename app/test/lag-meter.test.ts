import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LagMeter } from '../scripts/lag-meter.ts';

test('lag is per line: from when its audio reached the server to when it first shows; silence is never lag', () => {
  const meter = new LagMeter();
  for (let s = 1; s <= 60; s++) meter.audio('mic:a', s * 1000, 100_000 + s * 1000); // a second of audio arrives every second
  // A line ending at 20 s first shows at 135 s: its audio was there at 120 s, so 15 s late. Seen again later: no new sample.
  const one = meter.poll({ segments: [{ id: 's1', endMs: 20_000, source: 'mic:a' }], drafts: [] }, 135_000);
  assert.deepEqual(one.final, [15_000]);
  assert.deepEqual(meter.poll({ segments: [{ id: 's1', endMs: 20_000, source: 'mic:a' }], drafts: [] }, 200_000).final, []);
  // The preview: each growth of a window's coverage, including through silence (no words needed).
  const window = { source: 'mic:a', window: 'w1', windowStartMs: 40_000 };
  assert.deepEqual(meter.poll({ segments: [], drafts: [{ ...window, coveredUntilMs: 40_000 }] }, 141_000).draft, [], 'nothing covered yet');
  assert.deepEqual(meter.poll({ segments: [], drafts: [{ ...window, coveredUntilMs: 42_000 }] }, 143_500).draft, [1500]);
  assert.deepEqual(meter.poll({ segments: [], drafts: [{ ...window, coveredUntilMs: 42_000 }] }, 150_000).draft, [], 'no growth, no sample');
  // Text for audio that has not arrived (another source, or later) gives no sample.
  assert.deepEqual(meter.poll({ segments: [{ id: 's2', endMs: 90_000, source: 'mic:a' }, { id: 's3', endMs: 5000, source: 'tab:b' }], drafts: [] }, 160_000).final, []);
});
