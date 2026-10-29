import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { endRecorded, signalGroup } from '../pi-extensions/process-groups.ts';
const exec = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/sweep2-process.ts', import.meta.url));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const stopped = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(r => child.once('exit', () => r()));

test('Pi 2: killing an owner before registration leaves neither an unrecorded sentinel nor a worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-gate-race-'));
  let owner: ChildProcess | undefined, pgid: number | undefined;
  try {
    const ps = join(directory, 'ps'), marker = join(directory, 'gate-pid');
    await writeFile(ps, '#!/bin/sh\nprintf "%s" "$4" > "$MARKER"\nexec /bin/sleep 30\n'); await chmod(ps, 0o700);
    owner = spawn(process.execPath, ['--experimental-strip-types', worker, 'gate', directory, 'unused'], { detached: true, env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, MARKER: marker }, stdio: 'ignore' });
    for (let n = 0; n < 500 && !pgid; n++) { pgid = Number(await readFile(marker, 'utf8').catch(() => '')) || undefined; if (!pgid) await delay(10); }
    assert.ok(pgid, 'processStart reached the delayed ps');
    signalGroup(owner.pid!, 'SIGKILL'); await stopped(owner);
    await delay(200);
    assert.equal((await readdir(directory)).some(n => n.endsWith('.json')), false, 'no process record exists');
    assert.deepEqual(await endRecorded(directory), { ended: 0, kept: 0 });
    const members = (await exec('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat=,command='])).stdout.split('\n').filter(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)/); return m && Number(m[2]) === pgid && !m[3].startsWith('Z');
    });
    assert.deepEqual(members, [], 'the gate must not start a sentinel before release');
  } finally {
    // Also cleans up the deliberately reproduced pre-fix leak and the delayed ps shim.
    if (pgid) signalGroup(pgid, 'SIGKILL');
    if (owner?.pid) { signalGroup(owner.pid, 'SIGKILL'); await stopped(owner); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi 7: calculation finishes successfully and an over-limit run times out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-calculate-limit-'));
  let child: ChildProcess | undefined;
  try {
    const home = join(directory, 'home');
    const out = join(directory, 'result.json');
    child = spawn(process.execPath, ['--experimental-strip-types', worker, 'calc', directory, out], { detached: true, env: { ...process.env, HOME: home, CALCULATE_MS: '1500', MEETING_PROCESS_DIR: join(directory, 'processes') }, stdio: 'ignore' });
    const deadline = setTimeout(() => { if (child?.pid) signalGroup(child.pid, 'SIGKILL'); }, 15_000);
    try { await stopped(child); } finally { clearTimeout(deadline); }
    assert.equal(child.exitCode, 0);
    const { success, timeout } = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(success.details.status, 'exit 0'); assert.equal(success.details.timedOut, false); assert.equal(success.isError, undefined);
    assert.equal(success.details.stdout.trim(), '42');
    assert.equal(timeout.details.timedOut, true, 'a real over-limit leader still times out'); assert.equal(timeout.isError, true);
  } finally {
    if (child?.pid) { signalGroup(child.pid, 'SIGKILL'); await stopped(child); }
    await endRecorded(join(directory, 'processes')); await rm(directory, { recursive: true, force: true });
  }
});
