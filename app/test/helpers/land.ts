import { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';


const script = fileURLToPath(new URL('../../scripts/land.ts', import.meta.url));
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
  writeFileSync(join(checkout, 'app/package.json'), JSON.stringify({ scripts: Object.fromEntries(
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
  mkdirSync(join(main, 'app/scripts'), { recursive: true });
  writePackage(main, scripts, root);
  writeFileSync(join(main, 'shared.txt'), 'base\n');
  writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\napp/node_modules\n*.wav\n');
  git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  const worktree = join(main, '.claude/worktrees/topic');
  git(main, 'worktree', 'add', '-b', 'topic', worktree);
  const head = git(main, 'rev-parse', 'HEAD');
  const change = () => writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  const runWithEnv = (env: NodeJS.ProcessEnv, ...flags: string[]) => {
    const result = spawnSync(nice, ['-n', '19', process.execPath, `--title=${root}`, '--experimental-strip-types', script, 'topic', 'Add topic\n\nDetails', ...flags], {
      cwd: join(main, 'app'), env: { ...gitEnv, ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))) }, encoding: 'utf8', timeout: 20_000,
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

// Fix-round regressions exercise adversarial actions only inside the fixture repos.
function checkCode(f: ReturnType<typeof fixture>, code: string) { writePackage(f.worktree, { check: code }); }
const mutationCode = (f: ReturnType<typeof fixture>, body: string) => `const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const main=${JSON.stringify(f.main)}, wt=${JSON.stringify(f.worktree)}; const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim(); ${body}`;

// Shared machine accounts (CI runners, servers) whose names are ordinary words in the sources, not personal identifiers.
const GENERIC_ACCOUNTS = new Set(['runner', 'root', 'admin', 'user', 'ubuntu', 'ec2-user']);

export { script, nice, trailer, email, gitEnv, prefix, summaryCode, writePackage, processes, alive, stopFixtureProcesses, fixture, hangingCode, assertCheckStopped, checkCode, mutationCode, GENERIC_ACCOUNTS };
