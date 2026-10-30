import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { script, email, prefix, summaryCode, processes, fixture, checkCode, mutationCode } from './helpers/land.ts';


test('a failing check restores main exactly and retains worktree commit; later checks do not run', t => {
  const f = fixture(t, { check: 'console.error("fictional failure"); process.exit(7)' });
  f.change(); const r = f.run();
  assert.equal(r.status, 1, r.output); assert.match(r.output, /check\s+FAIL/);
  assert.match(r.output, /check.*failed/i); assert.ok(r.logs);
  assert.match(r.output, /check\.log/);
  assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /fictional failure/);
  assert.equal(existsSync(join(r.logs, 'test.log')), false);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
  assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  assert.ok(existsSync(f.worktree)); assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
  assert.equal(f.git(f.worktree, 'status', '--porcelain'), '');
});

test('merge conflicts preserve the index for manual recovery without a verified merge', t => {
  const f = fixture(t); writeFileSync(join(f.worktree, 'shared.txt'), 'topic\n');
  writeFileSync(join(f.main, 'shared.txt'), 'main\n'); f.git(f.main, 'add', '-A'); f.git(f.main, 'commit', '-m', 'conflicting main');
  const before = f.git(f.main, 'rev-parse', 'HEAD');
  const r = f.run(); assert.equal(r.status, 2, r.output); assert.match(r.output, /merge.*failed/i);
  assert.match(r.output, /rollback refused/); assert.match(r.output, new RegExp(`git reset --hard ${before}`));
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), before); assert.match(f.git(f.main, 'status', '--porcelain'), /UU shared.txt/);
  assert.ok(existsSync(f.worktree)); assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
  assert.equal(existsSync(join(f.main, '.git/MERGE_HEAD')), true);
});

test('a command that cannot spawn is logged and rolls back', t => {
  const f = fixture(t); f.change(); const bin = join(f.main, '.git/bin'); mkdirSync(bin);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  const r = f.runWithEnv({ PATH: bin }); assert.equal(r.status, 1, r.output); assert.ok(r.logs);
  assert.match(r.output, /check\s+FAIL/); assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /ENOENT/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
});

test('cleanup failure rolls back main and preserves the dirty worktree', t => {
  const code = "require('node:fs').writeFileSync('../.claude/worktrees/topic/stray.txt', 'keep')";
  const f = fixture(t, { check: code }); f.change();
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /cleanup failed/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
  assert.equal(readFileSync(join(f.worktree, 'stray.txt'), 'utf8'), 'keep');
  assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
});

test('branch deletion failure restores the removed worktree and rolls back main', t => {
  const f = fixture(t); f.change();
  f.git(f.main, 'branch', 'upstream', 'main');
  f.git(f.main, 'branch', '--set-upstream-to=upstream', 'topic');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /cleanup failed/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
  assert.equal(readFileSync(join(f.worktree, 'feature.txt'), 'utf8'), 'feature\n');
  assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
});

for (const change of ['working tree', 'index', 'HEAD', 'branch', 'successful check edits main'] as const) {
  test(`F1 rollback ownership preserves concurrent main ${change}`, t => {
    const f = fixture(t);
    const mutations = {
      'working tree': "fs.writeFileSync(main+'/shared.txt','concurrent edit')",
      'index': "fs.writeFileSync(main+'/shared.txt','concurrent staged'); git(main,'add','shared.txt')",
      'HEAD': "fs.writeFileSync(main+'/shared.txt','concurrent commit'); git(main,'add','shared.txt'); git(main,'commit','-m','concurrent'); fs.writeFileSync(main+'/.git/concurrent-head',git(main,'rev-parse','HEAD'))",
      'branch': "git(main,'switch','-c','concurrent')",
      'successful check edits main': "fs.writeFileSync(main+'/shared.txt','concurrent success')",
    }[change];
    checkCode(f, mutationCode(f, `${mutations}; ${change === 'successful check edits main' ? '' : 'process.exit(7)'}`));
    const r = f.run(); assert.equal(r.status, 2, r.output);
    assert.match(r.output, /rollback refused/i); assert.match(r.output, new RegExp(`git reset --hard ${f.head}`));
    assert.match(r.output, /only if.*user|user.*decides/i); assert.ok(existsSync(f.worktree));
    if (change === 'HEAD') assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), readFileSync(join(f.main, '.git/concurrent-head'), 'utf8'));
    else assert.notEqual(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
    if (change === 'branch') assert.equal(f.git(f.main, 'branch', '--show-current'), 'concurrent');
    if (change === 'working tree' || change === 'index' || change === 'successful check edits main') assert.match(readFileSync(join(f.main, 'shared.txt'), 'utf8'), /concurrent/);
    if (change === 'index') assert.equal(f.git(f.main, 'diff', '--cached', '--name-only'), 'shared.txt');
  });
}

