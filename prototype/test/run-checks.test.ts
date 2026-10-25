import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from '../scripts/run-checks.ts';

const fixture = fileURLToPath(new URL('./fixtures/check-runner-process.mjs', import.meta.url));
function alive(pid: number) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch { return false; }
}
const kill = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } };
async function setup() {
  const out = await mkdtemp(join(tmpdir(), 'check-runner-test-'));
  const summary = join(out, 'summary.txt');
  await writeFile(summary, '');
  return { out, summary, running: new Set<number>(), env: { ...process.env, MEETING_TEST_CHROME: process.execPath }, timeoutMs: 1000, graceMs: 200 };
}

test('a timed-out suite kills TERM-resistant group members before releasing its slot', { timeout: 10_000 }, async t => {
  const options = await setup();
  const pidFile = join(options.out, 'helper.pid');
  let pid: number | undefined;
  t.after(async () => {
    pid ??= Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid) kill(pid);
    for (const group of options.running) try { process.kill(-group, 'SIGKILL'); } catch { /* already dead */ }
    await rm(options.out, { recursive: true, force: true });
  });
  const exit = await runSuite(['timeout-probe', [process.execPath, fixture, 'suite', pidFile]], options);
  pid = Number(await readFile(pidFile, 'utf8'));
  console.log(JSON.stringify({ exit, helperAliveAtSlotRelease: alive(pid), runningCount: options.running.size }));
  assert.equal(exit, 124);
  assert.equal(alive(pid), false, 'TERM-resistant helper survived after the suite slot was released');
  assert.equal(options.running.size, 0);
});

test('timeout browser cleanup is confined to that suite temp dir, not a neighbouring prefix', { timeout: 10_000 }, async t => {
  const options = await setup();
  const suiteTmp = join(options.out, 'tmp', 'browser-probe');
  const ownedProfile = join(suiteTmp, 'playwright_chromiumdev_profile-owned');
  const neighbourProfile = join(`${suiteTmp}-neighbour`, 'playwright_chromiumdev_profile-other');
  await mkdir(ownedProfile, { recursive: true });
  await mkdir(neighbourProfile, { recursive: true });
  const neighbourPidFile = join(options.out, 'neighbour.pid');
  const neighbour = spawn(process.execPath, [fixture, 'helper', neighbourPidFile, `--user-data-dir=${neighbourProfile}`],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (neighbour.pid) kill(neighbour.pid); });
  await once(neighbour, 'message');
  const pidFile = join(options.out, 'helper.pid'), browserPidFile = join(options.out, 'browser.pid');
  t.after(async () => {
    for (const path of [pidFile, browserPidFile]) { const pid = Number(await readFile(path, 'utf8').catch(() => '0')); if (pid) kill(pid); }
    for (const group of options.running) try { process.kill(-group, 'SIGKILL'); } catch { /* already dead */ }
    await rm(options.out, { recursive: true, force: true });
  });
  const exit = await runSuite(['browser-probe', [process.execPath, fixture, 'suite', pidFile, ownedProfile, browserPidFile]],
    { ...options, env: { ...options.env, TMPDIR: suiteTmp, TMP: suiteTmp, TEMP: suiteTmp } });
  const browser = Number(await readFile(browserPidFile, 'utf8'));
  console.log(JSON.stringify({ exit, ownedBrowserAliveAtSlotRelease: alive(browser), neighbourAlive: alive(neighbour.pid!) }));
  assert.equal(exit, 124);
  assert.equal(alive(browser), false, 'detached test browser survived timeout cleanup');
  assert.equal(alive(neighbour.pid!), true, 'cleanup killed a different suite browser');
  assert.equal(options.running.size, 0);
});
