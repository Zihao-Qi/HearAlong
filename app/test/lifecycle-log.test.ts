import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleLines, idleStopMessage } from '../src/lifecycle-log.ts';

test('idle stop messages distinguish a page that never connected from the last page closing', () => {
  assert.equal(idleStopMessage('no-page'), 'No page ever connected within 60 s and nothing is running: stopping.');
  assert.equal(idleStopMessage('last-page-closed'), 'The last page closed and nothing is running: stopping.');
});

test('lifecycle timestamps are local ISO times with offsets on every line', () => {
  const original = process.env.TZ;
  try {
    for (const [zone, expected] of [
      ['Asia/Kolkata', '2026-01-02T08:34:05+05:30'],
      ['America/Los_Angeles', '2026-01-01T19:04:05-08:00'],
      ['UTC', '2026-01-02T03:04:05+00:00'],
    ]) {
      process.env.TZ = zone;
      const date = new Date('2026-01-02T03:04:05Z');
      assert.equal(lifecycleLines('Starting\r\nData\nReady\rDone', date), ['Starting', 'Data', 'Ready', 'Done'].map(line => `${expected} ${line}`).join('\n'));
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
