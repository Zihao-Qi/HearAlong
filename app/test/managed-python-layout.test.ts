// Offline regression for uv's minor-version alias and cached-venv interpreter symlink layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { managedPython } from './helpers/managed-python.ts';
import { sandboxed } from '../pi-extensions/tool-sandbox.ts';
import { pythonEnv } from '../pi-extensions/python-env.ts';
const exec = promisify(execFile);

test('managed minor-version symlink and cached-venv alias canonicalize without exposing parent data', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-layout-'))), home = join(root, 'home'), data = join(root, 'data');
  const cwd = join(data, 'scratch', 'job'); await mkdir(cwd, { recursive: true }); await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await managedPython(cwd, { ...process.env, HOME: home });
  const locations = pythonEnv(runtime.env, cwd), managed = locations.UV_PYTHON_INSTALL_DIR!, cache = locations.UV_CACHE_DIR!;
  const patch = join(managed, 'cpython-3.12.13-macos-aarch64-none'), minor = join(managed, 'cpython-3.12-macos-aarch64-none');
  await mkdir(patch); await rename(dirname(runtime.python), join(patch, 'bin')); await symlink(patch, minor);
  const interpreter = join(minor, 'bin', 'python3'), actual = join(patch, 'bin', 'python3');
  const venv = join(cache, 'archive-v0', 'fictional-env', 'bin'); await mkdir(venv, { recursive: true });
  await symlink(interpreter, join(venv, 'python'));
  const sibling = join(data, 'other-meeting.txt'); await writeFile(sibling, 'FICTIONAL_OTHER_MEETING');
  const code = `const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const out={canonical:fs.realpathSync.native(${JSON.stringify(interpreter)}),cached:fs.realpathSync.native(${JSON.stringify(join(venv, 'python'))}),alias:fs.readlinkSync(${JSON.stringify(minor)})};
out.parents=[${JSON.stringify(data)},${JSON.stringify(join(data, 'python'))}].map(p=>fs.statSync(p).isDirectory());
for(const [key,fn] of Object.entries({siblingRead:()=>fs.readFileSync(${JSON.stringify(sibling)}),siblingStat:()=>fs.statSync(${JSON.stringify(sibling)}),dataList:()=>fs.readdirSync(${JSON.stringify(data)}),pythonParentList:()=>fs.readdirSync(${JSON.stringify(join(data, 'python'))})})) {try{fn();out[key]='allowed';}catch(e){out[key]=e.code;}}
const run=spawnSync(${JSON.stringify(interpreter)},['-c','print(6 * 7)'],{encoding:'utf8'});out.result=run.stdout;out.exit=run.status;out.stderr=run.stderr;const cached=spawnSync(${JSON.stringify(join(venv, 'python'))},['-c','print(6 * 7)'],{encoding:'utf8'});out.cachedResult=cached.stdout;out.cachedExit=cached.status;out.cachedError=cached.error?.code??null;console.log(JSON.stringify(out));`;
  const [command, args] = sandboxed(process.execPath, ['-e', code], cwd, runtime.env);
  const { stdout } = await exec(command, args, { cwd, env: runtime.env, timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout), { canonical: actual, cached: actual, alias: patch, parents: [true, true],
    siblingRead: 'EPERM', siblingStat: 'EPERM', dataList: 'EPERM', pythonParentList: 'EPERM', result: '42\n', exit: 0, stderr: '', cachedResult: '42\n', cachedExit: 0, cachedError: null });
});
