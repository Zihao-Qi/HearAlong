// Security regressions use only fictional files, isolated homes, and real per-process Seatbelt probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sandboxed } from '../pi-extensions/tool-sandbox.ts';
import { pathDecision, readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { piTaskArgs, runPiTask } from '../src/pi-task.ts';
const exec = promisify(execFile);

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scope-security-')));
  const home = join(root, 'home'), data = join(home, 'app-data'), cwd = join(data, 'scratch', 'task'), material = join(root, 'material');
  for (const path of [home, cwd, material, join(home, '.ssh'), join(home, '.pi', 'agent'), join(home, 'Library', 'Keychains')]) await mkdir(path, { recursive: true });
  const key = join(home, '.ssh', 'fictional-key'); await writeFile(key, 'FICTIONAL_SSH_CANARY');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), MEETING_DATA_DIR: data, [READ_SCOPE_ENV]: JSON.stringify(readRoots([material, cwd])) };
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = async (code: string) => {
    const [command, args] = sandboxed(process.execPath, ['-e', code], cwd, env);
    return exec(command, args, { cwd, env, timeout: 10_000 });
  };
  return { root, home, data, cwd, material, key, env, node };
}

test('H1: sandboxed stage 1 cannot plant project extensions or context files', async t => {
  const f = await fixture(t);
  const { stdout } = await f.node(`const fs=require('node:fs'), out={}; for(const path of ['.pi/extensions/canary.ts','.agents/skills/a.md','AGENTS.md','CLAUDE.md']) {try{fs.mkdirSync(require('node:path').dirname(path),{recursive:true});fs.writeFileSync(path,'fictional planted resource');out[path]='allowed';}catch(e){out[path]='denied';}} console.log(JSON.stringify(out));`);
  assert.deepEqual(JSON.parse(stdout), { '.pi/extensions/canary.ts': 'denied', '.agents/skills/a.md': 'denied', 'AGENTS.md': 'denied', 'CLAUDE.md': 'denied' });
});

test('H1: a continued Pi process ignores project extensions beneath a fictionally trusted parent', async t => {
  const f = await fixture(t), agent = join(f.home, '.pi', 'agent'), marker = join(f.root, 'loaded');
  await writeFile(join(agent, 'trust.json'), JSON.stringify({ [f.data]: true }));
  await mkdir(join(f.cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(f.cwd, '.pi', 'extensions', 'canary.ts'), `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)},'loaded');}`);
  const args = piTaskArgs('fictional', { model: 'fiction/model', cwd: f.cwd, tools: 'read', readRoots: [] });
  const head = args.slice(0, args.indexOf('--'));
  // Listing loads resources but never calls a model. Keep the same task flags before replacing the prompt with a listing.
  await exec(process.execPath, [fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/cli.js', import.meta.url)), ...head, '--list-models'], { cwd: f.cwd, env: { ...f.env, PI_OFFLINE: '1' }, timeout: 20_000 });
  assert.equal(existsSync(marker), false, 'a later Pi must not execute the planted project extension');
});

test('H2/S1: Seatbelt denies both symlink swaps and hardlink planting', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'inside.txt'), 'FICTIONAL_INSIDE_LINK');
  const { stdout } = await f.node(`const fs=require('node:fs'), out={}; for(const [name,fn] of Object.entries({hard:()=>fs.linkSync(${JSON.stringify(f.key)},'hard'),insideHardlink:()=>fs.linkSync('inside.txt','inside-hard.txt'),symlink:()=>fs.symlinkSync(${JSON.stringify(f.home)},'swap')})) {try {fn();out[name]='allowed';} catch(e){out[name]=e.code;}} console.log(JSON.stringify(out));`);
  assert.deepEqual(JSON.parse(stdout), { hard: 'EPERM', insideHardlink: 'EPERM', symlink: 'EPERM' });
});

test('S1: real sandboxed Node cannot plant or read an outside hardlink', async t => {
  const f = await fixture(t);
  const { stdout } = await f.node(`const fs=require('node:fs'),out={};try{fs.linkSync(${JSON.stringify(f.key)},'node-link');out.link='allowed';}catch{out.link='denied';}try{out.read=fs.readFileSync('node-link','utf8');}catch{out.read='unavailable';}console.log(JSON.stringify(out));`);
  assert.deepEqual(JSON.parse(stdout), { link: 'denied', read: 'unavailable' });
});

test('S1 second layer: the file hook refuses a regular hardlink planted in cwd', async t => {
  const f = await fixture(t), planted = join(f.cwd, 'hard'); await link(f.key, planted);
  assert.ok(pathDecision('read', { path: planted }, f.cwd, readRoots([f.cwd])));
});

test('H2: an attempted symlink swap between authorization and open cannot expose an outside file', async t => {
  const f = await fixture(t), folder = join(f.cwd, 'd'), file = join(folder, 'fictional-key');
  await mkdir(folder);
  assert.equal(pathDecision('read', { path: file }, f.cwd, readRoots([f.cwd])), undefined);
  const { stdout } = await f.node(`const fs=require('node:fs'); fs.rmdirSync('d'); try { fs.symlinkSync(${JSON.stringify(join(f.home, '.ssh'))},'d'); console.log('planted'); } catch(e) { console.log(e.code); }`);
  const text = await readFile(file, 'utf8').catch(() => 'not readable');
  assert.notEqual(text, 'FICTIONAL_SSH_CANARY');
  assert.equal(stdout.trim(), 'EPERM');
});

