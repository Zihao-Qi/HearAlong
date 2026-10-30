import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, LEGACY_DATA_NOTICE } from '../src/data-directory.ts';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notice = 'Your meetings are still in prototype/data — move that folder to app/data, then restart';
function fixture(t: TestContext, legacy = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'data-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app'), directory = join(app, 'data'), old = join(root, 'prototype/data');
  fs.mkdirSync(app);
  if (legacy) {
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(join(old, 'fictional-meeting.txt'), 'Fictional meeting. Never open this file during the check.');
  }
  return { root, app, directory, old };
}

// Resolution may only check existence. Fail if it ever tries to read, list, create, change or migrate data.
function existenceOnly<T>(t: TestContext, run: () => T) {
  const calls: string[] = [], exists = fs.existsSync;
  const probe = t.mock.method(fs, 'existsSync', (path: fs.PathLike) => { calls.push(String(path)); return exists(path); });
  const restore = [() => probe.mock.restore()];
  for (const name of ['openSync', 'readSync', 'readFileSync', 'readdirSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'unlinkSync', 'rmdirSync', 'rmSync'] as const) {
    const mock = t.mock.method(fs, name, () => { throw new Error(`Data resolution must not call ${name}`); });
    restore.push(() => mock.mock.restore());
  }
  syncBuiltinESMExports();
  try { return { result: run(), calls }; }
  finally { for (const undo of restore) undo(); syncBuiltinESMExports(); }
}
function snapshot(old: string) {
  // Metadata only, not a read of the fictional meeting or a listing of the old directory.
  return [old, join(old, 'fictional-meeting.txt')].map(path => {
    const { ino, size, mode, atimeMs, mtimeMs, ctimeMs } = fs.lstatSync(path);
    return { ino, size, mode, atimeMs, mtimeMs, ctimeMs };
  });
}

test('missing app/data with legacy meetings refuses with the exact notice and no data access', t => {
  const f = fixture(t), before = snapshot(f.old);
  const { calls } = existenceOnly(t, () => {
    assert.equal(LEGACY_DATA_NOTICE, notice);
    assert.throws(() => dataDirectory(f.app), { message: notice });
  });
  assert.deepEqual(calls, [f.directory, f.old]);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(snapshot(f.old), before);
});

test('new installation with neither data folder resolves app/data without creating it', t => {
  const f = fixture(t, false);
  const { result, calls } = existenceOnly(t, () => dataDirectory(f.app));
  assert.equal(result, f.directory);
  assert.deepEqual(calls, [f.directory, f.old]);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(fs.existsSync(f.old), false);
});

test('already-present app/data takes precedence and does not even probe the legacy folder', t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory);
  const before = snapshot(f.old);
  const { result, calls } = existenceOnly(t, () => dataDirectory(f.app));
  assert.equal(result, f.directory);
  assert.deepEqual(calls, [f.directory]);
  assert.deepEqual(snapshot(f.old), before);
});

test('custom data directory remains supported without probing or touching legacy meetings', t => {
  const f = fixture(t), custom = join(f.root, 'custom-data'), before = snapshot(f.old);
  const { result, calls } = existenceOnly(t, () => dataDirectory(f.app, custom));
  assert.equal(result, custom);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(custom), false);
  assert.deepEqual(snapshot(f.old), before);
});

test('an explicit override resolving to default app/data cannot bypass the legacy notice', t => {
  const f = fixture(t), before = snapshot(f.old);
  const { calls } = existenceOnly(t, () => {
    assert.throws(() => dataDirectory(f.app, join(f.app, 'unused/../data')), { message: notice });
  });
  assert.deepEqual(calls, [f.directory, f.old]);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(snapshot(f.old), before);
});

test('server CLI prints one notice and exits before creating a store when only legacy data exists', async t => {
  const f = fixture(t);
  // Copy code only: ROOT must point at fictional folders, never the owner's real checkout/data.
  fs.cpSync(join(source, 'src'), join(f.app, 'src'), { recursive: true });
  for (const folder of ['node_modules', 'pi-extensions', 'public']) fs.symlinkSync(join(source, folder), join(f.app, folder), 'dir');
  fs.writeFileSync(join(f.app, 'package.json'), '{"type":"module"}');
  const before = snapshot(f.old);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', join(source, 'scripts/check-isolation.ts'), 'src/server.ts'], {
    cwd: f.app, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', NODE_NO_WARNINGS: '1', MEETING_OPEN_BROWSER: '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve); // close includes draining both output streams, unlike exit.
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await completed.catch(() => {});
  });
  const result = { status: await completed, stdout, stderr };
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${notice}\n`);
  assert.equal(fs.existsSync(f.directory), false, 'no log directory, lock, database or empty store was created');
  assert.deepEqual(snapshot(f.old), before);
});
