import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import childProcess, { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { physicalFootprintBytes } from '../pi-extensions/calculate.ts';

// Startup includes Seatbelt, Node permissions and loading mathjs; it is not the subject of most tests.
const RUN_MS = 20_000;
async function fixture(t: any, ms = RUN_MS, runs = 6, recorded = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'calculate-'))), cwd = join(root, 'data', 'scratch', 'job');
  await mkdir(cwd, { recursive: true });
  const saved = { ...process.env }, previous = process.cwd();
  Object.assign(process.env, { HOME: join(root, 'home'), MEETING_DATA_DIR: join(root, 'data'), CALCULATE_MS: String(ms), CALCULATE_MAX_RUNS: String(runs), MEETING_PROCESS_DIR: join(root, 'processes'), OPENAI_API_KEY: 'FICTIONAL_SECRET', NODE_OPTIONS: '--inspect=0' });
  delete process.env.CALCULATE_USED;
  if (!recorded) { delete process.env.MEETING_PROCESS_DIR; await mkdir(join(root, 'processes'), { mode: 0o700 }); }
  process.chdir(cwd);
  t.after(async () => { process.chdir(previous); process.env = saved; await rm(root, { recursive: true, force: true }); });
  const { default: register } = await import('../pi-extensions/calculate.ts');
  const exitListeners = new Set(process.listeners('exit'));
  let tool: any; register({ registerTool: (definition: any) => { tool = definition; } } as any);
  const ownedListeners = process.listeners('exit').filter(listener => !exitListeners.has(listener));
  t.after(() => { for (const listener of ownedListeners) process.removeListener('exit', listener); });
  const groups = new Set<number>(), results: any[] = [], signals: { pid: number; signal: string | number | undefined }[] = [];
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid < 0) { groups.add(-pid); signals.push({ pid: -pid, signal }); }
    return kill(pid, signal as NodeJS.Signals);
  });
  t.after(async () => {
    // Records alone cannot prove a stopped sentinel was killed. Inspect every group signalled by the guard.
    let remaining = '';
    for (let n = 0; n < 40; n++) {
      const listed = await new Promise<string>((resolve, reject) => childProcess.execFile('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], (error, output) => error ? reject(error) : resolve(output)));
      remaining = listed.split('\n').filter(line => {
        const [, pgid, state] = line.trim().split(/\s+/);
        return groups.has(Number(pgid)) && !state.startsWith('Z');
      }).join('\n');
      if (!remaining) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (remaining) for (const pid of groups) { try { kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    assert.equal(remaining, '', `live/stopped calculation group: ${remaining}; ${JSON.stringify(results)}`);
  });
  return { root, cwd, tool, signals, run: async (code: string, signal?: AbortSignal) => {
    const result = await tool.execute('fictional', { code }, signal); results.push(result); return result;
  } };
}

/** Test-only interception of the trusted parent's built-in execFile; no tool parameter or environment seam. */
function injectedTop(t: any, plan: (pid: number, samples: { pid: number; bytes: number | null }[]) => 'slow' | 'failed' | 'small' | 'real') {
  const execFile = childProcess.execFile, samples: { pid: number; bytes: number | null }[] = [];
  const delays: { pid: number; state: Promise<string> }[] = [], latencies: number[] = [];
  const mocked = t.mock.method(childProcess, 'execFile', (command: string, args: string[], options: any, callback: any) => {
    if (command !== '/usr/bin/top') return execFile(command, args, options, callback);
    const pid = Number(args.at(-1)), mode = plan(pid, samples), started = performance.now();
    const done = (error: any, output: string, stderr: string) => {
      latencies.push(performance.now() - started);
      samples.push({ pid, bytes: error ? null : physicalFootprintBytes(String(output), pid) });
      callback(error, output, stderr);
    };
    if (mode === 'failed') return execFile('/usr/bin/false', [], options, done);
    if (mode === 'small') return execFile('/usr/bin/printf', ['%s', `PID MEM\n${pid} 20M\n`], options, done);
    if (mode === 'slow') {
      delays.push({ pid, state: new Promise<string>((resolve, reject) => setTimeout(() => {
        execFile('/bin/ps', ['-o', 'stat=', '-p', String(pid)], (error, output) => error ? reject(error) : resolve(output.trim()));
      }, 600)) });
      // The real top command would start after six seconds; the production five-second probe timeout still applies.
      return execFile(process.execPath, ['-e', `setTimeout(()=>require('node:child_process').execFile('/usr/bin/top',${JSON.stringify(args)},(e,o)=>{process.stdout.write(o);process.exitCode=e?1:0}),6000)`], options, done);
    }
    return execFile(command, args, options, done);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return { samples, delays, latencies };
}

test('calculate prints output, is sequential, starts fresh, and limits runs', async t => {
  const f = await fixture(t, RUN_MS, 2);
  assert.equal(f.tool.name, 'calculate', JSON.stringify(f.tool)); assert.equal(f.tool.executionMode, 'sequential', JSON.stringify(f.tool));
  const a = await f.run('globalThis.fictional = 42; console.log(6 * 7)');
  assert.equal(a.isError, undefined, JSON.stringify(a)); assert.equal(a.details.stdout, '42\n', JSON.stringify(a));
  const b = await f.run('console.log(typeof fictional)');
  assert.equal(b.details.stdout, 'undefined\n', JSON.stringify(b));
  await assert.rejects(f.run('console.log(0)'), /calculate limit reached/, JSON.stringify({ a, b }));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify({ a, b }));
});

test('calculate caps each output stream', async t => {
  const f = await fixture(t);
  const result = await f.run('console.log("x".repeat(25000)); console.error("y".repeat(25000))');
  assert.match(result.details.stdout, /truncated at 20000 bytes/, JSON.stringify(result)); assert.match(result.details.stderr, /truncated at 20000 bytes/, JSON.stringify(result));
  assert.ok(result.details.stdout.length < 20100, JSON.stringify(result)); assert.ok(result.details.stderr.length < 20100, JSON.stringify(result));
});

test('calculate times out and kills its recorded group', async t => {
  const f = await fixture(t, 300);
  const result = await f.run('setInterval(()=>{},1000)');
  assert.equal(result.isError, true, JSON.stringify(result)); assert.equal(result.details.timedOut, true, JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

test('calculate uses ordinary timeout wording with working top', async t => {
  const f = await fixture(t, 6000);
  const result = await f.run('console.log("FICTIONAL_RUNNING"); setInterval(()=>{},1000)');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.timedOut, true, JSON.stringify(result));
  assert.equal(result.details.status, 'timed out after 6 s', JSON.stringify(result));
  assert.equal(result.details.stdout, 'FICTIONAL_RUNNING\n', JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

test('calculate keeps ordinary timeout wording while paused with a recent valid top sample', async t => {
  const f = await fixture(t, 4500);
  const top = injectedTop(t, (_pid, samples) => samples.length ? 'slow' : 'real');
  const result = await f.run('setInterval(()=>{},1000)');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.timedOut, true, JSON.stringify(result));
  assert.equal(result.details.status, 'timed out after 4.5 s', JSON.stringify(result));
  assert.ok((top.samples[0]?.bytes ?? 0) > 0, JSON.stringify(result));
  assert.equal(top.delays.length, 1, JSON.stringify(result));
  assert.match(await top.delays[0].state, /T/, JSON.stringify(result));
  assert.deepEqual(f.signals.slice(-2).map(entry => entry.signal), ['SIGSTOP', 'SIGKILL'], JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

test('calculate labels a timeout when its last valid memory sample is stale', async t => {
  const f = await fixture(t, 6500);
  const top = injectedTop(t, (_pid, samples) => samples.length ? 'failed' : 'small');
  const result = await f.run('setInterval(()=>{},1000)');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.timedOut, true, JSON.stringify(result));
  assert.match(result.details.status, /timed out: calculation memory could not be checked/, JSON.stringify(result));
  assert.equal(top.samples[0].bytes, 20 * 1024 * 1024, JSON.stringify(result));
  assert.ok(top.samples.length > 1, JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

// Hold SIGCHLD delivery while a real child exits, as in the reviewer's macOS reproduction.
// Synchronous ps observes kernel state; Atomics.wait sleeps (no CPU loop). Only these tiny fictional cases stall the parent.
for (const racedSignal of ['SIGSTOP', 'SIGCONT'] as const) for (const ending of ['normal', 'SIGKILL']) test(`calculate preserves an unrecorded zombie ${ending} exit after ${racedSignal} EPERM`, async t => {
  const f = await fixture(t, RUN_MS, 6, false);
  const originalSpawn = childProcess.spawn, originalExec = childProcess.execFile, kill = process.kill.bind(process), timeout = globalThis.setTimeout;
  let child: ReturnType<typeof spawn>, zombieState = '', unreaped = false, pauseTimer: (() => void) | undefined;
  const failures: string[] = [], code = ending === 'normal' ? 'console.log(6*7)' : 'process.kill(process.pid,"SIGKILL")';
  const waitForZombie = (pid: number) => {
    for (let n = 0; n < 100; n++) {
      zombieState = childProcess.execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { env: { LC_ALL: 'C' } }).toString().trim();
      if (zombieState.includes('Z')) { unreaped = child.exitCode === null; return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    throw new Error(`Fictional child did not become a zombie: ${zombieState}`);
  };
  const mockedTimer = t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === 250) pauseTimer = () => callback(...args);
    return timeout(callback, ms, ...args);
  });
  const mockedSpawn = t.mock.method(childProcess, 'spawn', (...args: any[]) => {
    // CONT can race even before stdin is sent. This fixed trusted fixture exits without waiting for stdin EOF.
    child = racedSignal === 'SIGCONT' ? originalSpawn(process.execPath, ['-e', code], args[2]) : (originalSpawn as any)(...args);
    return child;
  });
  const mockedKill = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    try {
      if (racedSignal === 'SIGCONT' && signal === 'SIGCONT') {
        // The sample has been validated. Reproduce a CONT racing with exit by sleeping before redelivery.
        kill(pid, signal); waitForZombie(-pid);
      }
      return kill(pid, signal);
    } catch (error) {
      if ((signal === 'SIGSTOP' || signal === 'SIGCONT') && (error as NodeJS.ErrnoException).code === 'EPERM') failures.push(signal);
      throw error;
    }
  });
  let samples = 0;
  const mockedExec = t.mock.method(childProcess, 'execFile', (command: string, args: string[], options: any, callback: any) => {
    if (command !== '/usr/bin/top') return originalExec(command, args, options, callback);
    if (++samples === 1) setImmediate(() => {
      callback(null, `PID MEM\n${args.at(-1)} 20M\n`, '');
      if (racedSignal === 'SIGSTOP') setImmediate(() => {
        waitForZombie(Number(args.at(-1)));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 260);
        // Invoke the actual overdue pause callback before giving libuv an opportunity to reap SIGCHLD.
        pauseTimer!();
      });
    });
    return { kill() {} };
  });
  syncBuiltinESMExports();
  t.after(() => { mockedExec.mock.restore(); mockedSpawn.mock.restore(); mockedKill.mock.restore(); mockedTimer.mock.restore(); syncBuiltinESMExports(); });
  const result = await f.run(code);
  assert.match(zombieState, /Z/, JSON.stringify(result));
  assert.equal(unreaped, true, JSON.stringify(result));
  assert.deepEqual(failures, [racedSignal], JSON.stringify(result));
  assert.equal(result.isError, ending === 'normal' ? undefined : true, JSON.stringify(result));
  assert.equal(result.details.exitCode, ending === 'normal' ? 0 : null, JSON.stringify(result));
  assert.equal(result.details.signal, ending === 'normal' ? null : 'SIGKILL', JSON.stringify(result));
  assert.equal(result.details.status, ending === 'normal' ? 'exit 0' : 'exit SIGKILL', JSON.stringify(result));
  assert.equal(result.details.stdout, ending === 'normal' ? '42\n' : '', JSON.stringify(result));
});

for (const recorded of [true, false]) for (const failedSignal of ['SIGSTOP', 'SIGCONT'] as const) test(`calculate kills a live ${recorded ? 'recorded' : 'unrecorded'} group if ${failedSignal} fails`, async t => {
  const f = await fixture(t, RUN_MS, 6, recorded);
  injectedTop(t, () => 'small');
  const kill = process.kill.bind(process);
  let state = '';
  const mocked = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === failedSignal) {
      state = childProcess.execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(-pid)], { env: { LC_ALL: 'C' } }).toString().trim();
      throw Object.assign(new Error('Fictional signal refusal'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });
  t.after(() => mocked.mock.restore());
  const result = await f.run('console.log("FICTIONAL_CODE_RAN")');
  assert.ok(state.length > 0 && !state.includes('Z'), JSON.stringify(result));
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.signal, 'SIGKILL', JSON.stringify(result));
  assert.match(result.details.status, failedSignal === 'SIGSTOP' ? /could not pause calculation/ : /could not resume calculation/, JSON.stringify(result));
  assert.equal(result.details.stdout, '', JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

test('calculate cancellation kills an active process and rejects a pre-cancelled call', async t => {
  const f = await fixture(t), controller = new AbortController(), original = childProcess.spawn;
  let running!: (pid: number) => void;
  const started = new Promise<number>(resolve => { running = resolve; });
  const mocked = t.mock.method(childProcess, 'spawn', (...args: any[]) => {
    const child = (original as any)(...args);
    child.stdout?.on('data', (part: Buffer) => { if (part.toString().includes('FICTIONAL_RUNNING')) running(child.pid); });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const pending = f.run('console.log("FICTIONAL_RUNNING"); setInterval(()=>{},1000)', controller.signal);
  const pid = await Promise.race([started, pending.then(result => { throw new Error(`Calculation ended before its running marker: ${JSON.stringify(result)}`); })]);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.stdout, 'FICTIONAL_RUNNING\n', JSON.stringify(result));
  assert.equal(result.details.timedOut, false, JSON.stringify(result));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
  await assert.rejects(f.run('console.log(1)', controller.signal), /Cancelled before running/, JSON.stringify(result));
});

test('calculate cancellation kills a paused group before its first memory sample', async t => {
  const f = await fixture(t), controller = new AbortController();
  injectedTop(t, () => 'failed');
  const pending = f.run('setInterval(()=>{},1000)', controller.signal);
  let record: any;
  for (let n = 0; n < 200 && !record; n++) {
    const files = await readdir(join(f.root, 'processes')).catch(() => []);
    if (files[0]) record = JSON.parse(await readFile(join(f.root, 'processes', files[0]), 'utf8'));
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(record, JSON.stringify(record));
  await new Promise(resolve => setTimeout(resolve, 150));
  const state = await new Promise<string>((resolve, reject) => childProcess.execFile('/bin/ps', ['-o', 'stat=', '-p', String(record.pid)], (error, output) => error ? reject(error) : resolve(output)));
  controller.abort();
  const result = await pending;
  assert.match(state, /T/, JSON.stringify(result));
  assert.equal(result.details.stdout, '', JSON.stringify(result));
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.throws(() => process.kill(record.pid, 0), /ESRCH/, JSON.stringify(result));
  await assert.rejects(f.run('console.log(1)', controller.signal), /Cancelled before running/, JSON.stringify(result));
});

test('calculate exposes no lexical require; permission model denies indirect native APIs and filesystem', async t => {
  const f = await fixture(t, RUN_MS, 20), outside = join(f.root, 'outside.txt'), inside = join(f.cwd, 'inside.txt');
  await writeFile(outside, 'FICTIONAL_OUTSIDE'); await writeFile(inside, 'FICTIONAL_INSIDE');
  for (const code of ["require('child_process')", "require('fs')", "require('worker_threads')"]) {
    const result = await f.run(code);
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  // Indirect global access must obey the same OS/Node boundary as direct access.
  const escape = 'console.log.constructor("return process")()';
  for (const operation of [
    `p.getBuiltinModule('fs').readFileSync(${JSON.stringify(outside)})`,
    `p.getBuiltinModule('fs').readFileSync(${JSON.stringify(inside)})`,
    `p.getBuiltinModule('child_process').spawnSync('/usr/bin/true')`,
    `new (p.getBuiltinModule('worker_threads').Worker)('', {eval:true})`,
    `p.getBuiltinModule('inspector').open(0)`,
    `new (p.getBuiltinModule('wasi').WASI)({version:'preview1'})`,
    `p.getBuiltinModule('fs').writeFileSync('output.txt', 'no')`,
  ]) {
    const result = await f.run(`const p=${escape}; ${operation}`);
    assert.equal(result.isError, true, `${operation}: ${JSON.stringify(result)}`); assert.match(result.details.stderr, /ERR_ACCESS_DENIED/, `${operation}: ${JSON.stringify(result)}`);
  }
  const env = await f.run(`const p=${escape}; console.log(p.env.OPENAI_API_KEY, p.env.NODE_OPTIONS)`);
  assert.equal(env.details.stdout, 'undefined undefined\n', JSON.stringify(env));
});

test('calculate same-realm globals and CommonJS entry cannot bypass permissions', async t => {
  const f = await fixture(t, RUN_MS, 12);
  const globals = await f.run('console.log(typeof process, globalThis.process === process, typeof require, typeof module); console.log(process.env.OPENAI_API_KEY, process.env.NODE_OPTIONS)');
  assert.equal(globals.isError, undefined, JSON.stringify(globals));
  assert.equal(globals.details.stdout, 'object true undefined undefined\nundefined undefined\n', JSON.stringify(globals));
  for (const operation of [
    "process.binding('fs')",
    "process.dlopen({ exports: {} }, 'fictional-addon.node')",
    "process.mainModule.require('node:fs').readFileSync('run-1.js')",
    "process.mainModule.require('node:child_process').spawnSync('/usr/bin/true')",
    "new (process.mainModule.require('node:worker_threads').Worker)('', {eval:true})",
    "globalThis.process.getBuiltinModule('node:inspector').open(0)",
  ]) {
    const result = await f.run(operation);
    assert.equal(result.isError, true, `${operation}: ${JSON.stringify(result)}`);
    assert.match(result.details.stderr, /ERR_ACCESS_DENIED|ERR_DLOPEN_DISABLED/, `${operation}: ${JSON.stringify(result)}`);
  }
});

test('calculate Seatbelt refuses TCP/fetch, UDP and Unix sockets with EPERM', async t => {
  const f = await fixture(t); let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as any).port;
  assert.ok(![4318, 11434, 1234].includes(port), JSON.stringify({ port }));
  const escape = 'console.log.constructor("return process")()';
  const net = await f.run(`const p=${escape}; const s=p.getBuiltinModule('net').connect(${port}, '127.0.0.1'); s.on('connect',()=>console.log('connected')); s.on('error',e=>console.log('denied',e.code,e.syscall));`);
  assert.equal(net.details.stdout, 'denied EPERM connect\n', JSON.stringify(net));
  const fetch = await f.run(`console.log.constructor('return fetch')()('http://127.0.0.1:${port}').then(()=>console.log('connected'),e=>console.log('denied',e.cause?.code,e.cause?.syscall));`);
  assert.equal(fetch.details.stdout, 'denied EPERM connect\n', JSON.stringify(fetch)); assert.equal(connections, 0, JSON.stringify(fetch));
  const path = join(f.root, 'fictional.sock'), unixServer = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => unixServer.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => unixServer.close(() => resolve())));
  const unix = await f.run(`const s=process.getBuiltinModule('node:net').connect(${JSON.stringify(path)}); s.on('connect',()=>console.log('connected')); s.on('error',e=>console.log(e.code,e.syscall));`);
  assert.equal(unix.details.stdout, 'EPERM connect\n', JSON.stringify(unix)); assert.equal(connections, 0, JSON.stringify(unix));
  let packets = 0;
  const udpServer = createSocket('udp4'); udpServer.on('message', () => { packets++; });
  await new Promise<void>(resolve => udpServer.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => udpServer.close(resolve)));
  const udpPort = udpServer.address().port;
  assert.ok(![4318, 11434, 1234].includes(udpPort), JSON.stringify({ udpPort }));
  const udp = await f.run(`const s=process.getBuiltinModule('node:dgram').createSocket('udp4'); const failed=e=>{console.log(e.code,e.syscall);s.close();}; s.on('error',failed); s.send(Buffer.from('fictional'),${udpPort},'127.0.0.1',e=>{if(e)failed(e);else{console.log('sent');s.close();}});`);
  assert.match(udp.details.stdout, /^EPERM (?:bind|send)\n$/, JSON.stringify(udp)); assert.equal(packets, 0, JSON.stringify(udp));
});

test('calculate environment is an allowlist, not a credential-name filter', async t => {
  const f = await fixture(t);
  process.env = { HOME: join(f.root, 'home'), DATABASE_URL: 'fictional://database', PGPASSWORD: 'FICTIONAL_PG', GH_PAT: 'FICTIONAL_PAT', SSH_AUTH_SOCK: join(f.root, 'fictional.sock'), LANG: 'en_US.UTF-8', LC_NUMERIC: 'C', TZ: 'UTC' };
  const result = await f.run('console.log(JSON.stringify(process.env))');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.details.stdout), { LANG: 'en_US.UTF-8', LC_NUMERIC: 'C', TZ: 'UTC' }, JSON.stringify(result));
});

test('calculate Seatbelt denies SQLite task/material/snapshot/home reads and database creation', { skip: !existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec unavailable; SQLite denial requires the real Seatbelt path.' : false }, async t => {
  const f = await fixture(t, RUN_MS, 12), material = join(f.root, 'materials'), snapshot = join(f.root, 'data', 'scratch', 'memory-snapshots', 'job'), home = join(f.root, 'home');
  for (const dir of [material, snapshot, home]) await mkdir(dir, { recursive: true });
  process.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([f.cwd, material, snapshot, home]));
  for (const folder of [f.cwd, material, snapshot, home, f.root]) {
    const path = join(folder, 'lab.db'), db = new DatabaseSync(path);
    db.exec("CREATE TABLE measurements (value TEXT); INSERT INTO measurements VALUES ('FICTIONAL_SQLITE_CANARY')"); db.close();
    const read = await f.run(`const {DatabaseSync}=process.getBuiltinModule('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(path)},{readOnly:true}); console.log(db.prepare('SELECT * FROM measurements').all()); db.close();`);
    assert.equal(read.isError, true, JSON.stringify(read));
    assert.match(read.details.stderr, /unable to open database file/, JSON.stringify(read));
    assert.doesNotMatch(read.details.stdout, /FICTIONAL_SQLITE_CANARY/, JSON.stringify(read));
    const created = join(folder, 'planted.db');
    const write = await f.run(`const {DatabaseSync}=process.getBuiltinModule('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(created)}); db.exec('CREATE TABLE planted (x)'); db.close();`);
    assert.equal(write.isError, true, JSON.stringify(write));
    assert.match(write.details.stderr, /unable to open database file/, JSON.stringify(write));
    assert.equal(existsSync(created), false, JSON.stringify(write));
  }
});

test('calculate Seatbelt denies signals to another process', async t => {
  const f = await fixture(t), child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { child.kill('SIGKILL'); if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve())); });
  const result = await f.run(`try { process.kill(${child.pid}, 0); console.log('allowed'); } catch(e) { console.log(e.code, e.syscall); }`);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.details.stdout, 'EPERM kill\n', JSON.stringify(result));
});

test('calculate returns labelled capped stderr on success, including stderr-only results', async t => {
  const f = await fixture(t);
  const both = await f.run('console.log("answer"); console.error("fictional warning")');
  assert.equal(both.isError, undefined, JSON.stringify(both));
  assert.equal(both.content[0].text, 'answer\n\n--- stderr ---\nfictional warning\n', JSON.stringify(both));
  const only = await f.run('console.error("x".repeat(25000))');
  assert.equal(only.isError, undefined, JSON.stringify(only));
  assert.match(only.content[0].text, /--- stderr ---\nx+/, JSON.stringify(only));
  assert.match(only.content[0].text, /truncated at 20000 bytes/, JSON.stringify(only));
  assert.ok(only.content[0].text.length < 20200, JSON.stringify(only));
  const warning = await f.run('console.error("heap out of memory")');
  assert.equal(warning.isError, undefined, JSON.stringify(warning));
  assert.equal(warning.details.status, 'exit 0', JSON.stringify(warning));
  assert.equal(warning.details.memoryExceeded, false, JSON.stringify(warning));
});

test('calculate has a bounded heap and stops external memory growth before its time limit', async t => {
  const f = await fixture(t);
  const heap = await f.run("console.log(process.getBuiltinModule('node:v8').getHeapStatistics().heap_size_limit)");
  assert.equal(heap.isError, undefined, JSON.stringify(heap));
  assert.ok(Number(heap.details.stdout) <= 320 * 1024 * 1024, JSON.stringify(heap));
  assert.equal(heap.details.oldSpaceLimitMb, 256, JSON.stringify(heap));
  assert.equal(heap.details.physicalFootprintLimitMb, 512, JSON.stringify(heap));
  const external = [
    // Explicitly dirty pages before zeroing them: untouched demand-zero pages need not count as footprint.
    'Buffer.alloc(8*1024*1024,1).fill(0)',
    "process.getBuiltinModule('node:crypto').randomFillSync(Buffer.alloc(8*1024*1024))",
    'new Uint8Array(new ArrayBuffer(8*1024*1024)).fill(1).fill(0)',
    "process.getBuiltinModule('node:crypto').randomFillSync(new Uint8Array(new ArrayBuffer(8*1024*1024)))",
  ];
  for (const code of [
    "const kept=[]; for(let i=0;i<48;i++) kept.push(new Array(1000000).fill(i)); console.log('allocation ceiling reached')",
    // Bound even a regressed runner, but leave >2x the limit and several seconds for slow samples.
    ...external.map(allocation => `const kept=[]; const timer=setInterval(()=>{kept.push(${allocation}); if(kept.length===160){clearInterval(timer);console.log('allocation ceiling reached');}},25)`),
  ]) {
    // No wall-clock bound: paused time is mostly spent waiting for top. timedOut false and no ceiling output prove the stop.
    const result = await f.run(code);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /memory limit exceeded/i, JSON.stringify(result));
    assert.equal(result.details.timedOut, false, JSON.stringify(result));
    assert.equal(result.details.memoryExceeded, true, JSON.stringify(result));
    assert.doesNotMatch(result.details.stdout, /allocation ceiling reached/, JSON.stringify(result));
    assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
  }
});

