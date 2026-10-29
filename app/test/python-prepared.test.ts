import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { managedPython } from './helpers/managed-python.ts';
import { preparedPython, pythonEnv, savePreparedPython } from '../pi-extensions/python-env.ts';
import { ensurePython, pythonStatus } from '../src/python-env.ts';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'python-prepared-'))), home = join(root, 'home'), data = join(root, 'data'), cwd = join(data, 'scratch', 'job');
  await mkdir(cwd, { recursive: true }); await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await managedPython(cwd, { ...process.env, HOME: home, MEETING_DATA_DIR: data });
  const cache = pythonEnv(runtime.env, cwd).UV_CACHE_DIR!, prefix = join(cache, 'archive-v0', 'fixture-env');
  await mkdir(join(prefix, 'bin'), { recursive: true }); await symlink(runtime.python, join(prefix, 'bin', 'python3'));
  await writeFile(join(prefix, 'pyvenv.cfg'), 'fictional prepared environment');
  return { root, home, data, cwd, runtime, cache, prefix, manifest: join(data, 'python', 'prepared.json') };
}

test('prepared environment ignores ambient active env and validates app-owned environment/interpreter paths', async t => {
  const f = await fixture(t), foreign = join(f.root, 'foreign');
  await mkdir(join(foreign, 'bin'), { recursive: true }); await symlink(f.runtime.python, join(foreign, 'bin', 'python3'));
  const env = pythonEnv({ ...f.runtime.env, VIRTUAL_ENV: foreign, UV_ACTIVE: '1' }, f.cwd);
  assert.equal(env.VIRTUAL_ENV, undefined); assert.equal(env.UV_ACTIVE, undefined);
  assert.equal(await preparedPython(env, f.cwd), null);
  await savePreparedPython(f.prefix, env, f.cwd);
  assert.equal(await preparedPython(env, f.cwd), f.prefix);
  assert.equal((await stat(f.manifest)).mode & 0o777, 0o600);
  await assert.rejects(savePreparedPython(foreign, env, f.cwd), /outside the app-owned/);
  await writeFile(f.manifest, JSON.stringify({ environment: foreign }));
  await assert.rejects(preparedPython(env, f.cwd), /outside the app-owned/);
});

test('prepared manifest rejects writable build temp and an interpreter outside the managed installation', async t => {
  const f = await fixture(t), temporary = join(f.cache, 'builds-v0', 'writable');
  await mkdir(join(temporary, 'bin'), { recursive: true }); await symlink(f.runtime.python, join(temporary, 'bin', 'python3'));
  await assert.rejects(savePreparedPython(temporary, f.runtime.env, f.cwd), /outside the app-owned/);
  const bad = join(f.cache, 'archive-v0', 'bad'); await mkdir(join(bad, 'bin'), { recursive: true });
  const outside = join(f.cwd, 'not-managed-python'); await writeFile(outside, 'fictional executable');
  await symlink(outside, join(bad, 'bin', 'python3'));
  await assert.rejects(savePreparedPython(bad, f.runtime.env, f.cwd), /outside the app-owned/);
});

test('app preparation records its environment and the real tool activates it without granting cache writes or manifest reads', async t => {
  const f = await fixture(t), saved = { ...process.env }, before = process.cwd();
  t.after(() => { process.chdir(before); process.env = saved; });
  const sentinel = join(f.prefix, 'read-only.py'); await writeFile(sentinel, 'fictional prepared package');
  const uv = join(f.root, 'uv');
  await writeFile(uv, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-c')){if(process.env.VIRTUAL_ENV)throw new Error('ambient env reached preparation');console.log(JSON.stringify({environment:${JSON.stringify(f.prefix)}}));}else{const out={active:process.argv.includes('--active'),offline:process.argv.includes('--offline'),environment:process.env.VIRTUAL_ENV};try{fs.writeFileSync(${JSON.stringify(sentinel)},'modified');out.cacheWrite='allowed';}catch(e){out.cacheWrite=e.code;}try{fs.readFileSync(${JSON.stringify(f.manifest)});out.manifestRead='allowed';}catch(e){out.manifestRead=e.code;}console.log(JSON.stringify(out));}\n`);
  await chmod(uv, 0o700);
  process.env = { ...f.runtime.env, PATH: `${f.root}${delimiter}${process.env.PATH}`, VIRTUAL_ENV: join(f.root, 'foreign'), UV_ACTIVE: '1', UV_OFFLINE: '1' };
  delete process.env.RUN_PYTHON_USED; delete process.env.MEETING_PROCESS_DIR;
  process.chdir(f.cwd);
  await ensurePython(f.data);
  assert.equal(pythonStatus().state, 'ready');
  assert.equal(JSON.parse(await readFile(f.manifest, 'utf8')).environment, f.prefix);
  const { default: register } = await import('../pi-extensions/run-python.ts');
  let tool: any; register({ registerTool: (value: any) => { tool = value; } } as any);
  const result = await tool.execute('prepared', { code: 'print(42)' });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { active: true, offline: true, environment: f.prefix, cacheWrite: 'EPERM', manifestRead: 'EPERM' });
});
