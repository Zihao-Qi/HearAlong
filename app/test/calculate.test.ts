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

// Startup includes Seatbelt, Node permissions and loading mathjs; it is not the subject of most tests.
const RUN_MS = 20_000;
async function fixture(t: any, ms = RUN_MS, runs = 6) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'calculate-'))), cwd = join(root, 'data', 'scratch', 'job');
  await mkdir(cwd, { recursive: true });
  const saved = { ...process.env }, previous = process.cwd();
  Object.assign(process.env, { HOME: join(root, 'home'), MEETING_DATA_DIR: join(root, 'data'), CALCULATE_MS: String(ms), CALCULATE_MAX_RUNS: String(runs), MEETING_PROCESS_DIR: join(root, 'processes'), OPENAI_API_KEY: 'FICTIONAL_SECRET', NODE_OPTIONS: '--inspect=0' });
  delete process.env.CALCULATE_USED;
  process.chdir(cwd);
  t.after(async () => { process.chdir(previous); process.env = saved; await rm(root, { recursive: true, force: true }); });
  const { default: register } = await import('../pi-extensions/calculate.ts');
  const exitListeners = new Set(process.listeners('exit'));
  let tool: any; register({ registerTool: (definition: any) => { tool = definition; } } as any);
  const ownedListeners = process.listeners('exit').filter(listener => !exitListeners.has(listener));
  t.after(() => { for (const listener of ownedListeners) process.removeListener('exit', listener); });
  return { root, cwd, tool, run: (code: string, signal?: AbortSignal) => tool.execute('fictional', { code }, signal) };
}

test('calculate prints output, is sequential, starts fresh, and limits runs', async t => {
  const f = await fixture(t, RUN_MS, 2);
  assert.equal(f.tool.name, 'calculate'); assert.equal(f.tool.executionMode, 'sequential');
  const a = await f.run('globalThis.fictional = 42; console.log(6 * 7)');
  assert.equal(a.isError, undefined, JSON.stringify(a)); assert.equal(a.details.stdout, '42\n');
  assert.equal((await f.run('console.log(typeof fictional)')).details.stdout, 'undefined\n');
  await assert.rejects(f.run('console.log(0)'), /calculate limit reached/);
  assert.deepEqual(await readdir(join(f.root, 'processes')), []);
});

test('calculate caps each output stream', async t => {
  const f = await fixture(t);
  const result = await f.run('console.log("x".repeat(25000)); console.error("y".repeat(25000))');
  assert.match(result.details.stdout, /truncated at 20000 bytes/); assert.match(result.details.stderr, /truncated at 20000 bytes/);
  assert.ok(result.details.stdout.length < 20100); assert.ok(result.details.stderr.length < 20100);
});

test('calculate times out and kills its recorded group', async t => {
  const f = await fixture(t, 300);
  const result = await f.run('while (true) {}');
  assert.equal(result.isError, true); assert.equal(result.details.timedOut, true);
  assert.deepEqual(await readdir(join(f.root, 'processes')), []);
});

test('calculate cancellation kills an active process and rejects a pre-cancelled call', async t => {
  const f = await fixture(t), controller = new AbortController();
  const pending = f.run('while (true) {}', controller.signal);
  let record: any;
  for (let n = 0; n < 200 && !record; n++) {
    const files = await readdir(join(f.root, 'processes')).catch(() => []);
    if (files[0]) record = JSON.parse(await readFile(join(f.root, 'processes', files[0]), 'utf8'));
    else await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(record);
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.abort();
  assert.equal((await pending).isError, true);
  assert.throws(() => process.kill(record.pid, 0), /ESRCH/);
  await assert.rejects(f.run('console.log(1)', controller.signal), /Cancelled before running/);
});

test('calculate exposes no lexical require; permission model denies indirect native APIs and filesystem', async t => {
  const f = await fixture(t, RUN_MS, 20), outside = join(f.root, 'outside.txt'), inside = join(f.cwd, 'inside.txt');
  await writeFile(outside, 'FICTIONAL_OUTSIDE'); await writeFile(inside, 'FICTIONAL_INSIDE');
  for (const code of ["require('child_process')", "require('fs')", "require('worker_threads')"]) assert.equal((await f.run(code)).isError, true);
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
    assert.equal(result.isError, true, operation); assert.match(result.details.stderr, /ERR_ACCESS_DENIED/, operation);
  }
  assert.equal((await f.run(`const p=${escape}; console.log(p.env.OPENAI_API_KEY, p.env.NODE_OPTIONS)`)).details.stdout, 'undefined undefined\n');
});

