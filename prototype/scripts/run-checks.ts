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
export async function runSuite([name, command]: [string, string[]], options: SuiteOptions) {
  const { out, env, summary, running, timeoutMs = 1_200_000, graceMs = 5000 } = options;
  const temporary = resolve(out, 'tmp', name);
  await mkdir(temporary, { recursive: true });
  const canonical = await realpath(temporary);
  const suiteEnv = { ...env, TMPDIR: canonical, TMP: canonical, TEMP: canonical };
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
  await appendFile(summary, `${name} exit=${exit}\n`);
  console.log(`${name} exit=${exit}`);
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
async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: scripts/run-checks.sh <new-output-dir> (requires MEETING_TEST_CHROME)');
  const timeoutMs = suiteTimeoutMs();
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
  await checkAudio(audio);
  const node = [process.execPath, '--experimental-strip-types'];
  const check = (script: string, ...args: string[]) => [...node, `scripts/${script}.ts`, ...args];
  const tasks: [string, string[]][] = [
    ['npm-test', ['npm', 'test', '--', '--test-concurrency=2']],
    ['typecheck', ['npm', 'run', 'check']],
    ['transcript-download', check('transcript-download-check', join(out, 'transcript-download'))],
    ['listen', check('listen-check', join(out, 'listen'))],
    ['browser-smoke', check('browser-smoke', join(out, 'browser-smoke'))],
    ['mini-check', check('mini-check', audio, audio, join(out, 'mini'))],
    ['m9a', check('m9a-page-check', join(out, 'm9a'))],
    ['app-check', check('app-check')],
    ['capture-resilience', check('capture-resilience-check', join(out, 'capture'))],
    ['transcript-notes-page', check('transcript-notes-page-check', join(out, 'transcript-notes-page'))],
    ['notes-ui', check('notes-ui-check', join(out, 'notes-ui'))],
    ['pane-head', check('pane-head-check', join(out, 'pane-head'))],
    ['plans', [...node, '--import', './scripts/check-env.ts', 'scripts/plans-check.ts', join(out, 'plans')]],
    ['board-focus', check('board-focus-check', join(out, 'board-focus'))],
    ['api-keys', check('api-keys-check', join(out, 'api-keys'))],
  ];
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
  await Promise.all([worker(), worker()]);
  const browsers = await new Promise<string>(resolve => execFile('pgrep', ['-f', '[p]laywright_chromiumdev_profile|[m]eeting-app-profile-'], (_error, stdout) => resolve(stdout.trim())));
  const count = browsers ? browsers.split('\n').length : 0;
  await writeFile(join(out, 'leftover-browsers.txt'), browsers ? browsers + '\n' : '');
  await appendFile(summary, `leftover_test_browsers=${count}\n`);
  console.log(`leftover_test_browsers=${count}`);
  if (failed || count) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
