// Local-only merge routine, from any checkout:
// node --experimental-strip-types app/scripts/land.ts <name> "<message>" [--full] [--timeout-ms N]
// Quick: npm run check, then npm test. Full: npm run check, then main's npm run checks <fresh-dir>.
// All commands use nice -n 19, a test Chrome, and per-command logs. Default timeouts:
// 10 minutes for check/test, 90 minutes for checks; --timeout-ms overrides all three.
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const identity = ['-c', 'user.name=Zihao Qi', '-c', 'user.email=35388022+Zihao-Qi@users.noreply.github.com'];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Zihao Qi', GIT_COMMITTER_NAME: 'Zihao Qi',
  GIT_AUTHOR_EMAIL: '35388022+Zihao-Qi@users.noreply.github.com', GIT_COMMITTER_EMAIL: '35388022+Zihao-Qi@users.noreply.github.com',
  GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0' };
const trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const chrome = process.env.MEETING_TEST_CHROME ?? join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new Error(oneLine([e.stderr, e.stdout].filter(Boolean).join(' ') || e.message));
  }
}
const text = (cwd: string, ...args: string[]) => git(cwd, ...args).trim();
const paths = (output: string) => output.split('\0').filter(Boolean);

function options() {
  const args = process.argv.slice(2);
  const name = args.shift(), message = args.shift();
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !message?.trim() || !message.split(/\r?\n/)[0].trim()) {
    throw new Error('usage: land <worktree-name> "<commit message>" [--full] [--timeout-ms N]');
  }
  let full = false;
  let timeoutMs: number | undefined;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--full') full = true;
    else if (arg === '--timeout-ms') {
      const value = args.shift();
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2_147_483_647) {
        throw new Error('--timeout-ms must be a positive integer up to 2147483647');
      }
      timeoutMs = Number(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { name, message, full, timeoutMs };
}

function verifyHooks(checkout: string, main: string) {
  const configured = text(checkout, 'config', '--default', '', '--get', 'core.hooksPath');
  const hookPath = resolve(checkout, configured);
  const allowed = [join(checkout, '.githooks'), join(main, '.githooks')];
  if (!configured || !existsSync(hookPath) || !allowed.some(path => existsSync(path) && realpathSync(path) === realpathSync(hookPath))) {
    throw new Error('hooks inactive: core.hooksPath must point at the repository .githooks (run npm run guard:install)');
  }
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push', 'public-guard.cjs']) {
    const file = join(hookPath, hook);
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      accessSync(file, hook === 'public-guard.cjs' ? constants.R_OK : constants.R_OK | constants.X_OK);
    } catch { throw new Error(`hooks inactive: ${file} must be a readable ${hook === 'public-guard.cjs' ? 'shared guard' : 'executable hook'}`); }
  }
  // The real wrappers load the shared guard from main, even for relative hooksPath.
  try { accessSync(join(main, '.githooks/public-guard.cjs'), constants.R_OK); }
  catch { throw new Error('hooks inactive: main .githooks/public-guard.cjs is unavailable'); }
}

