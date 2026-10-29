import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedPython } from './helpers/managed-python.ts';
import { signalGroup } from '../pi-extensions/process-groups.ts';
const worker = fileURLToPath(new URL('./fixtures/python-descendants.ts', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['normal', 'timeout', 'killed-pi']) test(`H2: a setsid double-fork survivor ends with ${mode}`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'python-descendant-'))), home = join(root, 'home'), cwd = join(root, 'data', 'scratch', 'job');
  await mkdir(cwd, { recursive: true }); await mkdir(home);
  const runtime = await managedPython(cwd, { ...process.env, HOME: home });
  const uv = join(root, 'uv'), out = join(cwd, 'result.json'), pidfile = join(cwd, 'survivor');
  await writeFile(uv, `#!/bin/sh\nwhile [ "$1" != python ]; do shift; done\nshift\nexec '${runtime.python}' "$@"\n`); await chmod(uv, 0o700);
  let survivor: number | undefined;
  const child = spawn(process.execPath, ['--experimental-strip-types', worker, cwd, out, mode], { detached: true, env: { ...runtime.env, HOME: home, RUN_PYTHON_MS: mode === 'timeout' ? '1000' : '10000', PATH: `${root}${delimiter}${process.env.PATH}` }, stdio: 'ignore' });
  t.after(async () => {
    if (!survivor) survivor = Number(await readFile(pidfile, 'utf8').catch(() => '')) || undefined;
    if (survivor) try { process.kill(survivor, 'SIGKILL'); } catch { /* cleaned up */ }
    if (child.pid) signalGroup(child.pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  if (mode === 'killed-pi') {
    for (let n = 0; n < 1000; n++) { if (await readFile(pidfile, 'utf8').then(Boolean, () => false)) break; await delay(10); }
    assert.ok(Number(await readFile(pidfile, 'utf8')) > 1);
    signalGroup(child.pid!, 'SIGKILL');
  }
  const timer = setTimeout(() => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); }, 30_000);
  try { await new Promise<void>(resolve => child.once('exit', () => resolve())); } finally { clearTimeout(timer); }
  if (mode !== 'killed-pi') {
    assert.equal(child.exitCode, 0);
    const result = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(result.isError, mode === 'timeout' ? true : undefined, result.content[0].text);
    assert.equal(result.details.timedOut, mode === 'timeout');
  }
  survivor = Number(await readFile(pidfile, 'utf8')); assert.ok(survivor > 1);
  let alive = true;
  for (let n = 0; n < 100; n++) { try { process.kill(survivor, 0); } catch { alive = false; break; } await delay(10); }
  assert.equal(alive, false, 'orphaned child must not race subsequent file tools');
});