test('H2: concurrent checked reads remain safe during repeated sandboxed swap attempts; calculate is sequential', async t => {
  const f = await fixture(t), path = join(f.cwd, 'racing', 'fictional-key');
  await mkdir(join(f.cwd, 'racing'));
  const swapping = f.node(`const fs=require('node:fs'); let n=0,denied=0; const timer=setInterval(()=>{try{fs.rmdirSync('racing');}catch{}try{fs.symlinkSync(${JSON.stringify(join(f.home, '.ssh'))},'racing');fs.unlinkSync('racing');}catch(e){if(e.code==='EPERM')denied++;}try{fs.mkdirSync('racing');}catch{}if(++n===30){clearInterval(timer);console.log(denied);}},2);`);
  const roots = readRoots([f.cwd]);
  for (let n = 0; n < 30; n++) {
    // While the folder is briefly removed, refusing is the safe answer; allowing is fine while it exists. The safety
    // property is below: the read never returns the outside file.
    const decision = pathDecision('read', { path }, f.cwd, roots);
    assert.ok(decision === undefined || decision.block === true, JSON.stringify(decision));
    const text = await readFile(path, 'utf8').catch(() => 'missing');
    assert.notEqual(text, 'FICTIONAL_SSH_CANARY');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal((await swapping).stdout.trim(), '30');
  const { default: register } = await import('../pi-extensions/calculate.ts');
  let definition: any; register({ registerTool: (tool: any) => { definition = tool; } } as any);
  assert.equal(definition.executionMode, 'sequential');
});

test('M1/S3: unknown tools and path keys fail closed; URL tools accept only HTTP(S)', async t => {
  const f = await fixture(t), roots = readRoots([f.material, f.cwd]);
  for (const [tool, input] of [
    ['unknown_reader', { file: f.key }], ['read', { file_path: f.key }], ['read', { path: f.cwd, paths: [f.key] }],
    ['fetch_content', { url: f.key }], ['fetch_content', { urls: [`file://${f.key}`] }], ['fetch_content', { url: 'data:text/plain,fictional' }],
  ] as const) assert.ok(pathDecision(tool, input, f.cwd, roots), `${tool} ${JSON.stringify(input)}`);
  for (const name of ['toString', 'constructor', '__proto__']) assert.ok(pathDecision(name, {}, f.cwd, roots));
  for (const input of [{ url: 'https://example.invalid/a' }, { urls: ['http://example.invalid/b'] }]) assert.equal(pathDecision('fetch_content', input, f.cwd, roots), undefined);
});

test('M2: a scoped metadata launch ignores MEETING_PI and uses the bundled binary', async t => {
  const f = await fixture(t);
  const result = await runPiTask('fictional', { model: 'fiction/model', cwd: f.cwd, readRoots: [], tools: 'read',
    args: ['--mode', 'json', '--list-models'], env: { ...f.env, PI_OFFLINE: '1', MEETING_PI: '/usr/bin/false' }, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 0);
});

test('M3/S4: broad roots do not expose data, Pi credentials, hidden/credential components or case aliases', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, '.pi', 'agent', 'fictional.json'), 'fictional');
  await writeFile(join(f.data, 'other-meeting.txt'), 'fictional other meeting');
  await writeFile(join(f.material, '.env'), 'fictional');
  await writeFile(join(f.material, 'access-token.txt'), 'fictional');
  const saved = { ...process.env }; Object.assign(process.env, f.env);
  t.after(() => { process.env = saved; });
  const roots = readRoots([f.home, f.material, f.cwd]);
  for (const path of [join(f.data, 'other-meeting.txt'), join(f.home, '.pi', 'agent', 'fictional.json'), join(f.home, '.PI', 'agent', 'fictional.json'), join(f.material, '.env'), join(f.material, 'access-token.txt')]) assert.ok(pathDecision('read', { path }, f.cwd, roots), path);
  assert.equal(pathDecision('read', { path: join(f.cwd, 'output.txt') }, f.cwd, roots), undefined);
});

test('M3: an attached sibling scratch directory is not the task snapshot exception', async t => {
  const f = await fixture(t), other = join(f.data, 'scratch', 'other-job');
  await mkdir(other); await writeFile(join(other, 'output.txt'), 'FICTIONAL_OTHER_TASK');
  f.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([other, f.cwd]));
  const { stdout } = await f.node(`try{console.log(require('node:fs').readFileSync(${JSON.stringify(join(other, 'output.txt'))},'utf8'));}catch(e){console.log(e.code);}`);
  assert.equal(stdout.trim(), 'EPERM');
});