test('calculate same-realm globals and CommonJS entry cannot bypass permissions', async t => {
  const f = await fixture(t, RUN_MS, 12);
  const globals = await f.run('console.log(typeof process, globalThis.process === process, typeof require, typeof module); console.log(process.env.OPENAI_API_KEY, process.env.NODE_OPTIONS)');
  assert.equal(globals.isError, undefined, JSON.stringify(globals));
  assert.equal(globals.details.stdout, 'object true undefined undefined\nundefined undefined\n');
  for (const operation of [
    "process.binding('fs')",
    "process.dlopen({ exports: {} }, 'fictional-addon.node')",
    "process.mainModule.require('node:fs').readFileSync('run-1.js')",
    "process.mainModule.require('node:child_process').spawnSync('/usr/bin/true')",
    "new (process.mainModule.require('node:worker_threads').Worker)('', {eval:true})",
    "globalThis.process.getBuiltinModule('node:inspector').open(0)",
  ]) {
    const result = await f.run(operation);
    assert.equal(result.isError, true, operation);
    assert.match(result.details.stderr, /ERR_ACCESS_DENIED|ERR_DLOPEN_DISABLED/, operation);
  }
});

test('calculate Seatbelt refuses TCP/fetch, UDP and Unix sockets with EPERM', async t => {
  const f = await fixture(t); let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as any).port;
  assert.ok(![4318, 11434, 1234].includes(port));
  const escape = 'console.log.constructor("return process")()';
  const net = await f.run(`const p=${escape}; const s=p.getBuiltinModule('net').connect(${port}, '127.0.0.1'); s.on('connect',()=>console.log('connected')); s.on('error',e=>console.log('denied',e.code,e.syscall));`);
  assert.equal(net.details.stdout, 'denied EPERM connect\n');
  const fetch = await f.run(`console.log.constructor('return fetch')()('http://127.0.0.1:${port}').then(()=>console.log('connected'),e=>console.log('denied',e.cause?.code,e.cause?.syscall));`);
  assert.equal(fetch.details.stdout, 'denied EPERM connect\n'); assert.equal(connections, 0);
  const path = join(f.root, 'fictional.sock'), unixServer = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => unixServer.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => unixServer.close(() => resolve())));
  const unix = await f.run(`const s=process.getBuiltinModule('node:net').connect(${JSON.stringify(path)}); s.on('connect',()=>console.log('connected')); s.on('error',e=>console.log(e.code,e.syscall));`);
  assert.equal(unix.details.stdout, 'EPERM connect\n'); assert.equal(connections, 0);
  let packets = 0;
  const udpServer = createSocket('udp4'); udpServer.on('message', () => { packets++; });
  await new Promise<void>(resolve => udpServer.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => udpServer.close(resolve)));
  const udpPort = udpServer.address().port;
  assert.ok(![4318, 11434, 1234].includes(udpPort));
  const udp = await f.run(`const s=process.getBuiltinModule('node:dgram').createSocket('udp4'); const failed=e=>{console.log(e.code,e.syscall);s.close();}; s.on('error',failed); s.send(Buffer.from('fictional'),${udpPort},'127.0.0.1',e=>{if(e)failed(e);else{console.log('sent');s.close();}});`);
  assert.match(udp.details.stdout, /^EPERM (?:bind|send)\n$/); assert.equal(packets, 0);
});

test('calculate environment is an allowlist, not a credential-name filter', async t => {
  const f = await fixture(t);
  process.env = { HOME: join(f.root, 'home'), DATABASE_URL: 'fictional://database', PGPASSWORD: 'FICTIONAL_PG', GH_PAT: 'FICTIONAL_PAT', SSH_AUTH_SOCK: join(f.root, 'fictional.sock'), LANG: 'en_US.UTF-8', LC_NUMERIC: 'C', TZ: 'UTC' };
  const result = await f.run('console.log(JSON.stringify(process.env))');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.details.stdout), { LANG: 'en_US.UTF-8', LC_NUMERIC: 'C', TZ: 'UTC' });
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
    assert.match(read.details.stderr, /unable to open database file/);
    assert.doesNotMatch(read.details.stdout, /FICTIONAL_SQLITE_CANARY/);
    const created = join(folder, 'planted.db');
    const write = await f.run(`const {DatabaseSync}=process.getBuiltinModule('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(created)}); db.exec('CREATE TABLE planted (x)'); db.close();`);
    assert.equal(write.isError, true, JSON.stringify(write));
    assert.match(write.details.stderr, /unable to open database file/);
    assert.equal(existsSync(created), false);
  }
});

