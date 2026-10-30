import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { script, trailer, email, prefix, summaryCode, processes, fixture } from './helpers/land.ts';


for (const plan of ['quick', 'moved', 'forced'] as const) {
  test(`land succeeds with ${plan} plan, identities, trailers, logs and cleanup`, t => {
    const f = fixture(t); f.change();
    if (plan === 'moved') {
      writeFileSync(join(f.main, 'main-only.txt'), 'main advanced');
      f.git(f.main, 'add', '-A'); f.git(f.main, 'commit', '-m', 'main moved');
    }
    // The guard installer uses an absolute path; support that as well as .githooks.
    if (plan === 'forced') f.git(f.main, 'config', 'core.hooksPath', join(f.main, '.githooks'));
    const before = f.git(f.main, 'rev-parse', 'HEAD');
    const r = f.run(...(plan === 'forced' ? ['--full'] : []));
    assert.equal(r.status, 0, r.output);
    const count = 2;
    assert.match(r.output, new RegExp(`checks plan\\s+${plan === 'quick' ? 'quick' : 'full'}`));
    assert.match(r.output, new RegExp(`checks\\s+${count}/${count} passed`));
    assert.match(r.output, /hooks\s+active/); assert.match(r.output, /commit\s+[a-f0-9]+\s+\(worktree topic\)/);
    assert.match(r.output, /merge\s+[a-f0-9]+/); assert.match(r.output, /worktree\s+removed/);
    assert.match(r.output, /next\s+update STATUS, then ask the user before pushing/);
    assert.match(r.output, /check\s+ok\s+\d+(?:\.\d+)? s/);
    assert.ok(r.logs); assert.match(r.logs, /hearalong-land\//);
    assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /check passed/);
    assert.equal(existsSync(join(r.logs, 'test.log')), plan === 'quick');
    assert.equal(existsSync(join(r.logs, 'checks.log')), plan !== 'quick');
    assert.equal(readFileSync(join(f.main, '.git/order'), 'utf8'), plan === 'quick' ? 'check\ntest\n' : 'check\nchecks\n');
    assert.equal(existsSync(f.worktree), false);
    assert.equal(f.git(f.main, 'branch', '--list', 'topic'), '');
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD^1'), before);
    assert.match(f.git(f.main, 'log', '-1', '--format=%B'), /Merge topic: Add topic/);
    for (const rev of ['HEAD', 'HEAD^2']) {
      assert.equal(f.git(f.main, 'show', '-s', '--format=%an|%ae|%cn|%ce', rev), `Zihao Qi|${email}|Zihao Qi|${email}`);
      assert.ok(f.git(f.main, 'show', '-s', '--format=%B', rev).includes(trailer));
    }
    assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  });
}

test('land can land an already committed branch without an empty commit', t => {
  const f = fixture(t); f.change(); f.git(f.worktree, 'add', '-A'); f.git(f.worktree, 'commit', '-m', 'existing feature');
  const tip = f.git(f.worktree, 'rev-parse', 'HEAD');
  const r = f.run(); assert.equal(r.status, 0, r.output);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD^2'), tip);
});

test('slim full runner gets a fresh output folder and prints each suite and browser count', t => {
  const f = fixture(t); f.change();
  const r = f.run('--full'); assert.equal(r.status, 0, r.output); assert.ok(r.logs);
  assert.match(r.output, /suite-a\s+ok/); assert.match(r.output, /suite-b\s+ok/);
  assert.match(r.output, /leftover test browsers\s+0/); assert.doesNotMatch(r.output, /unlisted checks/);
  assert.match(readFileSync(join(r.logs, 'checks/summary.txt'), 'utf8'), /suite-a exit=0/);
  assert.equal(readFileSync(join(f.main, '.git/order'), 'utf8'), 'check\nchecks\n');
  assert.equal(existsSync(join(f.main, 'app/artifacts')), false);
});

for (const exit of [0, 1]) {
  test(`slim a failing summary suite causes undo even when runner exit is ${exit}`, t => {
    const f = fixture(t, { checks: `${summaryCode('passing exit=0\nbroken exit=7\nleftover_test_browsers=0\n')} process.exit(${exit})` }); f.change();
    const r = f.run('--full'); assert.equal(r.status, 1, r.output); assert.match(r.output, /broken\s+FAIL/);
    assert.ok(r.logs); assert.match(r.output, /checks\.log/);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
  });
}

test('slim leftover test browsers cause undo with the runner nonzero exit', t => {
  const f = fixture(t, { checks: `${summaryCode('suite-a exit=0\nleftover_test_browsers=2\n')} process.exit(1)` }); f.change();
  const r = f.run('--full'); assert.equal(r.status, 1, r.output);
  assert.match(r.output, /suite-a\s+ok/); assert.match(r.output, /leftover test browsers\s+2/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
});

test('slim missing main checks script refuses before staging or merging', t => {
  const f = fixture(t, { checks: undefined }); f.change();
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /main.*checks script|main.*checks.*script/i);
  f.unchanged(); assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), '');
});

for (const summary of [undefined, 'suite-a exit=0\n', 'not a summary\n']) {
  test(`slim missing or malformed summary ${JSON.stringify(summary)} refuses success`, t => {
    const f = fixture(t, { checks: summary === undefined ? '' : summaryCode(summary) }); f.change();
    const r = f.run('--full'); assert.equal(r.status, 1, r.output); assert.match(r.output, /summary/i);
    assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
  });
}

test('slim quick plan runs check before test and never invokes checks', t => {
  const f = fixture(t); f.change(); const r = f.run(); assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(join(f.main, '.git/order'), 'utf8'), 'check\ntest\n');
});

test('full runner owns audio generation under its output, not main artifacts', t => {
  const f = fixture(t, { checks: `${summaryCode()} require('node:fs').writeFileSync(process.argv[2]+'/synthetic-meeting.wav','fictional fixture');` }); f.change();
  const r = f.run('--full'); assert.equal(r.status, 0, r.output); assert.ok(r.logs);
  assert.equal(readFileSync(join(r.logs, 'checks/synthetic-meeting.wav'), 'utf8'), 'fictional fixture');
  assert.equal(existsSync(join(f.main, 'app/artifacts')), false);
});

test('full runner leaves an existing ignored audio fixture unchanged', t => {
  const f = fixture(t); f.change(); mkdirSync(join(f.main, 'app/artifacts'));
  const wav = join(f.main, 'app/artifacts/synthetic-meeting.wav'); writeFileSync(wav, 'fixture bytes');
  const r = f.run('--full'); assert.equal(r.status, 0, r.output); assert.equal(readFileSync(wav, 'utf8'), 'fixture bytes');
});

test('malformed merged npm configuration fails and rolls back', t => {
  const f = fixture(t); writeFileSync(join(f.worktree, 'app/package.json'), '{invalid');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.ok(r.logs);
  assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /EJSONPARSE/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  assert.ok(existsSync(f.worktree)); assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
});

test('slim has no duplicate check manifest or source-only manifest machinery', () => {
  assert.equal(existsSync(new URL('../scripts/land-checks.json', import.meta.url)), false);
  const source = readFileSync(script, 'utf8');
  for (const retired of ['readChecks', 'needsWav', '{outdir}', 'unlisted checks']) assert.ok(!source.includes(retired), retired);
});

test('no leftover process contains this test file temp-repo prefix', async () => {
  for (let i = 0; i < 20 && processes().some(process => process.command.includes(prefix)); i++) await delay(50);
  assert.deepEqual(processes().filter(process => process.command.includes(prefix)), []);
});
