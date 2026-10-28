import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunFiles } from '../scripts/rehearsal-input.ts';

const sourceApp = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The CLI derives its allowed runs directory from its own location. Give each invocation test
// disposable copies of the validation scripts and their browser guard so concurrent suites cannot change its snapshot.
async function cli(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rehearsal-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(join(app, 'scripts'), { recursive: true });
  for (const name of ['rehearse.ts', 'rehearsal-input.ts', 'test-browser.ts']) await copyFile(join(sourceApp, 'scripts', name), join(app, 'scripts', name));
  await writeFile(join(app, 'package.json'), '{"type":"module"}');
  await symlink(join(sourceApp, 'node_modules'), join(app, 'node_modules'));
  return { app, runs: join(app, 'artifacts/rehearsal/runs') };
}
const targets = ['meetings.sqlite', 'meetings.sqlite-wal', 'meetings.sqlite-shm', 'settings.json', 'audio/mic.wav', 'audio/nested/tab.wav'];

test('run validation accepts ordinary files but refuses hard links in databases, sidecars, settings and audio', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'rehearsal-files-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const folder = join(temporary, 'run'), original = join(temporary, 'original');
  await mkdir(join(folder, 'audio/nested'), { recursive: true });
  await writeFile(original, 'isolated test data, not the user database');
  for (const target of targets) await writeFile(join(folder, target), 'ordinary file');
  await validateRunFiles(folder); // Directory link counts greater than one are normal, not file aliases.
  for (const target of targets) {
    const path = join(folder, target);
    await unlink(path); await link(original, path);
    assert.equal((await lstat(path)).nlink, 2);
    await assert.rejects(validateRunFiles(folder), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `A rehearsal run must not contain hard-linked files: ${path}`);
      return true;
    });
    await unlink(path); await writeFile(path, 'ordinary file');
  }
  await symlink(original, join(folder, 'alias'));
  await assert.rejects(validateRunFiles(folder), /must not contain symlinks/);
});

test('--open refuses hard-linked regular files with a plain error before creating server resources', async t => {
  const { app, runs } = await cli(t);
  await mkdir(runs, { recursive: true });
  const folder = await mkdtemp(join(runs, 'hardlink-test-'));
  const temporary = await mkdtemp(join(tmpdir(), 'rehearsal-original-'));
  t.after(async () => { await rm(folder, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); });
  await mkdir(join(folder, 'audio/nested'), { recursive: true });
  const original = join(temporary, 'original');
  await writeFile(original, 'isolated test data');
  await writeFile(join(folder, 'meetings.sqlite'), 'not opened');
  const before = await lstat(original);
  for (const target of targets) {
    const path = join(folder, target);
    await rm(path, { force: true }); await link(original, path);
    const contents = await readdir(folder);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/rehearse.ts', '--open', folder, '--headless'], {
      cwd: app, encoding: 'utf8', timeout: 60_000,
      // Exists everywhere Node runs; it must never be launched as a browser because validation must fail first.
      env: { ...process.env, MEETING_TEST_CHROME: process.execPath },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), `A rehearsal run must not contain hard-linked files: ${path}`);
    assert.deepEqual(await readdir(folder), contents); // No server.lock, scratch folder, or other startup files.
    assert.equal((await lstat(original)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(original, 'utf8'), 'isolated test data');
    await unlink(path);
    if (target === 'meetings.sqlite') await writeFile(path, 'not opened');
  }
});

test('compressed WAVs fail plainly before creating run/server/browser resources', async t => {
  const { app, runs } = await cli(t);
  const temporary = await mkdtemp(join(tmpdir(), 'rehearsal-compressed-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const input = Buffer.alloc(46);
  input.write('RIFF'); input.writeUInt32LE(38, 4); input.write('WAVE', 8);
  input.write('fmt ', 12); input.writeUInt32LE(16, 16); input.writeUInt16LE(6, 20);
  input.writeUInt16LE(1, 22); input.writeUInt32LE(16000, 24); input.writeUInt32LE(32000, 28);
  input.writeUInt16LE(2, 32); input.writeUInt16LE(16, 34); input.write('data', 36); input.writeUInt32LE(2, 40);
  const path = join(temporary, 'compressed.wav'); await writeFile(path, input);
  const before = await readdir(runs).catch(() => []);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/rehearse.ts', path, '--headless'], {
    cwd: app, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MEETING_TEST_CHROME: '/no/test-chrome' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), `${path}: Expected a valid, uncompressed WAV file.`);
  assert.deepEqual(await readdir(runs).catch(() => []), before);
});
