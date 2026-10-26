import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/land.ts', import.meta.url));
const nice = execFileSync('which', ['nice'], { encoding: 'utf8' }).trim();
const trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const email = '35388022+Zihao-Qi@users.noreply.github.com';
// Hooks may export repository/index/object/config overrides. Never inherit any
// GIT_* variable into a fixture Git command OR a land/check subprocess.
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
type Scripts = Partial<Record<'check' | 'test' | 'checks', string | undefined>>;
const prefix = `hearalong-land-test-${randomUUID()}-`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const summaryCode = (summary = 'suite-a exit=0\nsuite-b exit=0\nleftover_test_browsers=0\n') =>
  `const fs=require('node:fs'); const out=process.argv[2]; require('node:assert/strict').equal(fs.existsSync(out),false,'checks requires a fresh folder'); fs.mkdirSync(out); fs.writeFileSync(out+'/summary.txt',${JSON.stringify(summary)});`;
const defaults = { check: 'console.log("check passed")', test: 'console.log("test passed")', checks: summaryCode() };
function writePackage(checkout: string, scripts: Scripts = {}, marker = checkout) {
  const selected = { ...defaults, ...scripts };
  const priority = "require('node:assert/strict').ok(Number(require('node:child_process').execFileSync('ps',['-o','nice=','-p',String(process.pid)],{encoding:'utf8'}).trim())>=19);";
  writeFileSync(join(checkout, 'prototype/package.json'), JSON.stringify({ scripts: Object.fromEntries(
    Object.entries(selected).filter(([, code]) => code !== undefined).map(([name, code]) => [name,
      `${quote(process.execPath)} -e ${quote(`${priority} require('node:fs').appendFileSync('../.git/order',${JSON.stringify(name + '\n')}); ${code}`)} -- ${quote(marker)}`]),
  ) }));
}

type Process = { pid: number; ppid: number; pgid: number; command: string };
function processes(): Process[] {
  return execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match && !match[4].startsWith('Z') ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], command: match[5] }] : [];
  });
}
const alive = (pid: number) => processes().some(process => process.pid === pid);
async function stopFixtureProcesses(root: string) {
  const table = processes();
  const owned = new Set(table.filter(process => process.command.includes(root) || process.command.includes(realpathSync(root))).map(process => process.pid));
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const process of table) if (owned.has(process.ppid)) owned.add(process.pid);
  }
  // Kill only recorded fixture processes/descendants, not arbitrary Node processes.
  for (const pid of owned) try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 40 && processes().some(process => owned.has(process.pid)); i++) await delay(50);
  assert.equal(processes().some(process => owned.has(process.pid)), false, 'fixture processes survived cleanup');
}

