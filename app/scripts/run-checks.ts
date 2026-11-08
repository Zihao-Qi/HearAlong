// Two low-priority suite slots, isolated state, bounded lifetime and retained logs.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, appendFile, access, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { testBrowser } from './test-browser.ts';
import { checkAudio } from './check-audio.ts';

type SuiteOptions = {
  out: string; env: NodeJS.ProcessEnv; summary: string; running: Set<number>;
  timeoutMs?: number; graceMs?: number;
};
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { /* already exited */ } };
const execute = promisify(execFile);
function exists(id: number, group = true) {
  try { process.kill(group ? -id : id, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // Not proof of exit: retain ownership through the bounded grace.
    throw error;
  }
}
async function waitForExit(id: number, graceMs: number, group = true) {
  const until = Date.now() + graceMs;
  while (exists(id, group) && Date.now() < until) await delay(Math.min(50, Math.max(1, until - Date.now())));
}
async function endGroup(pid: number, graceMs: number) {
  signal(pid, 'SIGTERM');
  await waitForExit(pid, graceMs);
  if (exists(pid)) {
    signal(pid, 'SIGKILL');
    await waitForExit(pid, graceMs); // Bound the wait even for a group containing unreaped zombies.
  }
}
async function endBrowsers(directories: string[], chrome: string | undefined, graceMs: number, running: Set<number>) {
  if (!chrome) return;
  const executables = new Set([resolve(chrome), await realpath(chrome)]);
  const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
  for (let pass = 0; pass < 2; pass++) {
    const { stdout } = await execute('ps', ['-ww', '-axo', 'pid=,pgid=,command='], { maxBuffer: 8 * 1024 * 1024 });
    const owned: { pid: number; group: boolean }[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const [, pid, pgid, command] = match;
      if (![...executables].some(path => command.startsWith(path + ' ') || command.startsWith(`"${path}" `))) continue;
      const profile = /\s--user-data-dir=(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s--|\sabout:blank(?:\s|$)|$)/.exec(command);
      const path = profile && (profile[1] ?? profile[2] ?? profile[3]);
      // Reject other suites/user profiles before even resolving their paths on disk.
      if (!path || !isAbsolute(path)) continue;
      const root = directories.find(root => within(resolve(path), root));
      if (!root) continue;
      const canonical = await realpath(path).catch(() => resolve(directories[0], relative(root, resolve(path))));
      if (!within(canonical, directories[0])) continue;
      owned.push({ pid: Number(pid), group: pid === pgid });
    }
    if (!owned.length) return;
    for (const { pid, group } of owned) {
      if (group) { running.add(pid); signal(pid, 'SIGKILL'); }
      else try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    await Promise.all(owned.map(({ pid, group }) => waitForExit(pid, graceMs, group)));
    for (const { pid, group } of owned) if (group) running.delete(pid);
  }
}
/** A suite: its name, its command and any environment of its own on top of the runner's isolated one. */
export type Task = [name: string, command: string[], env?: NodeJS.ProcessEnv];
/** The runner's isolated environment plus a task's own variables, which may only add names the runner does not set. */
export function suiteEnvironment(name: string, env: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  for (const key of Object.keys(own)) {
    if (Object.hasOwn(env, key) || key === 'TMPDIR' || key === 'TMP' || key === 'TEMP') {
      throw new Error(`Task ${name} may not set ${key}: the runner's isolated environment sets it.`);
    }
  }
  return { ...env, ...own };
}
export async function runSuite([name, command, own]: Task, options: SuiteOptions) {
  const { out, env, summary, running, timeoutMs = 1_200_000, graceMs = 5000 } = options;
  const merged = suiteEnvironment(name, env, own);
  const started = performance.now();
  const temporary = resolve(out, 'tmp', name);
  await mkdir(temporary, { recursive: true });
  const canonical = await realpath(temporary);
  const suiteEnv = { ...merged, TMPDIR: canonical, TMP: canonical, TEMP: canonical };
  const log = createWriteStream(join(out, `${name}.log`));
  const child = spawn('nice', ['-n', '19', ...command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: suiteEnv });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  if (child.pid) running.add(child.pid);
  let expired = false;
  let cleanup: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    expired = true;
    log.write(`\nCHECK TIMEOUT (${timeoutMs / 1000} s)\n`);
    cleanup = (async () => {
      if (child.pid) await endGroup(child.pid, graceMs);
      await endBrowsers([canonical, temporary], env.MEETING_TEST_CHROME, graceMs, running);
    })();
    void cleanup.catch(() => {}); // Observe failures below, after the leader's pipes have closed.
  }, timeoutMs);
  const exit = await new Promise<number>(resolve => {
    child.once('error', error => { log.write(String(error) + '\n'); resolve(127); });
    child.once('close', code => resolve(expired ? 124 : code ?? 1));
  });
  clearTimeout(timeout);
  await cleanup; // Leader exit is not proof that its group (or detached Chromium) has ended.
  if (child.pid) running.delete(child.pid);
  await new Promise<void>(resolve => log.end(resolve));
  const line = `${name} exit=${exit} seconds=${Math.round((performance.now() - started) / 1000)}`;
  await appendFile(summary, line + '\n');
  console.log(line);
  return exit;
}
/** Per-suite limit: MEETING_CHECK_TIMEOUT_S (whole seconds) for a slower machine such as CI; unset keeps 20 minutes. */
export function suiteTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MEETING_CHECK_TIMEOUT_S;
  if (value === undefined || value === '') return 1_200_000;
  const seconds = Number(value);
  // Node clamps overflowing setTimeout delays to 1 ms instead of the requested limit.
  const maxSeconds = Math.floor(2_147_483_647 / 1000);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(seconds) || seconds > maxSeconds) {
    throw new Error(`MEETING_CHECK_TIMEOUT_S must be a whole number of seconds from 1 to ${maxSeconds}, not ${JSON.stringify(value)}.`);
  }
  return seconds * 1000;
}
/** Shared machines can request a single suite slot without changing the normal two-slot check run. */
export function suiteConcurrency(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MEETING_CHECK_CONCURRENCY ?? '2';
  if (value !== '1' && value !== '2') throw new Error('MEETING_CHECK_CONCURRENCY must be 1 or 2.');
  return Number(value);
}
/**
 * Expected seconds per suite: the mean of PR #76's two GitHub CI runs (macOS runner, two suites at a time, November 2026),
 * read from each suite's seconds= in summary.txt. npm-test is the unit job's test step (p50 of earlier runs).
 */