function forbiddenPaths(worktree: string): string[] {
  const candidates = new Set([
    ...paths(git(worktree, 'diff', '--cached', '--name-only', '-z')),
    ...paths(git(worktree, 'ls-files', '--others', '--exclude-standard', '-z')),
    // Include ignored links (not traversed) and ignored WAVs: neither may silently slip through.
    ...paths(git(worktree, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z')),
    ...paths(git(worktree, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(glob,icase)**/*.wav')),
  ]);
  return [...candidates].filter(path => {
    if (/\.wav$/i.test(path)) return true;
    if (basename(path.replace(/\/$/, '')) !== 'node_modules') return false;
    try { return lstatSync(join(worktree, path.replace(/\/$/, ''))).isSymbolicLink(); }
    catch {
      // A deleted staged link still counts as a staged forbidden path.
      return git(worktree, 'ls-files', '--stage', '--', path).startsWith('120000 ');
    }
  }).sort();
}

function requireChecksScript(main: string) {
  let script: unknown;
  try { script = JSON.parse(readFileSync(join(main, 'app/package.json'), 'utf8'))?.scripts?.checks; }
  catch { throw new Error('main app/package.json must be readable and define a checks script'); }
  if (typeof script !== 'string' || !script.trim()) throw new Error('main app/package.json must define a checks script before landing');
}

function printFullSummary(file: string) {
  const suites = new Map<string, number>();
  let browsers: number | undefined;
  for (const line of readFileSync(file, 'utf8').trim().split(/\r?\n/)) {
    const suite = /^([a-zA-Z0-9][a-zA-Z0-9._-]*) exit=(\d+)$/.exec(line);
    const leftover = /^leftover_test_browsers=(\d+)$/.exec(line);
    if (suite && !suites.has(suite[1]) && Number.isSafeInteger(Number(suite[2]))) suites.set(suite[1], Number(suite[2]));
    else if (leftover && browsers === undefined && Number.isSafeInteger(Number(leftover[1]))) browsers = Number(leftover[1]);
    else throw new Error(`invalid checks summary: ${JSON.stringify(line)}`);
  }
  if (!suites.size || browsers === undefined) throw new Error('incomplete checks summary: suites and leftover_test_browsers are required');
  for (const [name, exit] of suites) console.log(`${name}  ${exit === 0 ? 'ok' : 'FAIL'}`);
  console.log(`leftover test browsers  ${browsers}`);
  if ([...suites.values()].some(exit => exit !== 0) || browsers) throw new Error('checks summary reports failing suites or leftover test browsers');
}

// The command group includes npm, its shell, and the script. Give main's runner
// SIGTERM first so it can stop its own detached suite groups, then bound cleanup.
async function runCommand(name: 'check' | 'test' | 'checks', args: string[], main: string, run: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const log = join(run, `${name}.log`);
  const fd = openSync(log, 'w', 0o600), started = Date.now();
  let failure: string | undefined;
  try {
    signal.throwIfAborted();
    await new Promise<void>((done, reject) => {
      const child = spawn('nice', ['-n', '19', 'npm', ...args], { cwd: join(main, 'app'), env: { ...process.env, MEETING_TEST_CHROME: chrome }, detached: true, stdio: ['ignore', fd, fd] });
      let stopped: string | undefined, ending: Promise<void> | undefined;
      const groupExists = () => {
        if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') return false;
          if (code === 'EPERM') return true; // Retain ownership through bounded grace, including unreaped orphans.
          throw error;
        }
      };
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) try { process.kill(-child.pid, signal); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH' && code !== 'EPERM') throw error;
        }
      };
      const endGroup = async () => {
        if (!groupExists()) return;
        killGroup('SIGTERM');
        for (let i = 0; i < 10 && groupExists(); i++) await delay(50);
        if (groupExists()) killGroup('SIGKILL');
        for (let i = 0; i < 10 && groupExists(); i++) await delay(50);
      };
      const stop = (reason: string) => { stopped ??= reason; ending ??= endGroup(); void ending.catch(reject); };
      const interrupt = () => stop((signal.reason as Error).message);
      const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', interrupt); };
      signal.addEventListener('abort', interrupt, { once: true });
      if (signal.aborted) interrupt();
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', async (code, exitSignal) => {
        clearTimeout(timer);
        try { await (ending ??= endGroup()); }
        catch (error) { cleanup(); reject(error); return; }
        cleanup();
        if (signal.aborted) stopped ??= (signal.reason as Error).message;
        if (stopped) reject(new Error(stopped));
        else if (code !== 0) reject(new Error(`exit ${code ?? exitSignal}`));
        else done();
      });
    });
  } catch (error) { failure = oneLine((error as Error).message); }
  // Read the runner's retained summary even on a nonzero exit, not just on success.
  if (name === 'checks') {
    try { printFullSummary(join(run, 'checks/summary.txt')); }
    catch (error) { failure = [failure, `summary: ${(error as Error).message}`].filter(Boolean).join('; '); }
  }
  try { if (failure) appendFileSync(log, `\nland: ${failure}\n`); }
  finally { closeSync(fd); }
  console.log(`${name}  ${failure ? 'FAIL' : 'ok'}  ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (failure) throw new Error(`command ${name} failed: ${failure}; log: ${log}`);
}

function requireCleanMain(main: string) {
  if (text(main, 'branch', '--show-current') !== 'main') throw new Error('main checkout must be on main');
  if (git(main, 'status', '--porcelain').trim()) throw new Error('main checkout must be clean');
}

function ownershipDifferences(main: string, merge: string | undefined): string[] {
  const differences: string[] = [];
  try {
    const branch = text(main, 'branch', '--show-current');
    if (branch !== 'main') differences.push(`branch is ${branch || '(detached)'}, expected main`);
    const head = text(main, 'rev-parse', 'HEAD');
    if (!merge) differences.push(`no verified land merge commit was created (HEAD ${head})`);
    else if (head !== merge) differences.push(`HEAD is ${head}, expected land merge ${merge}`);
    const tracked = text(main, 'status', '--porcelain', '--untracked-files=no');
    if (tracked) differences.push(`index/working tree has tracked changes: ${oneLine(tracked)}`);
  } catch (error) { differences.push(`cannot verify checkout ownership: ${(error as Error).message}`); }
  return differences;
}

function rollbackObstructions(main: string, merge: string, before: string): string[] {
  const mergedPaths = new Set(paths(git(main, 'ls-tree', '-r', '-t', '--name-only', '-z', merge)));
  const restoredFiles = new Set(paths(git(main, 'ls-tree', '-r', '--name-only', '-z', before)));
  const obstructing = new Set<string>();
  for (const path of paths(git(main, 'diff', '--name-only', '-z', '--no-renames', merge, before))) {
    if (!restoredFiles.has(path)) continue; // Reset only deletes this path; it does not write it.
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      let entry;
      try { entry = lstatSync(join(main, prefix)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error; // Unverifiable paths must not permit a destructive reset.
      }
      if (depth === parts.length) {
        if (!mergedPaths.has(prefix) || entry.isDirectory()) obstructing.add(prefix);
      } else if (!entry.isDirectory()) {
        // An untracked file/symlink can also block a restored descendant. Never
        // follow symlinks into another directory while inspecting obstructions.
        if (!mergedPaths.has(prefix)) obstructing.add(prefix);
        break;
      }
    }
  }
  return [...obstructing].sort();
}

function manualRecovery(main: string, before: string, error: Error, differences: string[]) {
  const quotedMain = `'${main.replaceAll("'", "'\\''")}'`;
  return Object.assign(new Error(`${error.message}; rollback refused: ${differences.join('; ')}; no reset performed; manual recovery, only if the user decides after preserving their work: cd ${quotedMain} && git reset --hard ${before}`), { exitCode: 2 });
}

async function landLocked(common: string, opts: ReturnType<typeof options>, signal: AbortSignal) {
  const { name, message, full, timeoutMs } = opts;
  const main = dirname(common), branchRef = `refs/heads/${name}`;
  const worktree = join(main, '.claude/worktrees', name);
  if (!existsSync(worktree)) throw new Error(`worktree missing: ${worktree}`);
  if (text(worktree, 'rev-parse', '--show-toplevel') !== realpathSync(worktree)
    || realpathSync(text(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== realpathSync(common)) {
    throw new Error(`not a registered repository worktree: ${worktree}`);
  }
  if (text(worktree, 'symbolic-ref', '-q', 'HEAD') !== branchRef) throw new Error(`worktree must be on branch ${name}`);
  requireCleanMain(main);
  requireChecksScript(main);
  verifyHooks(main, main); verifyHooks(worktree, main);
  const forbidden = forbiddenPaths(worktree);
  if (forbidden.length) throw new Error(`forbidden worktree files: ${forbidden.map(path => JSON.stringify(path)).join(', ')} (remove them yourself, then retry)`);
  const dirty = Boolean(git(worktree, 'status', '--porcelain').trim());
  const initialMain = text(main, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
  const initialFeature = text(main, 'rev-parse', '--verify', `${branchRef}^{commit}`);
  if (!dirty && text(main, 'rev-list', '--count', `${initialMain}..${initialFeature}`) === '0') throw new Error('nothing to land');

  if (dirty) {
    git(worktree, 'add', '-A');
    try { git(worktree, ...identity, 'commit', '-m', `${message.trim()}\n\n${trailer}`); }
    catch (error) { throw new Error(`worktree commit failed: ${(error as Error).message}`); }
  }
  const feature = text(main, 'rev-parse', '--verify', `${branchRef}^{commit}`);
  const requireFeature = () => {
    if (text(worktree, 'branch', '--show-current') !== name || text(worktree, 'rev-parse', 'HEAD') !== feature
      || text(main, 'rev-parse', '--verify', `${branchRef}^{commit}`) !== feature) {
      throw new Error(`worktree branch/HEAD changed from pinned feature ${feature}`);
    }
    if (git(worktree, 'status', '--porcelain').trim() || forbiddenPaths(worktree).length) throw new Error('worktree has intervening changes');
  };
  requireFeature();
  // Worktree hooks may take time or mutate main: pin/revalidate only just before merging.
  requireCleanMain(main);
  const before = text(main, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
  const unchanged = text(main, 'merge-base', before, feature) === before;
  let quick = !full && unchanged;
  const reason = full ? 'forced --full' : unchanged ? 'main unchanged since branch' : 'main moved';
  console.log(`hooks          active\ncommit         ${feature.slice(0, 7)}  (worktree ${name})\nchecks plan    ${quick ? 'quick' : 'full'} (${reason})`);

  let run: string | undefined, merge: string | undefined;
  let passed = 0, total = 0;
  let removed = false;
  // Recheck adjacent to merge too; failures here have not touched main and need no rollback.
  verifyHooks(main, main); verifyHooks(worktree, main);
  requireChecksScript(main);
  requireCleanMain(main);
  if (text(main, 'rev-parse', 'HEAD') !== before) throw new Error('main HEAD changed before merge; retry');
  signal.throwIfAborted();
  try {
    try {
      git(main, ...identity, '-c', 'branch.main.mergeOptions=', 'merge', '--no-ff', '--commit', '--no-squash', '--verify', '--strategy=ort', feature,
        '-m', `Merge ${name}: ${message.split(/\r?\n/)[0].trim()}\n\n${trailer}`);
    } catch (error) { throw new Error(`merge failed: ${(error as Error).message}`); }
    const candidate = text(main, 'rev-parse', 'HEAD');
    const parents = text(main, 'show', '-s', '--format=%P', candidate).split(' ');
    if (parents.length !== 2 || parents[0] !== before || parents[1] !== feature) throw new Error(`merge parents differ from pinned main ${before} and feature ${feature}: ${parents.join(' ')}`);
    merge = candidate;
    const differences = ownershipDifferences(main, merge);
    if (differences.length) throw new Error(`main changed after merge: ${differences.join('; ')}`);
    if (quick && text(main, 'rev-parse', `${merge}^{tree}`) !== text(main, 'rev-parse', `${feature}^{tree}`)) {
      quick = false;
      console.log('checks plan    full (merged tree differs from pinned feature tree; quick equivalence lost)');
    }
    const runRoot = join(tmpdir(), 'hearalong-land'); mkdirSync(runRoot, { recursive: true });
    run = mkdtempSync(join(runRoot, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-`));
    console.log(`logs: ${run}`);
    total = 2;
    await runCommand('check', ['run', 'check'], main, run, timeoutMs ?? 600_000, signal); passed++;
    if (quick) await runCommand('test', ['test'], main, run, timeoutMs ?? 600_000, signal);
    else await runCommand('checks', ['run', 'checks', join(run, 'checks')], main, run, timeoutMs ?? 5_400_000, signal);
    passed++;
    signal.throwIfAborted();
    try {
      const changed = ownershipDifferences(main, merge);
      if (changed.length) throw new Error(`main changed before cleanup: ${changed.join('; ')}`);
      requireFeature();
      // branch -d may use an upstream rather than main; prove containment ourselves.
      git(main, 'merge-base', '--is-ancestor', feature, merge);
      git(main, 'worktree', 'remove', worktree);
      removed = true;
      if (text(main, 'rev-parse', '--verify', `${branchRef}^{commit}`) !== feature) throw new Error('feature branch changed before deletion');
      git(main, 'branch', '-d', name);
    } catch (error) { throw new Error(`cleanup failed: ${(error as Error).message}`); }
  } catch (error) {
    // Never reset a concurrent conversation's commits, edits, index, or branch.
    const differences = ownershipDifferences(main, merge);
    if (!differences.length && merge) {
      try {
        const obstructing = rollbackObstructions(main, merge, before);
        if (obstructing.length) differences.push(`rollback obstructions (untracked/ignored paths or directories): ${obstructing.map(path => JSON.stringify(path)).join(', ')}`);
      } catch (inspectionError) { differences.push(`cannot inspect rollback obstructions: ${(inspectionError as Error).message}`); }
    }
    if (differences.length) throw manualRecovery(main, before, error as Error, differences);
    try { git(main, 'reset', '--hard', before); }
    catch (resetError) { throw manualRecovery(main, before, error as Error, [`reset failed: ${(resetError as Error).message}`]); }
    if (removed) {
      try { git(main, 'worktree', 'add', worktree, name); }
      catch (restoreError) { throw new Error(`${(error as Error).message}; main restored; worktree recovery failed: ${(restoreError as Error).message}; branch ${name} kept`); }
    }
    throw new Error(`${(error as Error).message}; main restored to ${before.slice(0, 7)}; worktree and commit kept`);
  }

  console.log(`merge          ${merge}\nchecks         ${passed}/${total} passed   logs: ${run}\nworktree       removed\nnext           update STATUS, then ask the user before pushing`);
}

async function land(signal: AbortSignal) {
  const opts = options();
  const common = text(process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const lock = join(common, 'hearalong-land.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`another land run holds lock ${lock}; inspect its PID before manually removing a stale lock`);
    throw error;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    await landLocked(common, opts, signal);
  } finally { closeSync(fd); unlinkSync(lock); }
}

const interruption = new AbortController();
const onInt = () => interruption.abort(new Error('interrupted by SIGINT'));
const onTerm = () => interruption.abort(new Error('interrupted by SIGTERM'));
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
land(interruption.signal).catch(error => {
  console.error(`land: ${oneLine((error as Error).message)}`);
  process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
}).finally(() => { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); });
