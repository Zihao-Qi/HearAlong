import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PiRpc } from '../src/pi-rpc.ts';

const fake = () => new PiRpc({
  model: 'fake', cwd: tmpdir(), command: process.execPath,
  args: ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./fixtures/fake-pi.ts', import.meta.url))],
});

test('quick lane answers in order, frames records only on LF, and retries one empty answer', async () => {
  const pi = fake();
  try {
    const [first, second] = await Promise.all([pi.ask('one'), pi.ask('two')]);
    assert.equal(first.text, 'echo: one');
    assert.equal(second.text, 'echo: two');
    assert.equal((await pi.ask('split')).text, 'a b');
    const retried = await pi.ask('empty-once');
    assert.equal(retried.text, 'second try');
    assert.equal(retried.attempts, 2);
  } finally { await pi.close(); }
});

test('quick lane cancels dialogs, times out a stuck run, and restarts for the next request', async () => {
  const logs: string[] = [];
  const pi = fake();
  pi.options.log = message => logs.push(message);
  try {
    assert.equal((await pi.ask('dialog')).text, 'dialog cancelled');
    assert.ok(logs.some(line => line.includes('Cancelled a Pi confirm dialog')));
    await assert.rejects(pi.ask('hang', 300), /did not answer/);
    assert.equal((await pi.ask('after')).text, 'echo: after');
  } finally { await pi.close(); }
  await assert.rejects(pi.ask('closed'), /stopped/);
});

test('a rejected or unacknowledged session reset restarts the process instead of wedging the lane', async () => {
  const pi = fake();
  try {
    const before = (await pi.ask('pid')).text;
    await pi.ask('reset-fails');
    const afterFail = (await pi.ask('pid')).text;
    assert.notEqual(afterFail, before, 'failed reset replaced the process');
    await pi.ask('reset-silent'); // waits out the 10 s acknowledgement deadline, then restarts
    assert.notEqual((await pi.ask('pid')).text, afterFail);
  } finally { await pi.close(); }
});

test('a prompt that is never acknowledged cannot leak its late answer into the next request', async () => {
  const pi = fake();
  pi.options.ackMs = 150;
  try {
    await assert.rejects(pi.ask('no-ack'), /did not acknowledge prompt/);
    const next = await pi.ask('second');
    assert.equal(next.text, 'echo: second');
    await new Promise(resolve => setTimeout(resolve, 500)); // the old child would have answered by now
    assert.equal((await pi.ask('third')).text, 'echo: third');
  } finally { await pi.close(); }
});
