import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTasks, checksShard, splitShards, expectedSeconds, longestFirst, DEFAULT_SECONDS, EXPECTED_SECONDS } from '../scripts/run-checks.ts';

const browser = checkTasks('/out', '/out/audio.wav', true).map(([name]) => name);
const everything = checkTasks('/out', '/out/audio.wav', false).map(([name]) => name);
const seconds = (names: string[]) => names.reduce((sum, name) => sum + expectedSeconds(name), 0);

test('check shards: every task lands in exactly one shard, for 1 to 4 shards', () => {
  for (const names of [browser, everything]) for (let n = 1; n <= 4; n++) {
    const shards = splitShards(names, n, 2);
    assert.equal(shards.length, n);
    assert.deepEqual(shards.flat().sort(), [...names].sort());
    assert.equal(new Set(shards.flat()).size, names.length);
  }
});

test('check shards: the same split on every call, whatever the list order', () => {
  for (let n = 1; n <= 4; n++) {
    const first = splitShards(browser, n, 2);
    assert.deepEqual(splitShards(browser, n, 2), first);
    assert.deepEqual(splitShards([...browser].reverse(), n, 2), first);
  }
});

test('check shards: with the measured table no shard holds more than 1.25 × its even share', () => {
  for (let n = 1; n <= 4; n++) {
    const shares = splitShards(browser, n, 2).map(seconds);
    const limit = 1.25 * seconds(browser) / n;
    assert.ok(shares.every(share => share <= limit), `${n} shards: ${shares.join(', ')} s, limit ${limit.toFixed(0)} s`);
  }
});

test('check shards: every browser task has a measured time, plans is split per window size, and each shard runs longest first', () => {
  assert.deepEqual(browser.filter(name => !Object.hasOwn(EXPECTED_SECONDS, name)), []);
  assert.deepEqual(browser.filter(name => name.startsWith('plans')).sort(), ['plans-1280', 'plans-1280-board400', 'plans-390']);
  const plans = checkTasks('/out', '/out/audio.wav', true).filter(([name]) => name.startsWith('plans')).map(([name, , env]) => [name, env?.PLANS_CHECK_CONFIGS]);
  assert.deepEqual(plans, [['plans-1280', '1280'], ['plans-1280-board400', '1280-board400'], ['plans-390', '390']]);
  for (const shard of splitShards(browser, 3, 2)) assert.deepEqual(shard, longestFirst(shard));
});

test('check shards: an unknown suite gets the default estimate', () => {
  assert.equal(expectedSeconds('a-suite-nobody-measured'), DEFAULT_SECONDS);
  assert.equal(expectedSeconds('constructor'), DEFAULT_SECONDS);
  const shards = splitShards(['a-suite-nobody-measured', 'mini-check'], 1, 2);
  assert.deepEqual(shards, [['mini-check', 'a-suite-nobody-measured']]);
});

test('check shards: MEETING_CHECKS_SHARD is k/n with 1 ≤ k ≤ n ≤ 8, or unset', () => {
  assert.equal(checksShard({}), undefined);
  assert.equal(checksShard({ MEETING_CHECKS_SHARD: '' }), undefined);
  assert.deepEqual(checksShard({ MEETING_CHECKS_SHARD: '1/3' }), { index: 1, count: 3 });
  assert.deepEqual(checksShard({ MEETING_CHECKS_SHARD: '3/3' }), { index: 3, count: 3 });
  assert.deepEqual(checksShard({ MEETING_CHECKS_SHARD: '8/8' }), { index: 8, count: 8 });
  for (const value of ['0/3', '4/3', '1/0', '1/9', '9/9', '1', '3', '1/3 ', ' 1/3', '1/3\n', '01/3', '1/03', '1.0/3', '-1/3', '1-3', '1/3/3', 'a/b', '1 / 3']) {
    assert.throws(() => checksShard({ MEETING_CHECKS_SHARD: value }), /MEETING_CHECKS_SHARD/, value);
  }
  for (const [count, concurrency] of [[0, 2], [9, 2], [1.5, 2], [3, 0], [3, 1.5]]) assert.throws(() => splitShards(browser, count, concurrency));
  assert.throws(() => splitShards(['listen', 'listen'], 1, 2), /unique/);
});
