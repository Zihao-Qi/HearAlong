// FIX6 regressions: URL syntax only (no DNS/network requests) and fictional filesystem/syscall probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathDecision, readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { sandboxed } from '../pi-extensions/tool-sandbox.ts';
const exec = promisify(execFile);

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scope-review-'))), home = join(root, 'home'), data = join(root, 'data');
  const cwd = join(data, 'scratch', 'job'), materials = join(root, 'materials'), snapshot = join(data, 'scratch', 'memory-snapshots', 'job');
  for (const path of [home, cwd, materials, snapshot]) await mkdir(path, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), MEETING_DATA_DIR: data,
    [READ_SCOPE_ENV]: JSON.stringify(readRoots([cwd, materials, snapshot])) };
  return { root, home, data, cwd, materials, snapshot, env };
}

test('N1: web URLs block private/loopback literals including WHATWG IPv4 normalization and IPv6 embedding', () => {
  const hosts = [
    'localhost', 'LOCALHOST.', 'a.localhost', 'a.b.localhost.', '127.0.0.1', '127.255.255.255', '127.1', '127.0x1',
    '2130706433', '0x7f000001', '0177.0.0.1', '017700000001', '%31%32%37.0.0.1', '0', '0.0.0.0',
    '10.0.0.1', '10.255.255.255', '10.1', '0xa000001', '172.16.0.1', '172.31.255.255', '172.16.1',
    '192.168.0.1', '3232235777', '0300.0250.0001.0001', '169.254.0.1', '169.254.255.255',
    '[::1]', '[0:0:0:0:0:0:0:1]', '[::]', '[fc00::1]', '[fdff:ffff::1]', '[fe80::1]', '[febf::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]', '[::7f00:1]', '[::ffff:10.0.0.1]',
    '[::ffff:172.31.0.1]', '[::ffff:192.168.1.1]', '[::ffff:169.254.1.1]', '[::ffff:0.0.0.0]',
    '[::10.0.0.1]', '[::172.16.0.1]', '[::192.168.0.1]', '[::169.254.0.1]',
  ];
  for (const host of hosts) for (const scheme of ['http', 'https']) for (const tool of ['fetch_content', 'get_search_content']) {
    const url = `${scheme}://${host}/fictional`;
    assert.ok(pathDecision(tool, { url }, '/tmp', []), url);
    assert.ok(pathDecision(tool, { urls: [url] }, '/tmp', []), url);
  }
});

test('N1: normal public hosts/IPs remain allowed and fetch_content requires a nonempty URL selection', () => {
  for (const host of ['example.invalid', 'example.invalid.', 'notlocalhost.invalid', '127.0.0.1.example.invalid', '8.8.8.8', '1.1.1.1',
    '172.15.255.255', '172.32.0.1', '192.167.1.1', '169.253.1.1', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]', '[::8.8.8.8]']) {
    assert.equal(pathDecision('fetch_content', { url: `https://${host}/fictional` }, '/tmp', []), undefined, host);
  }
  for (const input of [{}, { urls: [] }, { url: '' }, { urls: ['https://example.invalid', 'http://127.1'] }, { urls: 'https://example.invalid' }]) {
    assert.ok(pathDecision('fetch_content', input, '/tmp', []), JSON.stringify(input));
  }
  assert.equal(pathDecision('get_search_content', { responseId: 'fictional', queryIndex: 0 }, '/tmp', []), undefined);
});

test('N2: hardlinked regular files are refused under material, snapshot and explicit file roots', async t => {
  const f = await fixture(t), source = join(f.root, 'outside.txt'); await writeFile(source, 'fictional outside inode');
  for (const folder of [f.materials, f.snapshot]) {
    const planted = join(folder, 'planted.txt'); await link(source, planted);
    for (const roots of [readRoots([folder, f.cwd]), readRoots([planted, f.cwd])]) {
      assert.ok(pathDecision('read', { path: planted }, f.cwd, roots), planted);
    }
  }
  const safe = join(f.materials, 'copy.txt'); await writeFile(safe, 'fictional normal material');
  assert.equal(pathDecision('read', { path: safe }, f.cwd, readRoots([f.materials, f.cwd])), undefined);
});