test('calculate monitors physical footprint and fails closed when the probe fails', async t => {
  const f = await fixture(t, 1200), execFile = childProcess.execFile;
  for (const probe of ['excess', 'malformed', 'failed']) {
    let samples = 0;
    const mocked = t.mock.method(childProcess, 'execFile', (command: string, args: string[], options: any, callback: any) => {
      if (command !== '/usr/bin/top') return execFile(command, args, options, callback);
      assert.deepEqual(args.slice(0, -1), ['-l', '1', '-F', '-R', '-stats', 'pid,mem', '-pid'], JSON.stringify({ command, args }));
      samples++;
      // A live process can be omitted during the initial exec transition; the next sample must still enforce the limit.
      const output = probe === 'excess' ? samples === 1 ? 'Processes: 1 total\n' : `PID MEM\n${args.at(-1)} 513M\n` : 'PID MEM\n';
      return execFile(probe === 'failed' ? '/usr/bin/false' : '/usr/bin/printf', probe === 'failed' ? [] : ['%s', output], options, callback);
    });
    syncBuiltinESMExports();
    try {
      const result = await f.run('setInterval(()=>{},1000)');
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.details.timedOut, probe !== 'excess', JSON.stringify(result));
      assert.equal(result.details.memoryExceeded, probe === 'excess', JSON.stringify(result));
      if (probe === 'excess') assert.equal(samples, 2, JSON.stringify(result));
      else assert.ok(samples > 1, JSON.stringify(result));
      assert.match(result.details.status, probe === 'excess' ? /memory limit exceeded \(512 MB physical footprint\)/ : /timed out: calculation memory could not be checked/, JSON.stringify(result));
      assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('calculate pauses for top delayed six seconds mid-run, never exits above the memory limit', async t => {
  const f = await fixture(t);
  let delayed = false, signalsBeforeDelay = -1;
  const top = injectedTop(t, (pid, samples) => {
    if (!delayed && samples.some(sample => sample.pid === pid && (sample.bytes ?? 0) > 300 * 1024 * 1024)) {
      delayed = true; signalsBeforeDelay = f.signals.length; return 'slow';
    }
    return 'real';
  });
  const result = await f.run('const kept=[]; const timer=setInterval(()=>{kept.push(Buffer.alloc(8*1024*1024,1).fill(0)); if(kept.length===160){clearInterval(timer);console.log("allocation ceiling reached");}},25)');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok(result.details.memoryExceeded || (result.details.timedOut && /memory could not be checked/.test(result.details.status)), JSON.stringify(result));
  assert.notEqual(result.details.status, 'exit 0', JSON.stringify(result));
  assert.doesNotMatch(result.details.stdout, /allocation ceiling reached/, JSON.stringify(result));
  assert.equal(delayed, true, JSON.stringify(result));
  for (const delay of top.delays) assert.match(await delay.state, /T/, JSON.stringify(result));
  assert.ok(f.signals.some(entry => entry.signal === 'SIGCONT'), JSON.stringify(result));
  const midRunStop = f.signals.findIndex((entry, index) => index >= signalsBeforeDelay && entry.signal === 'SIGSTOP');
  assert.ok(midRunStop >= signalsBeforeDelay && midRunStop >= 0, JSON.stringify(result));
  assert.ok(f.signals.slice(midRunStop + 1).some(entry => entry.signal === 'SIGCONT'), JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
  t.diagnostic(`mid-run probe latencies ms: ${JSON.stringify(top.latencies)}`);
});

test('calculate waits through slow startup top for small code and forbidden reads', async t => {
  const f = await fixture(t);
  const seen = new Set<number>();
  const top = injectedTop(t, pid => { if (seen.has(pid)) return 'real'; seen.add(pid); return 'slow'; });
  await writeFile(join(f.cwd, 'inside.txt'), 'FICTIONAL_INSIDE');
  const started = performance.now(), small = await f.run('console.log(6*7)');
  assert.equal(small.isError, undefined, JSON.stringify(small));
  assert.equal(small.details.stdout, '42\n', JSON.stringify(small));
  assert.ok(performance.now() - started >= 5000, JSON.stringify(small));
  const denied = await f.run('process.getBuiltinModule("fs").readFileSync("inside.txt")');
  assert.equal(denied.isError, true, JSON.stringify(denied));
  assert.match(denied.details.stderr, /ERR_ACCESS_DENIED/, JSON.stringify(denied));
  for (const delay of top.delays) assert.match(await delay.state, /T/, JSON.stringify({ small, denied }));
  assert.equal(top.delays.length, 2, JSON.stringify({ small, denied }));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify({ small, denied }));
});

for (const recorded of [true, false]) test(`calculate never runs code when top always fails and kills the paused group at the deadline (${recorded ? 'recorded' : 'unrecorded'})`, async t => {
  const f = await fixture(t, 1200, 6, recorded);
  const top = injectedTop(t, () => 'failed');
  const started = performance.now(), result = await f.run('console.log("FICTIONAL_CODE_RAN")');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.stdout, '', JSON.stringify(result));
  assert.equal(result.details.stderr, '', JSON.stringify(result));
  assert.equal(result.details.timedOut, true, JSON.stringify(result));
  assert.equal(result.details.memoryExceeded, false, JSON.stringify(result));
  assert.match(result.details.status, /timed out: calculation memory could not be checked/, JSON.stringify(result));
  assert.ok(performance.now() - started < 5000, JSON.stringify(result));
  assert.ok(top.samples.length > 1 && top.samples.length < 20, JSON.stringify(result));
  assert.ok(f.signals.some(entry => entry.signal === 'SIGSTOP'), JSON.stringify(result));
  assert.ok(!f.signals.some(entry => entry.signal === 'SIGCONT'), JSON.stringify(result));
  assert.deepEqual(await readdir(join(f.root, 'processes')), [], JSON.stringify(result));
});

test('calculate parent exit kills a group stopped behind the recording gate', async t => {
  const f = await fixture(t);
  const source = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const original=cp.execFile;
    cp.execFile=(command,args,options,callback)=>command==='/usr/bin/top'
      ? original('/usr/bin/false',[],options,callback) : original(command,args,options,callback);
    syncBuiltinESMExports();
    const kill=process.kill.bind(process);
    process.kill=(pid,signal)=>{
      const value=kill(pid,signal);
      if(signal==='SIGSTOP'){console.log(JSON.stringify({pid:-pid}));setTimeout(()=>process.exit(0),100);}
      return value;
    };
    const {default:register}=await import(${JSON.stringify(new URL('../pi-extensions/calculate.ts', import.meta.url).href)});
    let tool; register({registerTool:definition=>{tool=definition;}});
    await tool.execute('fictional',{code:'console.log("FICTIONAL_CODE_RAN")'});
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
      cwd: f.cwd, env: { PATH: process.env.PATH, HOME: join(f.root, 'home'), CALCULATE_MS: '5000', MEETING_PROCESS_DIR: join(f.root, 'processes') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    parent.stdout.on('data', part => { stdout += part; }); parent.stderr.on('data', part => { stderr += part; });
    parent.on('error', reject); parent.on('close', code => resolve({ code, stdout, stderr }));
    t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); });
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.doesNotMatch(result.stdout, /FICTIONAL_CODE_RAN/, JSON.stringify(result));
  const { pid } = JSON.parse(result.stdout);
  // Register the group for the fixture's full non-zombie/stopped-member check, even on assertion failure.
  try { process.kill(-pid, 0); } catch { /* the parent's exit handler has already killed it */ }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, JSON.stringify(result));
});

