import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as checks from '../scripts/run-checks.ts';

test('check runner: default two slots, optional single slot for a shared development machine', () => {
  assert.equal(checks.suiteConcurrency({}), 2);
  assert.equal(checks.suiteConcurrency({ MEETING_CHECK_CONCURRENCY: '1' }), 1);
  assert.equal(checks.suiteConcurrency({ MEETING_CHECK_CONCURRENCY: '2' }), 2);
  assert.throws(() => checks.suiteConcurrency({ MEETING_CHECK_CONCURRENCY: '3' }), /MEETING_CHECK_CONCURRENCY/);
});