function fixture(t: TestContext, scripts: Scripts = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // One hook owns teardown: kill children BEFORE removing their PID files/repo.
  t.after(async () => { await stopFixtureProcesses(root); rmSync(root, { recursive: true, force: true }); });
  const main = join(root, 'main'); mkdirSync(main);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const inside = (path: string) => { const rel = relative(realpathSync(root), realpathSync(path)); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `repository escaped fixture: ${path}`); };
  // Before even init: refuse any inherited/discovered repository outside root.
  const existing = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: main, env: gitEnv, encoding: 'utf8' });
  assert.ifError(existing.error);
  if (existing.status === 0) inside(existing.stdout.trim());
  inside(main);
  git(main, 'init', '-b', 'main');
  inside(git(main, 'rev-parse', '--show-toplevel'));
  inside(git(main, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.org');
  git(main, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(main, '.githooks'));
  writeFileSync(join(main, '.githooks/pre-commit'), '#!/bin/sh\nif test -f "$(git rev-parse --git-common-dir)/reject"; then echo "fixture hook rejected" >&2; exit 1; fi\n');
  chmodSync(join(main, '.githooks/pre-commit'), 0o755);
  for (const hook of ['commit-msg', 'pre-push']) {
    writeFileSync(join(main, '.githooks', hook), '#!/bin/sh\nexit 0\n');
    chmodSync(join(main, '.githooks', hook), 0o755);
  }
  writeFileSync(join(main, '.githooks/public-guard.cjs'), '// fixture guard; hooks intentionally use stand-ins\n');
  mkdirSync(join(main, 'prototype/scripts'), { recursive: true });
  writePackage(main, scripts, root);
  writeFileSync(join(main, 'shared.txt'), 'base\n');
  writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\nprototype/node_modules\n*.wav\n');
  git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  const worktree = join(main, '.claude/worktrees/topic');
  git(main, 'worktree', 'add', '-b', 'topic', worktree);
  const head = git(main, 'rev-parse', 'HEAD');
  const change = () => writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  const runWithEnv = (env: NodeJS.ProcessEnv, ...flags: string[]) => {
    const result = spawnSync(nice, ['-n', '19', process.execPath, `--title=${root}`, '--experimental-strip-types', script, 'topic', 'Add topic\n\nDetails', ...flags], {
      cwd: join(main, 'prototype'), env: { ...gitEnv, ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))) }, encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(result.error);
    let output = result.stdout + result.stderr;
    const logs = /logs: (.+)/.exec(output)?.[1]?.trim();
    if (logs) {
      t.after(() => rmSync(logs, { recursive: true, force: true }));
      if (result.status !== 0) for (const name of ['check', 'test', 'checks']) {
        const log = join(logs, `${name}.log`);
        if (existsSync(log)) output += `\n${name} log:\n${readFileSync(log, 'utf8')}`;
      }
    }
    return { status: result.status, output, logs };
  };
  const run = (...flags: string[]) => runWithEnv({}, ...flags);
  const unchanged = () => {
    assert.equal(git(main, 'rev-parse', 'HEAD'), head);
    assert.ok(existsSync(worktree));
    assert.equal(git(main, 'rev-parse', 'topic'), head, 'refusal must not create a commit');
  };
  return { root, main, worktree, git, head, change, run, runWithEnv, unchanged };
}

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
    const file = join(f.worktree, 'prototype', link ? 'node_modules' : 'capture.wav');
    if (link) symlinkSync(dirname(f.main), file, 'dir'); else writeFileSync(file, 'not actual audio');
    if (kind.startsWith('staged')) f.git(f.worktree, 'add', '-f', file);
    if (kind === 'untracked wav') writeFileSync(join(f.worktree, '.gitignore'), '.claude/worktrees/\n');
    const before = f.git(f.worktree, 'status', '--porcelain');
    const r = f.run();
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, link ? /prototype\/node_modules/ : /prototype\/capture\.wav/);
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

function hangingCode(f: ReturnType<typeof fixture>) {
  const child = `require('node:fs').writeFileSync(${JSON.stringify(join(f.main, '.git/check-child-pid'))},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`;
  return mutationCode(f, `fs.writeFileSync(main+'/.git/check-pid',String(process.pid)); process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(f.root)}],{stdio:'inherit'}); setInterval(()=>{},1000)`);
}
function assertCheckStopped(f: ReturnType<typeof fixture>) {
  for (const file of ['check-pid', 'check-child-pid']) {
    const pid = Number(readFileSync(join(f.main, '.git', file), 'utf8'));
    assert.equal(alive(pid), false, `${file} process ${pid} survived command termination`);
  }
}
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

test('slim full runner gets a fresh output folder and prints each suite and browser count', t => {
  const f = fixture(t); f.change();
  const r = f.run('--full'); assert.equal(r.status, 0, r.output); assert.ok(r.logs);
  assert.match(r.output, /suite-a\s+ok/); assert.match(r.output, /suite-b\s+ok/);
  assert.match(r.output, /leftover test browsers\s+0/); assert.doesNotMatch(r.output, /unlisted checks/);
  assert.match(readFileSync(join(r.logs, 'checks/summary.txt'), 'utf8'), /suite-a exit=0/);
  assert.equal(readFileSync(join(f.main, '.git/order'), 'utf8'), 'check\nchecks\n');
  assert.equal(existsSync(join(f.main, 'prototype/artifacts')), false);
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
  assert.equal(existsSync(join(f.main, 'prototype/artifacts')), false);
});

