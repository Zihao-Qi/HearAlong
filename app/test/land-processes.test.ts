import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { script, nice, gitEnv, prefix, writePackage, processes, alive, stopFixtureProcesses, fixture, hangingCode, assertCheckStopped, checkCode } from './helpers/land.ts';

for (const command of ['check', 'test', 'checks'] as const) {
  test(`timeout ends ${command} and all group members, restores main and retains feature`, t => {
    const f = fixture(t); f.change(); writePackage(f.worktree, { [command]: hangingCode(f) });
    const r = f.run('--timeout-ms', '2000', ...(command === 'checks' ? ['--full'] : []));
    assert.equal(r.status, 1, r.output); assert.match(r.output, new RegExp(`${command}.*timed out`)); assert.ok(r.logs);
    assert.match(readFileSync(join(r.logs, `${command}.log`), 'utf8'), /timed out/i);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
    assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head); assertCheckStopped(f);
  });
}

test('invalid worktree names and timeout arguments refuse without mutations', t => {
  const f = fixture(t); f.change();
  for (const args of [['../topic', 'message'], ['topic', 'message', '--timeout-ms', '0'], ['topic', 'message', '--unknown']]) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { cwd: f.main, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr); f.unchanged();
    assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), '');
  }
});

test('F3 isolation probe', { skip: process.env.LAND_ENV_PROBE !== '1' }, t => {
  const f = fixture(t); f.change(); const r = f.run(); assert.equal(r.status, 0, r.output);
});

test('F3 exported Git repository/index/object/config variables cannot escape fixtures', t => {
  const victim = mkdtempSync(join(tmpdir(), 'land-env-victim-')); t.after(() => rmSync(victim, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: victim, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Victim'); git('config', 'user.email', 'victim@example.org');
  writeFileSync(join(victim, 'keep.txt'), 'untouched'); git('add', '-A'); git('commit', '-m', 'victim');
  const head = git('rev-parse', 'HEAD'), config = readFileSync(join(victim, '.git/config'), 'utf8');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-name-pattern', '^F3 isolation probe$', fileURLToPath(import.meta.url)], {
    cwd: victim, encoding: 'utf8', timeout: 20_000, env: { ...gitEnv, NODE_TEST_CONTEXT: undefined, LAND_ENV_PROBE: '1', GIT_DIR: join(victim, '.git'), GIT_WORK_TREE: victim,
      GIT_COMMON_DIR: join(victim, '.git'), GIT_INDEX_FILE: join(victim, '.git/index'), GIT_OBJECT_DIRECTORY: join(victim, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(victim, '.git/objects'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null'" },
  });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# pass 1\b/, r.stdout + r.stderr);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain'), '');
  assert.equal(readFileSync(join(victim, '.git/config'), 'utf8'), config);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`F7 ${signal} stops the active check group before safe rollback`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    checkCode(f, hangingCode(f));
    const child = spawn(nice, ['-n', '19', process.execPath, `--title=${f.root}`, '--experimental-strip-types', script, 'topic', 'Signal test'], { cwd: f.main, env: gitEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const completed = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      const logs = /logs: (.+)/.exec(output)?.[1]?.trim(); if (logs) rmSync(logs, { recursive: true, force: true });
    });
    for (let i = 0; i < 500 && !existsSync(join(f.main, '.git/check-child-pid')); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(existsSync(join(f.main, '.git/check-child-pid')), output); child.kill(signal);
    const status = await completed;
    assert.equal(status, 1, output); assert.match(output, new RegExp(signal));
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
    assertCheckStopped(f);
    assert.equal(existsSync(join(f.main, '.git/hearalong-land.lock')), false);
  });
}

test('slim fixture teardown ends detached helpers before deleting their repo', async t => {
  const f = fixture(t);
  const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', f.root], { detached: true, stdio: 'ignore' });
  await new Promise<void>((done, reject) => { helper.once('spawn', done); helper.once('error', reject); });
  assert.ok(helper.pid); await stopFixtureProcesses(f.root); assert.equal(alive(helper.pid), false);
});

test('no leftover process contains this test file temp-repo prefix', async () => {
  for (let i = 0; i < 20 && processes().some(process => process.command.includes(prefix)); i++) await delay(50);
  assert.deepEqual(processes().filter(process => process.command.includes(prefix)), []);
});