test('M3: Node also refuses excluded descendants beneath a broadly attached material folder', async t => {
  const f = await fixture(t);
  f.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([f.home, f.cwd]));
  const { stdout } = await f.node(`try{console.log(require('node:fs').readFileSync(${JSON.stringify(f.key)},'utf8'));}catch(e){console.log(e.code);}`);
  assert.equal(stdout.trim(), 'EPERM');
});

test('M3: recursive searches refuse trees containing excluded descendants but permit a clean subtree', async t => {
  const f = await fixture(t), safe = join(f.material, 'safe'); await mkdir(safe);
  await writeFile(join(safe, 'guide.txt'), 'fictional ordinary result');
  await writeFile(join(f.material, '.env'), 'FICTIONAL_HIDDEN_RESULT');
  for (const tool of ['grep', 'find']) {
    assert.ok(pathDecision(tool, { path: f.material, pattern: 'fictional' }, f.cwd, readRoots([f.material, f.cwd])));
    assert.equal(pathDecision(tool, { path: safe, pattern: 'fictional' }, f.cwd, readRoots([f.material, f.cwd])), undefined);
  }
});

test('H2: generated code cannot signal its trusted supervisor or another process', async t => {
  const f = await fixture(t), canary = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { canary.once('spawn', resolve); canary.once('error', reject); });
  t.after(async () => { canary.kill('SIGKILL'); if (canary.exitCode === null && canary.signalCode === null) await new Promise<void>(resolve => canary.once('exit', () => resolve())); });
  const { stdout } = await f.node(`try{process.kill(${canary.pid},'SIGCONT');console.log('allowed');}catch(e){console.log(e.code);}`);
  assert.equal(stdout.trim(), 'EPERM');
});

test('M5/S2: a fictional outside Unix socket cannot be reached from the sandbox', async t => {
  const f = await fixture(t), path = join(f.root, 'canary.sock'); let connections = 0;
  const server = createServer(socket => { connections++; socket.end('fictional socket canary'); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { stdout } = await f.node(`const s=require('node:net').connect(${JSON.stringify(path)}); s.on('connect',()=>{console.log('connected');s.destroy();});s.on('error',()=>console.log('denied'));`);
  assert.equal(stdout.trim(), 'denied'); assert.equal(connections, 0);
});

test('S4: Seatbelt denies a case-variant Pi path even when HOME is attached', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, '.pi', 'agent', 'fictional.json'), 'FICTIONAL_PI_CASE_CANARY');
  f.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([f.home, f.cwd]));
  const { stdout } = await f.node(`try { console.log(require('node:fs').readFileSync(${JSON.stringify(join(f.home, '.PI', 'agent', 'fictional.json'))},'utf8')); } catch(e) { console.log(e.code); }`);
  assert.equal(stdout.trim(), 'EPERM');
});

test('M5: unrelated Node is not executable when it is not the selected fixture interpreter', async t => {
  const f = await fixture(t);
  const [command, args] = sandboxed('/bin/sh', ['-c', `exec '${process.execPath}' -e 'console.log(42)'`], f.cwd, f.env);
  await assert.rejects(exec(command, args, { cwd: f.cwd, env: f.env, timeout: 10_000 }), error => { assert.match((error as any).stderr, /not permitted/i); return true; });
});

test('M5: outside xattrs and preference/clipboard/Spotlight helpers are unavailable', async t => {
  const f = await fixture(t), file = join(f.root, 'outside.txt'); await writeFile(file, 'fictional');
  await exec('/usr/bin/xattr', ['-w', 'org.hearalong.fictional', 'FICTIONAL_XATTR', file]);
  const { stdout } = await f.node(`const {spawnSync}=require('node:child_process');const out={};for(const [name,cmd,args] of ${JSON.stringify([
    ['xattr', '/usr/bin/xattr', ['-p', 'org.hearalong.fictional', file]],
    ['defaults', '/usr/bin/defaults', ['read', join(f.root, 'fictional-preferences')]],
    ['pbpaste', '/usr/bin/pbpaste', []], ['mdfind', '/usr/bin/mdfind', ['-onlyin', f.root, 'fictional']],
  ])}) {const r=spawnSync(cmd,args,{encoding:'utf8'});out[name]={error:r.error?.code,status:r.status};} console.log(JSON.stringify(out));`);
  const result = JSON.parse(stdout);
  for (const value of Object.values(result) as any[]) assert.equal(value.error, 'EPERM', JSON.stringify(result));
});

test('L2: scoped tasks require explicit tools; mutation is scratch-only', async t => {
  const f = await fixture(t);
  for (const tools of [undefined, '+read', 'read,*', 'read,unknown_reader']) assert.ok(piTaskArgs('fictional', { model: 'fiction/model', cwd: f.cwd, readRoots: [], tools }).includes('--no-tools'));
  for (const tool of ['edit', 'write']) {
    assert.ok(pathDecision(tool, { path: join(f.material, 'guide.txt') }, f.cwd, readRoots([f.material, f.cwd])));
    assert.equal(pathDecision(tool, { path: join(f.cwd, 'guide.txt') }, f.cwd, readRoots([f.material, f.cwd])), undefined);
  }
});