let mathAvailable = false;
try { createRequire(import.meta.url).resolve('mathjs'); mathAvailable = true; } catch { /* installed by release owner later */ }
test('calculate accepts mathjs options/config and scope objects in the snippet realm', { skip: mathAvailable ? false : 'mathjs is not installed; real options/config regression requires the pinned dependency.' }, async t => {
  const f = await fixture(t);
  for (const [code, output] of [
    ["console.log(math.unit(42, 'km').to('mile').format({ precision: 5 }))", '26.098 mile\n'],
    ["const m = math.create(math.all, { number: 'BigNumber', precision: 64 }); console.log(m.evaluate('0.1 + 0.2').toString())", '0.3\n'],
    ['console.log(JSON.stringify(math.multiply(math.matrix([[1, 2], [3, 4]]), 2).toArray()))', '[[2,4],[6,8]]\n'],
    ["console.log(math.evaluate('x + y', { x: 2, y: 3 }))", '5\n'],
    ['console.log(math.add(math.fraction(1, 3), math.fraction(1, 6)).toFraction())', '1/2\n'],
    ['console.log(math.add(math.bignumber("0.1"), math.bignumber("0.2")).toString())', '0.3\n'],
  ]) {
    const result = await f.run(code);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.details.stdout, output, `${code}: ${JSON.stringify(result)}`);
  }
});

test('calculation memory limits comfortably allow small mathjs matrix work', { skip: mathAvailable ? false : 'mathjs is not installed; matrix work requires the pinned dependency.' }, async t => {
  const f = await fixture(t);
  const result = await f.run('const a=math.ones(128,128); const product=math.multiply(a,a); console.log(product.get([0,0]), product.size().join("x"))');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.details.stdout, '128 128x128\n', JSON.stringify(result));
});

test('calculate bundles mathjs including BigNumber and fractions', { skip: mathAvailable ? false : 'mathjs is not installed; owner must regenerate package-lock/install dependencies (offline task).' }, async t => {
  const f = await fixture(t);
  const result = await f.run('console.log(math.sqrt(81)); console.log(math.add(math.bignumber("0.1"), math.bignumber("0.2")).toString()); console.log(math.add(math.fraction(1,3), math.fraction(1,6)).toFraction())');
  assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.details.stdout, '9\n0.3\n1/2\n', JSON.stringify(result));
});
