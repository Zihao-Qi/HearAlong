import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnGated } from '../pi-extensions/process-groups.ts';

test('spawnGated kills its still-live group and rethrows a record-write failure before releasing the command', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'gated-write-failure-'));
  const marker = join(directory, 'command-ran');
  const dir = join(directory, 'processes');
  const failure = new Error('fictional process record disk outage');
  const spawn = childProcess.spawn, writeFile = fs.writeFile;
  let child: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  let recordWrites = 0;
  const spawned = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const result = spawn(...args);
    if (args[0] === '/bin/sh') { child = result; exited = once(result, 'exit'); }
    return result;
  });
  const written = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
    if (String(args[0]).startsWith(join(dir, 'fiction-'))) {
      recordWrites++;
      const record = JSON.parse(String(args[1]));
      assert.ok(child?.pid);
      assert.equal(record.pid, child.pid);
      assert.equal(record.pgid, child.pid);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.doesNotThrow(() => process.kill(child!.pid!, 0), 'the gated shell is still alive at the failing write');
      await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
      throw failure;
    }
    return writeFile(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(spawnGated('/bin/sh', ['-c', 'printf ran > "$1"', 'fictional-command', marker], {
      dir, kind: 'fiction', cwd: directory, stdio: ['ignore', 'ignore', 'ignore'],
    }), error => error === failure);
    assert.equal(recordWrites, 1);
    assert.ok(child && exited);
    // Bounded wait: if cleanup is broken, finally kills/reaps our own unreleased child.
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('gated group survived the failed record write')), 2000);
      })]);
      assert.deepEqual(outcome, [null, 'SIGKILL']);
    } finally { clearTimeout(timer); }
    assert.throws(() => process.kill(-child!.pid!, 0), { code: 'ESRCH' }, 'no group remains');
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the command never ran');
    assert.deepEqual(await fs.readdir(dir), [], 'no successful record was written');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await exited;
    spawned.mock.restore(); written.mock.restore(); syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