export const EXPECTED_SECONDS: Readonly<Record<string, number>> = {
  'npm-test': 379, 'mini-check': 364, 'plans-1280': 343, 'plans-1280-board400': 228, 'plans-390': 224, 'capture-resilience': 224,
  'ui-pass': 158, 'pane-head': 109, m9a: 94, progress: 89, 'browser-smoke': 63, 'transcript-notes-page': 52, 'notes-ui': 43,
  'ai-mode': 42, 'board-focus': 41, 'api-keys': 27, listen: 15, 'mini-gap': 14, 'progress-fix1': 13, 'transcript-download': 9,
  'progress-fix2': 8, 'echo-page': 7, 'app-check': 7,
};
export const DEFAULT_SECONDS = 60;
export const expectedSeconds = (name: string) => Object.hasOwn(EXPECTED_SECONDS, name) ? EXPECTED_SECONDS[name] : DEFAULT_SECONDS;
/** Longest expected first; equal estimates by name, so the order never depends on the list's order. */
export const longestFirst = (names: readonly string[]) =>
  [...names].sort((a, b) => expectedSeconds(b) - expectedSeconds(a) || (a < b ? -1 : a > b ? 1 : 0));
/** MEETING_CHECKS_SHARD=k/n runs only shard k of n (whole numbers, 1 ≤ k ≤ n ≤ 8); unset runs every task. */
export function checksShard(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MEETING_CHECKS_SHARD;
  if (value === undefined || value === '') return undefined;
  const match = /^([1-8])\/([1-8])$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`MEETING_CHECKS_SHARD must be k/n with whole numbers 1 ≤ k ≤ n ≤ 8, not ${JSON.stringify(value)}.`);
  }
  return { index: Number(match[1]), count: Number(match[2]) };
}
/**
 * Splits the tasks into `count` shards that each run `concurrency` at a time: longest first, each task goes to the least loaded
 * of the count × concurrency slots, and slot s belongs to shard floor(s / concurrency). Among equally loaded slots it takes the
 * one whose shard has the least work (then the lowest slot), so the longest tasks start in different shards.
 * Each shard keeps the longest-first order.
 */
