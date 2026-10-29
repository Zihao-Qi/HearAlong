import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedPython } from './helpers/managed-python.ts';
import { signalGroup } from '../pi-extensions/process-groups.ts';
import { sweepPython } from '../pi-extensions/python-owner.ts';
import { sandboxed } from '../pi-extensions/tool-sandbox.ts';
const worker = fileURLToPath(new URL('./fixtures/disclaimed-child.ts', import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stopped = (child: ReturnType<typeof spawn>) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));

test('best-effort sweep requires an allowed executable, sandbox and exact task cwd', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'python-sweep-'))), home = join(root, 'home');
  const cwd = join(root, 'data', 'scratch', 'job'), other = join(root, 'data', 'scratch', 'other');
  for (const path of [home, cwd, other]) await mkdir(path, { recursive: true });
  const runtime = await managedPython(cwd, { ...process.env, HOME: home });
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => { for (const child of children) { child.kill('SIGKILL'); await stopped(child); } await rm(root, { recursive: true, force: true }); });
  async function start(folder: string, confined: boolean) {
    const args = ['-c', 'import time; print("ready", flush=True); time.sleep(30)'];
    const [command, argv] = confined ? sandboxed(runtime.python, args, folder, runtime.env) : [runtime.python, args] as const;
    const child = spawn(command, argv, { cwd: folder, env: runtime.env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('fixture exited before readiness'))); });
    return child;
  }
  const plain = await start(cwd, false), otherTask = await start(other, true), ours = await start(cwd, true);
  assert.equal(await sweepPython(cwd, runtime.env), 1);
  await stopped(ours);
  assert.equal(plain.exitCode, null); assert.equal(plain.signalCode, null);
  assert.equal(otherTask.exitCode, null); assert.equal(otherTask.signalCode, null);
});

for (const moveAway of [true, false]) test(`disclaimed child stays confined; ${moveAway ? 'changed cwd remains an accepted residual' : 'same-cwd leftover is swept'}`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'python-disclaimed-'))), home = join(root, 'home'), cwd = join(root, 'data', 'scratch', 'job');
  await mkdir(cwd, { recursive: true }); await mkdir(home);
  const outside = join(root, 'fictional-outside.txt'); await writeFile(outside, 'FICTIONAL_OUTSIDE_CANARY');
  await writeFile(join(cwd, 'inside.txt'), 'fictional permitted input');
  let unixConnections = 0, tcpConnections = 0, survivor: number | undefined;
  const unix = createServer(socket => { unixConnections++; socket.end(); }), tcp = createServer(socket => { tcpConnections++; socket.end(); });
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (!survivor) survivor = Number(await readFile(join(cwd, 'child-pid'), 'utf8').catch(() => '')) || undefined;
    if (survivor) try { process.kill(survivor, 'SIGKILL'); } catch { /* swept already */ }
    if (child?.pid) { signalGroup(child.pid, 'SIGKILL'); await stopped(child); }
    await Promise.all([unix, tcp].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  });
  const socket = join(root, 'canary.sock');
  await new Promise<void>(resolve => unix.listen(socket, resolve));
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const runtime = await managedPython(cwd, { ...process.env, HOME: home });
  const uv = join(root, 'uv'), config = join(root, 'config.json'), out = join(cwd, 'result.json');
  await writeFile(uv, `#!/bin/sh\nwhile [ "$1" != python ]; do shift; done\nshift\nexec '${runtime.python}' "$@"\n`); await chmod(uv, 0o700);
  await writeFile(config, JSON.stringify({ cwd, outside, socket, port: (tcp.address() as { port: number }).port, moveAway }));
  child = spawn(process.execPath, ['--experimental-strip-types', worker, cwd, config, out], { detached: true,
    env: { ...runtime.env, HOME: home, PATH: `${root}${delimiter}${process.env.PATH}`, RUN_PYTHON_MS: '10000' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr!.on('data', part => { diagnostics = (diagnostics + part).slice(-2000); });
  const timer = setTimeout(() => { if (child?.pid) signalGroup(child.pid, 'SIGKILL'); }, 30_000);
  try { await stopped(child); } finally { clearTimeout(timer); }
  assert.equal(child.exitCode, 0, diagnostics);
  const result = JSON.parse(await readFile(out, 'utf8')); assert.equal(result.isError, undefined, result.content[0].text);
  if (moveAway) {
    // Release the surviving child only AFTER run_python has returned, proving its inherited sandbox still applies.
    await writeFile(join(cwd, 'after-task'), 'release fictional probes');
    for (let n = 0; n < 500; n++) { if (await readFile(join(cwd, 'child-results.json'), 'utf8').then(Boolean, () => false)) break; await delay(10); }
  }
  const probes = JSON.parse(await readFile(join(cwd, 'child-results.json'), 'utf8'));
  assert.deepEqual(probes, { outside: 'denied', unix: 'denied', tcp: 'denied', symlink: 'denied', hardlink: 'denied', project: 'denied' });
  assert.equal(unixConnections, 0); assert.equal(tcpConnections, 0);
  survivor = Number(await readFile(join(cwd, 'child-pid'), 'utf8')); assert.ok(survivor > 1);
  let alive = true;
  for (let n = 0; n < (moveAway ? 1 : 100); n++) { try { process.kill(survivor, 0); } catch { alive = false; break; } if (!moveAway) await delay(10); }
  assert.equal(alive, moveAway, moveAway ? 'the test must actually observe the confined surviving child' : 'best-effort sweep should remove an ordinary same-cwd leftover');
});