test('calculate Seatbelt denies signals to another process', async t => {
  const f = await fixture(t), child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { child.kill('SIGKILL'); if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve())); });
  const result = await f.run(`try { process.kill(${child.pid}, 0); console.log('allowed'); } catch(e) { console.log(e.code, e.syscall); }`);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.details.stdout, 'EPERM kill\n');
});

test('calculate returns labelled capped stderr on success, including stderr-only results', async t => {
  const f = await fixture(t);
  const both = await f.run('console.log("answer"); console.error("fictional warning")');
  assert.equal(both.isError, undefined);
  assert.equal(both.content[0].text, 'answer\n\n--- stderr ---\nfictional warning\n');
  const only = await f.run('console.error("x".repeat(25000))');
  assert.equal(only.isError, undefined);
  assert.match(only.content[0].text, /--- stderr ---\nx+/);
  assert.match(only.content[0].text, /truncated at 20000 bytes/);
  assert.ok(only.content[0].text.length < 20200);
  const warning = await f.run('console.error("heap out of memory")');
  assert.equal(warning.isError, undefined);
  assert.equal(warning.details.status, 'exit 0');
  assert.equal(warning.details.memoryExceeded, false);
});

test('calculate has a bounded heap and stops external memory growth before its time limit', async t => {
  const f = await fixture(t);
  const heap = await f.run("console.log(process.getBuiltinModule('node:v8').getHeapStatistics().heap_size_limit)");
  assert.equal(heap.isError, undefined, JSON.stringify(heap));
  assert.ok(Number(heap.details.stdout) <= 320 * 1024 * 1024, heap.details.stdout);
  assert.equal(heap.details.oldSpaceLimitMb, 256);
  assert.equal(heap.details.physicalFootprintLimitMb, 512);
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
    const started = performance.now(), result = await f.run(code);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /memory limit exceeded/i);
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.memoryExceeded, true);
    assert.doesNotMatch(result.details.stdout, /allocation ceiling reached/);
    assert.ok(performance.now() - started < 10000);
    assert.deepEqual(await readdir(join(f.root, 'processes')), []);
  }
});

test('calculate monitors physical footprint and fails closed when the probe fails', async t => {
  const f = await fixture(t), execFile = childProcess.execFile;
  for (const probe of ['excess', 'malformed', 'failed']) {
    let samples = 0;
    const mocked = t.mock.method(childProcess, 'execFile', (command: string, args: string[], options: any, callback: any) => {
      if (command !== '/usr/bin/top') return execFile(command, args, options, callback);
      assert.deepEqual(args.slice(0, -1), ['-l', '1', '-F', '-R', '-stats', 'pid,mem', '-pid']);
      samples++;
      // A live process can be omitted during the initial exec transition; the next sample must still enforce the limit.
      const output = probe === 'excess' ? samples === 1 ? 'Processes: 1 total\n' : `PID MEM\n${args.at(-1)} 513M\n` : 'PID MEM\n';
      return execFile(probe === 'failed' ? '/usr/bin/false' : '/usr/bin/printf', probe === 'failed' ? [] : ['%s', output], options, callback);
    });
    syncBuiltinESMExports();
    try {
      const result = await f.run('while (true) {}');
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.details.timedOut, false);
      assert.equal(result.details.memoryExceeded, probe === 'excess');
      assert.equal(samples, probe === 'excess' ? 2 : 1);
      assert.match(result.details.status, probe === 'excess' ? /memory limit exceeded \(512 MB physical footprint\)/ : /could not monitor calculation memory/);
      assert.deepEqual(await readdir(join(f.root, 'processes')), []);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  }
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
    assert.equal(result.details.stdout, output, code);
  }
});

test('calculation memory limits comfortably allow small mathjs matrix work', { skip: mathAvailable ? false : 'mathjs is not installed; matrix work requires the pinned dependency.' }, async t => {
  const f = await fixture(t);
  const result = await f.run('const a=math.ones(128,128); const product=math.multiply(a,a); console.log(product.get([0,0]), product.size().join("x"))');
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.details.stdout, '128 128x128\n');
});

test('calculate bundles mathjs including BigNumber and fractions', { skip: mathAvailable ? false : 'mathjs is not installed; owner must regenerate package-lock/install dependencies (offline task).' }, async t => {
  const f = await fixture(t);
  const result = await f.run('console.log(math.sqrt(81)); console.log(math.add(math.bignumber("0.1"), math.bignumber("0.2")).toString()); console.log(math.add(math.fraction(1,3), math.fraction(1,6)).toFraction())');
  assert.equal(result.isError, undefined); assert.equal(result.details.stdout, '9\n0.3\n1/2\n');
});