test('F1 main is rechecked immediately before merge without resetting hook-created edits', t => {
  const f = fixture(t); f.change();
  writeFileSync(join(f.worktree, '.githooks/pre-commit'), '#!/bin/sh\ncommon=$(git rev-parse --path-format=absolute --git-common-dir)\nprintf concurrent > "${common%/*}/shared.txt"\n');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /main.*clean/i);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
  assert.equal(readFileSync(join(f.main, 'shared.txt'), 'utf8'), 'concurrent'); assert.ok(existsSync(f.worktree));
});

test('F1 a second land run is refused by the shared lock and the lock is released', t => {
  const f = fixture(t);
  const code = `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,['--experimental-strip-types',${JSON.stringify(script)},'topic','Second'],{cwd:'..',encoding:'utf8'}); require('node:assert/strict').match(r.stdout+r.stderr,/another land run|land.*lock/i); if(r.status!==1) process.exit(9)`;
  checkCode(f, code); const r = f.run(); assert.equal(r.status, 0, r.output);
  assert.equal(existsSync(join(f.main, '.git/hearalong-land.lock')), false);
});

for (const kind of ['detached', 'advanced with upstream'] as const) {
  test(`F2 cleanup preserves an intervening ${kind} feature commit`, t => {
    const f = fixture(t);
    const detach = kind === 'detached' ? "git(wt,'switch','--detach');" : '';
    const upstream = kind === 'advanced with upstream' ? "git(main,'branch','late-upstream','refs/heads/topic'); git(wt,'branch','--set-upstream-to=late-upstream','topic');" : '';
    checkCode(f, mutationCode(f, `${detach} fs.writeFileSync(wt+'/late.txt','late work'); git(wt,'add','late.txt'); git(wt,'commit','-m','late work'); ${upstream} fs.writeFileSync(main+'/.git/late-head',git(wt,'rev-parse','HEAD'));`));
    const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /cleanup.*(changed|pinned|branch|HEAD)/i);
    assert.ok(existsSync(f.worktree)); assert.equal(readFileSync(join(f.worktree, 'late.txt'), 'utf8'), 'late work');
    assert.equal(f.git(f.worktree, 'rev-parse', 'HEAD'), readFileSync(join(f.main, '.git/late-head'), 'utf8'));
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
  });
}