test('full runner leaves an existing ignored audio fixture unchanged', t => {
  const f = fixture(t); f.change(); mkdirSync(join(f.main, 'prototype/artifacts'));
  const wav = join(f.main, 'prototype/artifacts/synthetic-meeting.wav'); writeFileSync(wav, 'fixture bytes');
  const r = f.run('--full'); assert.equal(r.status, 0, r.output); assert.equal(readFileSync(wav, 'utf8'), 'fixture bytes');
});

test('malformed merged npm configuration fails and rolls back', t => {
  const f = fixture(t); writeFileSync(join(f.worktree, 'prototype/package.json'), '{invalid');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.ok(r.logs);
  assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /EJSONPARSE/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.equal(f.git(f.main, 'status', '--porcelain'), '');
  assert.ok(existsSync(f.worktree)); assert.notEqual(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
});

test('a command that cannot spawn is logged and rolls back', t => {
  const f = fixture(t); f.change(); const bin = join(f.main, '.git/bin'); mkdirSync(bin);
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  const r = f.runWithEnv({ PATH: bin }); assert.equal(r.status, 1, r.output); assert.ok(r.logs);
  assert.match(r.output, /check\s+FAIL/); assert.match(readFileSync(join(r.logs, 'check.log'), 'utf8'), /ENOENT/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), f.head); assert.ok(existsSync(f.worktree));
});

test('a clean branch behind main has nothing to land', t => {
  const f = fixture(t); writeFileSync(join(f.main, 'main-only.txt'), 'advanced');
  f.git(f.main, 'add', '-A'); f.git(f.main, 'commit', '-m', 'advance');
  const before = f.git(f.main, 'rev-parse', 'HEAD');
  const r = f.run(); assert.equal(r.status, 1, r.output); assert.match(r.output, /nothing to land/);
  assert.equal(f.git(f.main, 'rev-parse', 'HEAD'), before); assert.ok(existsSync(f.worktree));
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

test('invalid worktree names and timeout arguments refuse without mutations', t => {
  const f = fixture(t); f.change();
  for (const args of [['../topic', 'message'], ['topic', 'message', '--timeout-ms', '0'], ['topic', 'message', '--unknown']]) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { cwd: f.main, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr); f.unchanged();
    assert.equal(f.git(f.worktree, 'diff', '--cached', '--name-only'), '');
  }
});

// Fix-round regressions exercise adversarial actions only inside the fixture repos.
function checkCode(f: ReturnType<typeof fixture>, code: string) { writePackage(f.worktree, { check: code }); }
const mutationCode = (f: ReturnType<typeof fixture>, body: string) => `const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const main=${JSON.stringify(f.main)}, wt=${JSON.stringify(f.worktree)}; const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim(); ${body}`;

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

// Shared machine accounts (CI runners, servers) whose names are ordinary words in the sources, not personal identifiers.
const GENERIC_ACCOUNTS = new Set(['runner', 'root', 'admin', 'user', 'ubuntu', 'ec2-user']);
test('R3 public land sources and both READMEs contain no personal home identifiers', () => {
  const home = userInfo().homedir, account = basename(home);
  const forbidden = [['', 'Users', ''].join('/'), home, ...GENERIC_ACCOUNTS.has(account) ? [] : [account]];
  for (const path of ['../scripts/land.ts', './land.test.ts', '../../README.md', '../README.md']) {
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

test('slim has no duplicate check manifest or source-only manifest machinery', () => {
  assert.equal(existsSync(new URL('../scripts/land-checks.json', import.meta.url)), false);
  const source = readFileSync(script, 'utf8');
  for (const retired of ['readChecks', 'needsWav', '{outdir}', 'unlisted checks']) assert.ok(!source.includes(retired), retired);
});

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
