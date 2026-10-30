import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { prefix, processes, fixture, checkCode, GENERIC_ACCOUNTS } from './helpers/land.ts';


for (const kind of ['dirty main', 'inactive hooks', 'missing worktree', 'nothing to land', 'wrong main branch', 'wrong worktree branch'] as const) {
  test(`land refuses ${kind} before staging or committing`, t => {
    const f = fixture(t);
    if (kind !== 'nothing to land') f.change();
    if (kind === 'dirty main') writeFileSync(join(f.main, 'dirty.txt'), 'untouched');
    if (kind === 'inactive hooks') f.git(f.main, 'config', 'core.hooksPath', '/dev/null');
    if (kind === 'missing worktree') f.git(f.main, 'worktree', 'remove', '--force', f.worktree);
    if (kind === 'wrong main branch') f.git(f.main, 'switch', '-c', 'other');
    if (kind === 'wrong worktree branch') f.git(f.worktree, 'switch', '-c', 'other-topic');
    const r = f.run();
    assert.equal(r.status, 1, r.output);
    const reason = { 'dirty main': /main.*clean|dirty main/i, 'inactive hooks': /hooks inactive.*core\.hooksPath/i,
      'missing worktree': /worktree.*(missing|exist)/i, 'nothing to land': /nothing to land/i,
      'wrong main branch': /main checkout.*main/i, 'wrong worktree branch': /worktree.*branch/i }[kind];
    assert.match(r.output, reason);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
    assert.equal(f.git(f.main, 'rev-parse', 'topic'), f.head);
    if (kind !== 'missing worktree') assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), '');
  });
}

for (const kind of ['untracked wav', 'staged wav', 'ignored wav', 'ignored node_modules link', 'staged node_modules link'] as const) {
  test(`land refuses ${kind} and names it without deleting it`, t => {
    const f = fixture(t); f.change();
    const link = kind.includes('link');
    const file = join(f.worktree, 'app', link ? 'node_modules' : 'capture.wav');
    if (link) symlinkSync(dirname(f.main), file, 'dir'); else writeFileSync(file, 'not actual audio');
    if (kind.startsWith('staged')) f.git(f.worktree, 'add', '-f', file);
    if (kind === 'untracked wav') writeFileSync(join(f.worktree, '.gitignore'), '.claude/worktrees/\n');
    const before = f.git(f.worktree, 'status', '--porcelain');
    const r = f.run();
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, link ? /app\/node_modules/ : /app\/capture\.wav/);
    assert.ok(existsSync(file)); assert.equal(f.git(f.worktree, 'status', '--porcelain'), before);
    f.unchanged();
  });
}

test('land shows commit-hook rejection and stops before merging', t => {
  const f = fixture(t); f.change();
  writeFileSync(join(f.main, '.git/reject'), 'reject');
  const r = f.run();
  assert.equal(r.status, 1, r.output); assert.match(r.output, /fixture hook rejected/);
  f.unchanged();
  assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), 'feature.txt');
});

test('a clean branch behind main has nothing to land', t => {
  const f = fixture(t); writeFileSync(join(f.main, 'main-only.txt'), 'advanced');
  f.git(f.main, 'add', '-A'); f.git(f.main, 'commit', '-m', 'advance');
  const before = f.git(f.main, 'rev-parse', 'HEAD');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /nothing to land/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), before); assert.ok(existsSync(f.worktree));
});

for (const hook of ['pre-commit', 'commit-msg', 'pre-push', 'public-guard.cjs']) {
  for (const kind of ['missing', 'not executable'] as const) {
    if (hook === 'public-guard.cjs' && kind === 'not executable') continue;
    test(`F6 refuses ${kind} ${hook} before staging`, t => {
      const f = fixture(t); f.change();
      const file = join(f.worktree, '.githooks', hook);
      if (kind === 'missing') rmSync(file); else chmodSync(file, 0o644);
      const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /hooks inactive/);
      assert.ok(r.output.includes(hook)); f.unchanged(); assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), '');
    });
  }
}
test('R3 public land sources and both READMEs contain no personal home identifiers', () => {
  const home = userInfo().homedir, account = basename(home);
  const forbidden = [['', 'Users', ''].join('/'), home, ...GENERIC_ACCOUNTS.has(account) ? [] : [account]];
  for (const path of ['../scripts/land.ts', './land.test.ts', './land-checks.test.ts', './land-rollback.test.ts', './land-processes.test.ts', './helpers/land.ts', '../../README.md', '../README.md']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const value of forbidden) assert.ok(!source.includes(value), `${path}: personal home identifier found`);
  }
});

for (const choice of ['environment override', 'empty environment override', 'homedir default'] as const) {
  test(`R3 test Chrome uses ${choice}`, t => {
    const f = fixture(t);
    const home = join(f.main, '.git/disposable-home');
    const override = choice === 'empty environment override' ? '' : join(f.main, '.git/custom test browser');
    const expected = choice === 'homedir default'
      ? join(home, 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
      : override;
    checkCode(f, `require('node:assert/strict').equal(process.env.MEETING_TEST_CHROME, ${JSON.stringify(expected)})`);
    const r = f.runWithEnv({ HOME: home, MEETING_TEST_CHROME: choice === 'homedir default' ? undefined : override });
    assert.equal(r.status, 0, r.output);
  });
}

test('no leftover process contains this test file temp-repo prefix', async () => {
  for (let i = 0; i < 20 && processes().some(process => process.command.includes(prefix)); i++) await delay(50);
  assert.deepEqual(processes().filter(process => process.command.includes(prefix)), []);
});