test('N3: calculation roots with quote, backslash or newline fail before profile construction with a clear error', async t => {
  const f = await fixture(t);
  for (const name of ['My "Project"', 'My\\Project', 'My\nProject', 'My\rProject']) {
    const folder = join(f.root, name); await mkdir(folder);
    const env = { ...f.env, [READ_SCOPE_ENV]: JSON.stringify(readRoots([f.cwd, folder])) };
    assert.throws(() => sandboxed(process.execPath, ['-e', 'console.log(42)'], f.cwd, env), /this folder's name can't be used for calculations/i);
  }
  const badTarget = join(f.root, 'My "Project"'), alias = join(f.root, 'safe-alias'); await symlink(badTarget, alias);
  assert.throws(() => sandboxed(process.execPath, [], f.cwd, { ...f.env, [READ_SCOPE_ENV]: JSON.stringify(readRoots([f.cwd, alias])) }), /this folder's name can't be used for calculations/i);
});

test('N3: ordinary space/parenthesis names still build and run a profile', async t => {
  const f = await fixture(t), folder = join(f.root, 'My (Project)'); await mkdir(folder);
  const env = { ...f.env, [READ_SCOPE_ENV]: JSON.stringify(readRoots([f.cwd, folder])) };
  const [command, args] = sandboxed(process.execPath, ['-e', 'console.log(42)'], f.cwd, env);
  assert.equal((await exec(command, args, { cwd: f.cwd, env })).stdout.trim(), '42');
});

test('N4: calculation Seatbelt denies ordinary, hidden and credential-named snapshot contents', async t => {
  const f = await fixture(t);
  for (const [name, text] of [['brief.md', 'fictional approved brief'], ['api-token.md', 'FICTIONAL_TOKEN'], ['.env', 'FICTIONAL_ENV']]) await writeFile(join(f.snapshot, name), text);
  const code = `const fs=require('node:fs'), out={}; for(const name of ['brief.md','api-token.md','.env']) {try{out[name]=fs.readFileSync(${JSON.stringify(f.snapshot)}+'/'+name,'utf8');}catch(e){out[name]=e.code;}} console.log(JSON.stringify(out));`;
  const [command, args] = sandboxed(process.execPath, ['-e', code], f.cwd, f.env);
  const result = await exec(command, args, { cwd: f.cwd, env: f.env });
  assert.deepEqual(JSON.parse(result.stdout), { 'brief.md': 'EPERM', 'api-token.md': 'EPERM', '.env': 'EPERM' });
});

test('trusted calculation runtime reads survive an overlapping material exclusion without exposing sibling packages', async t => {
  const f = await fixture(t), library = join(f.materials, 'node_modules', 'fictional-maths');
  await mkdir(library, { recursive: true });
  const allowed = join(library, 'index.cjs'), denied = join(f.materials, 'node_modules', 'other.txt');
  await writeFile(allowed, 'FICTIONAL_MATHS'); await writeFile(denied, 'FICTIONAL_UNRELATED_PACKAGE');
  const code = `const fs=require('node:fs'),out={};for(const path of ${JSON.stringify([allowed, denied])}){try{out[path]=fs.readFileSync(path,'utf8');}catch(e){out[path]=e.code;}}console.log(JSON.stringify(out));`;
  const [command, args] = sandboxed(process.execPath, ['-e', code], f.cwd, f.env, [library]);
  const { stdout } = await exec(command, args, { cwd: f.cwd, env: f.env });
  assert.deepEqual(JSON.parse(stdout), { [allowed]: 'FICTIONAL_MATHS', [denied]: 'EPERM' });
});