for (const kind of ['file', 'ignored file', 'directory', 'dangling symlink'] as const) {
  test(`R2 rollback preserves a ${kind} at a feature-deleted tracked path`, t => {
    const f = fixture(t);
    rmSync(join(f.worktree, 'shared.txt'));
    const create = {
      'file': "fs.writeFileSync(main+'/shared.txt','concurrent replacement')",
      'ignored file': "fs.appendFileSync(main+'/.git/info/exclude','\\n/shared.txt\\n'); fs.writeFileSync(main+'/shared.txt','concurrent replacement')",
      'directory': "fs.mkdirSync(main+'/shared.txt'); fs.writeFileSync(main+'/shared.txt/new.txt','concurrent replacement')",
      'dangling symlink': "fs.symlinkSync('missing-target',main+'/shared.txt')",
    }[kind];
    checkCode(f, mutationCode(f, `${create}; process.exit(7)`));
    const r = f.run(); assert.equal(r.status, 2, r.output);
    assert.match(r.output, /rollback refused.*obstruct/i); assert.match(r.output, /shared\.txt/);
    assert.match(r.output, new RegExp(`git reset --hard ${f.head}`));
    assert.match(r.output, /only if the user decides/);
    assert.notEqual(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
    assert.ok(existsSync(f.worktree)); assert.equal(existsSync(join(f.main, '.git/hearalong-land.lock')), false);
    if (kind === 'dangling symlink') {
      assert.ok(lstatSync(join(f.main, 'shared.txt')).isSymbolicLink());
      assert.equal(readlinkSync(join(f.main, 'shared.txt')), 'missing-target');
    } else {
      assert.equal(readFileSync(join(f.main, 'shared.txt', ...(kind === 'directory' ? ['new.txt'] : [])), 'utf8'), 'concurrent replacement');
    }
    if (kind === 'ignored file') assert.equal(f.git(f.main, 'check-ignore', 'shared.txt'), 'shared.txt');
  });
}

test('R2 rollback preserves an untracked parent file blocking a restored descendant', t => {
  const f = fixture(t);
  mkdirSync(join(f.main, 'restore-dir')); writeFileSync(join(f.main, 'restore-dir/old.txt'), 'old');
  f.git(f.main, 'add', '-A'); f.git(f.main, 'commit', '-m', 'track nested file');
  f.git(f.worktree, 'merge', '--ff-only', 'refs/heads/main');
  const before = f.git(f.main, 'rev-parse', 'HEAD');
  rmSync(join(f.worktree, 'restore-dir'), { recursive: true });
  checkCode(f, mutationCode(f, "fs.writeFileSync(main+'/restore-dir','concurrent parent'); process.exit(7)"));
  const r = f.run(); assert.equal(r.status, 2, r.output);
  assert.match(r.output, /rollback refused.*obstruct.*restore-dir/i);
  assert.equal(readFileSync(join(f.main, 'restore-dir'), 'utf8'), 'concurrent parent');
  assert.notEqual(f.git(f.main, 'rev-parse', 'HEAD'), before); assert.ok(existsSync(f.worktree));
});

test('R2 unrelated untracked files still allow normal rollback and are retained', t => {
  const f = fixture(t); rmSync(join(f.worktree, 'shared.txt'));
  checkCode(f, mutationCode(f, "fs.writeFileSync(main+'/unrelated.txt','keep unrelated'); fs.mkdirSync(main+'/unrelated-dir'); fs.writeFileSync(main+'/unrelated-dir/new.txt','keep directory'); process.exit(7)"));
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /main restored/);
  assert.doesNotMatch(r.output, /rollback refused/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head);
  assert.equal(readFileSync(join(f.main, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(f.main, 'unrelated.txt'), 'utf8'), 'keep unrelated');
  assert.equal(readFileSync(join(f.main, 'unrelated-dir/new.txt'), 'utf8'), 'keep directory');
  assert.ok(existsSync(f.worktree));
});

test('F4 same-named tags cannot change the pinned feature branch merge', t => {
  const f = fixture(t); f.change(); f.git(f.worktree, 'add', '-A'); f.git(f.worktree, 'commit', '-m', 'feature');
  const feature = f.git(f.worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(f.worktree, 'unwanted.txt'), 'must not land'); f.git(f.worktree, 'add', '-A'); f.git(f.worktree, 'commit', '-m', 'extra');
  f.git(f.worktree, 'tag', 'topic'); f.git(f.worktree, 'tag', 'main'); f.git(f.worktree, 'reset', '--hard', feature);
  const r = f.run(); assert.equal(r.status, 0, r.output);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^2'), feature); assert.equal(existsSync(join(f.main, 'unwanted.txt')), false);
  assert.match(r.output, /checks plan\s+quick/);
});

for (const option of ['--strategy=ours', '--no-commit', '--squash']) {
  test(`F5 inherited merge option ${option} cannot change the required merge`, t => {
    const f = fixture(t); f.change(); f.git(f.main, 'config', 'branch.main.mergeOptions', option);
    const r = f.run(); assert.equal(r.status, 0, r.output);
    assert.equal(readFileSync(join(f.main, 'feature.txt'), 'utf8'), 'feature\n');
    const parents = f.git(f.main, 'show', '-s', '--format=%P', 'HEAD').split(' ');
    assert.equal(parents.length, 2); assert.equal(parents[0], f.head);
  });
}

test('F5 inherited --no-verify cannot bypass the merge message hook', t => {
  const f = fixture(t); f.change(); f.git(f.main, 'config', 'branch.main.mergeOptions', '--no-verify');
  const hook = '#!/bin/sh\nif grep -q "^Merge " "$1"; then common=$(git rev-parse --path-format=absolute --git-common-dir); touch "$common/merge-hook-ran"; echo "merge hook rejected" >&2; exit 1; fi\n';
  // The incoming hook becomes effective before Git prepares the merge commit.
  writeFileSync(join(f.worktree, '.githooks/commit-msg'), hook);
  const r = f.run(); assert.notEqual(r.status, 0, r.output); assert.match(r.output, /merge hook rejected/);
  assert.ok(existsSync(join(f.main, '.git/merge-hook-ran'))); assert.ok(existsSync(f.worktree));
});

test('F5 a quick tree mismatch explicitly switches to all full checks', t => {
  const f = fixture(t, { checks: `${summaryCode('extra exit=7\nleftover_test_browsers=0\n')} process.exit(1)` });
  f.change();
  writeFileSync(join(f.worktree, '.githooks/post-merge'), '#!/bin/sh\nprintf hook-added > hook-added.txt\ngit add hook-added.txt\nold=$(git rev-parse HEAD)\ntree=$(git write-tree)\nfirst=$(git rev-parse HEAD^1)\nsecond=$(git rev-parse HEAD^2)\ncommit=$(git commit-tree "$tree" -p "$first" -p "$second" -m hook-merge)\ngit update-ref HEAD "$commit" "$old"\n');
  chmodSync(join(f.worktree, '.githooks/post-merge'), 0o755);
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /full.*tree|tree.*full/i);
  assert.match(r.output, /extra\s+FAIL/); assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
});

test('F5 unexpected merge parents refuse reset and preserve the new HEAD', t => {
  const f = fixture(t); f.change();
  writeFileSync(join(f.worktree, '.githooks/post-merge'), '#!/bin/sh\ngit -c user.name=Fixture -c user.email=fixture@example.org commit --allow-empty -m intervening\n');
  chmodSync(join(f.worktree, '.githooks/post-merge'), 0o755);
  const r = f.run(); assert.equal(r.status, 2, r.output); assert.match(r.output, /parents/);
  assert.equal(f.git(f.main, 'log', '-1', '--format=%s'), 'intervening'); assert.ok(existsSync(f.worktree));
});

test('no leftover process contains this test file temp-repo prefix', async () => {
  for (let i = 0; i < 20 && processes().some(process => process.command.includes(prefix)); i++) await delay(50);
  assert.deepEqual(processes().filter(process => process.command.includes(prefix)), []);
});