export function splitShards(names: readonly string[], count: number, concurrency: number) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error(`Shard count must be a whole number from 1 to 8, not ${count}.`);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Concurrency must be a whole number of at least 1, not ${concurrency}.`);
  if (new Set(names).size !== names.length) throw new Error('Task names must be unique.');
  const slots = Array.from({ length: count * concurrency }, () => 0);
  const work = Array.from({ length: count }, () => 0);
  const shards = Array.from({ length: count }, () => [] as string[]);
  const shardOf = (slot: number) => Math.floor(slot / concurrency);
  for (const name of longestFirst(names)) {
    let least = 0;
    for (let slot = 1; slot < slots.length; slot++) {
      if (slots[slot] < slots[least] || (slots[slot] === slots[least] && work[shardOf(slot)] < work[shardOf(least)])) least = slot;
    }
    slots[least] += expectedSeconds(name);
    work[shardOf(least)] += expectedSeconds(name);
    shards[shardOf(least)].push(name);
  }
  return shards;
}
export function checkTasks(out: string, audio: string, browserOnly: boolean): Task[] {
  const node = [process.execPath, '--experimental-strip-types'];
  const check = (script: string, ...args: string[]) => [...node, `scripts/${script}.ts`, ...args];
  const guarded = (script: string, dir: string) => [...node, '--import', './scripts/check-env.ts', `scripts/${script}.ts`, join(out, dir)];
  // plans-check's 21 fixture states at three window sizes is the longest suite by far: one task per size spreads it over slots.
  const plans = (config: string): Task => [`plans-${config}`, guarded('plans-check', `plans-${config}`), { PLANS_CHECK_CONFIGS: config }];
  const all: Task[] = [
    ['npm-test', ['npm', 'test']],
    ['typecheck', ['npm', 'run', 'check']],
    ['transcript-download', check('transcript-download-check', join(out, 'transcript-download'))],
    ['listen', check('listen-check', join(out, 'listen'))],
    ['echo-page', check('echo-page-check', join(out, 'echo-page'))],
    ['browser-smoke', check('browser-smoke', join(out, 'browser-smoke'))],
    ['mini-check', check('mini-check', audio, audio, join(out, 'mini'))],
    ['mini-gap', check('mini-gap-check', join(out, 'mini-gap'))],
    ['m9a', check('m9a-page-check', join(out, 'm9a'))],
    ['app-check', check('app-check')],
    ['capture-resilience', check('capture-resilience-check', join(out, 'capture'))],
    ['transcript-notes-page', check('transcript-notes-page-check', join(out, 'transcript-notes-page'))],
    ['notes-ui', check('notes-ui-check', join(out, 'notes-ui'))],
    ['pane-head', check('pane-head-check', join(out, 'pane-head'))],
    plans('1280'), plans('1280-board400'), plans('390'),
    ['board-focus', check('board-focus-check', join(out, 'board-focus'))],
    ['ui-pass', check('ui-pass-check', join(out, 'ui-pass'))],
    ['api-keys', check('api-keys-check', join(out, 'api-keys'))],
    ['ai-mode', check('ai-mode-check', join(out, 'ai-mode'))],
    ['progress', guarded('progress-check', 'progress')],
    ['progress-fix1', guarded('progress-fix1-check', 'progress-fix1')],
    ['progress-fix2', guarded('progress-fix2-check', 'progress-fix2')],
  ];
  // CI runs the unit tests and the type check in their own jobs; its browser job sets MEETING_CHECKS_BROWSER_ONLY=1.
  return browserOnly ? all.filter(([name]) => name !== 'npm-test' && name !== 'typecheck') : all;
}
/**
 * Slots per shard in the split. Fixed, not this run's MEETING_CHECK_CONCURRENCY: every shard job must compute the same split,
 * or a task could be dropped or run twice.
 */
export const SHARD_SLOTS = 2;
/** This run's tasks, longest first: every task, or only those of shard k when MEETING_CHECKS_SHARD=k/n is set. */
export function plannedTasks(out: string, audio: string, env: NodeJS.ProcessEnv = process.env) {
  const tasks = checkTasks(out, audio, env.MEETING_CHECKS_BROWSER_ONLY === '1');
  const shard = checksShard(env);
  const byName = new Map(tasks.map(task => [task[0], task]));
  const names = shard ? splitShards([...byName.keys()], shard.count, SHARD_SLOTS)[shard.index - 1] : longestFirst([...byName.keys()]);
  return { shard, tasks: names.map(name => byName.get(name)!) };
}
async function main() {
  if (process.argv[2] === '--plan' && process.argv.length === 3) {
    const { shard, tasks } = plannedTasks('<out>', '<audio>');
    const total = tasks.reduce((sum, [name]) => sum + expectedSeconds(name), 0);
    console.log(`${shard ? `shard ${shard.index}/${shard.count}` : 'all tasks'}: ${tasks.length} tasks, ${total} s expected`);
    for (const [name] of tasks) console.log(`  ${name} ${expectedSeconds(name)}`);
    return;
  }
  if (process.argv.length !== 3) throw new Error('Usage: scripts/run-checks.sh <new-output-dir> (requires MEETING_TEST_CHROME) | --plan');
  const timeoutMs = suiteTimeoutMs();
  const concurrency = suiteConcurrency();
  checksShard();
  const chrome = testBrowser();
  await access(chrome);
  const out = resolve(process.argv[2]);
  await mkdir(out, { recursive: true });
  const summary = join(out, 'summary.txt');
  try { await writeFile(summary, '', { flag: 'wx' }); }
  catch { throw new Error('Use a fresh output directory: summary.txt already exists.'); }
  await mkdir(join(out, 'home', 'hf'), { recursive: true });
  await mkdir(join(out, 'tmp'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(out, 'home'), HF_HOME: join(out, 'home', 'hf'), XDG_CACHE_HOME: join(out, 'home', '.cache'),
    TMPDIR: join(out, 'tmp'), TMP: join(out, 'tmp'), TEMP: join(out, 'tmp'),
    MEETING_TEST_CHROME: chrome, MEETING_TEST_NO_MODELS: '1', LANG: process.env.LANG ?? 'en_US.UTF-8', TZ: 'UTC',
    npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_cache: join(out, 'home', '.npm'),
  };
  const audio = join(out, 'synthetic-meeting.wav');
  const { tasks } = plannedTasks(out, audio);
  // A clash thrown inside a worker would end the run while the other worker's suite is still going.
  for (const [name, , own] of tasks) suiteEnvironment(name, env, own);
  await checkAudio(audio);
  const running = new Set<number>();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.on(name, () => {
    for (const pid of running) signal(pid, 'SIGKILL');
    process.exit(128 + (name === 'SIGINT' ? 2 : 15));
  });
  let failed = false, next = 0;
  async function worker() {
    for (;;) {
      const task = tasks[next++];
      if (!task) return;
      if (await runSuite(task, { out, env, summary, running, timeoutMs }) !== 0) failed = true;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const browsers = await new Promise<string>(resolve => execFile('pgrep', ['-f', '[p]laywright_chromiumdev_profile|[m]eeting-app-profile-'], (_error, stdout) => resolve(stdout.trim())));
  const count = browsers ? browsers.split('\n').length : 0;
  await writeFile(join(out, 'leftover-browsers.txt'), browsers ? browsers + '\n' : '');
  await appendFile(summary, `leftover_test_browsers=${count}\n`);
  console.log(`leftover_test_browsers=${count}`);
  if (failed || count) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
