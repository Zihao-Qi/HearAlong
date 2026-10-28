import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'python-read-scope-')));
  const home = join(root, 'home'), materials = join(root, 'materials'), data = join(root, 'data'), cwd = join(data, 'scratch', 'actions', 'job');
  const snapshot = join(data, 'scratch', 'memory-snapshots', 'this-task');
  for (const path of [join(home, '.ssh'), materials, cwd, snapshot]) await mkdir(path, { recursive: true });
  await writeFile(join(home, '.ssh', 'fictional-key'), 'FICTIONAL_NOT_A_KEY');
  await writeFile(join(materials, 'guide.txt'), 'fictional attached material');
  await writeFile(join(snapshot, 'notes.md'), 'fictional snapshot');
  await writeFile(join(data, 'other-meeting.txt'), 'fictional other meeting');
  await symlink(join(home, '.ssh'), join(materials, 'escape'));
  const saved = { ...process.env }, before = process.cwd();
  Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    [READ_SCOPE_ENV]: JSON.stringify(readRoots([materials, snapshot, cwd])) });
  delete process.env.RUN_PYTHON_USED; delete process.env.MEETING_PROCESS_DIR;
  process.chdir(cwd);
  t.after(async () => { process.chdir(before); process.env = saved; await rm(root, { recursive: true, force: true }); });
  const { default: register } = await import('../pi-extensions/run-python.ts');
  let tool: any; register({ registerTool: (value: any) => { tool = value; } } as any);
  return { root, home, materials, snapshot, data, cwd, tool };
}

test('Seatbelt reads attached material and the supplied snapshot, not fictional SSH files or another meeting', async t => {
  const f = await fixture(t);
  const bin = join(f.root, 'bin'); await mkdir(bin);
  const uv = join(bin, 'uv'), policy = join(f.root, 'fictional-policy.ts');
  await writeFile(policy, 'fictional trusted policy');
  await writeFile(uv, `#!${process.execPath}\nconst fs = require('node:fs'); const result = {};\n` +
    `for (const [name,path] of Object.entries(${JSON.stringify({ attached: join(f.materials, 'guide.txt'), snapshot: join(f.snapshot, 'notes.md'), ssh: join(f.home, '.ssh', 'fictional-key'), escape: join(f.materials, 'escape', 'fictional-key'), otherMeeting: join(f.data, 'other-meeting.txt') })})) { try { result[name] = fs.readFileSync(path, 'utf8'); } catch { result[name] = 'denied'; } }\n` + `for (const [name,path] of Object.entries(${JSON.stringify({ attachedWrite: join(f.materials, 'guide.txt'), snapshotWrite: join(f.snapshot, 'notes.md'), policyWrite: policy, scratchWrite: join(f.cwd, 'output.txt') })})) { try { fs.writeFileSync(path, 'fictional output'); result[name] = 'allowed'; } catch { result[name] = 'denied'; } }\nconsole.log(JSON.stringify(result));\n`);
  await chmod(uv, 0o700);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  const result = await f.tool.execute('scope', { code: 'print("fixture")' });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { attached: 'fictional attached material', snapshot: 'fictional snapshot', ssh: 'denied', escape: 'denied', otherMeeting: 'denied', attachedWrite: 'denied', snapshotWrite: 'denied', policyWrite: 'denied', scratchWrite: 'allowed' });
});

test('real offline pinned Python imports packages, computes with numpy/sympy and enforces its user-file read scope', {
  skip: process.platform !== 'darwin' || !process.env.MEETING_TEST_PYTHON_CACHE ? 'Supply a prepared uv cache/runtime explicitly; never download packages in tests.' : false,
}, async t => {
  const cache = process.env.MEETING_TEST_PYTHON_CACHE!, managed = process.env.MEETING_TEST_PYTHON_INSTALL!;
  assert.ok(managed);
  const f = await fixture(t);
  Object.assign(process.env, { UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: managed });
  const result = await f.tool.execute('imports-and-scope', { code: `import json, pathlib, numpy as np, scipy, sympy as sp
out = {'versions': [np.__version__, scipy.__version__, sp.__version__], 'sum': int(np.arange(5).sum()), 'integral': str(sp.integrate(sp.Symbol('x'), (sp.Symbol('x'), 0, 2)))}
for name, path in ${JSON.stringify({ attached: join(f.materials, 'guide.txt'), snapshot: join(f.snapshot, 'notes.md'), ssh: join(f.home, '.ssh', 'fictional-key'), escape: join(f.materials, 'escape', 'fictional-key'), otherMeeting: join(f.data, 'other-meeting.txt') })}.items():
    try: out[name] = pathlib.Path(path).read_text()
    except PermissionError: out[name] = 'denied'
print(json.dumps(out))
` });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { versions: ['2.2.6', '1.15.3', '1.14.0'], sum: 10, integral: '2', attached: 'fictional attached material', snapshot: 'fictional snapshot', ssh: 'denied', escape: 'denied', otherMeeting: 'denied' });
});

test('real offline pinned Python runs scipy native linear algebra too', {
  skip: process.platform !== 'darwin' || !process.env.MEETING_TEST_PYTHON_CACHE ? 'Supply a prepared uv cache/runtime explicitly; never download packages in tests.' : false,
}, async t => {
  const cache = process.env.MEETING_TEST_PYTHON_CACHE!, managed = process.env.MEETING_TEST_PYTHON_INSTALL!;
  assert.ok(managed, 'MEETING_TEST_PYTHON_INSTALL is required with the explicit cache');
  const f = await fixture(t);
  Object.assign(process.env, { UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: managed });
  const result = await f.tool.execute('math', { code: `import json, pathlib, numpy as np, scipy.linalg, sympy as sp
out = {'versions': [np.__version__, __import__('scipy').__version__, sp.__version__], 'sum': int(np.arange(5).sum()), 'det': float(scipy.linalg.det(np.eye(2))), 'integral': str(sp.integrate(sp.Symbol('x'), (sp.Symbol('x'), 0, 2)))}
for name, path in ${JSON.stringify({ attached: join(f.materials, 'guide.txt'), snapshot: join(f.snapshot, 'notes.md'), ssh: join(f.home, '.ssh', 'fictional-key'), escape: join(f.materials, 'escape', 'fictional-key'), otherMeeting: join(f.data, 'other-meeting.txt') })}.items():
    try: out[name] = pathlib.Path(path).read_text()
    except PermissionError: out[name] = 'denied'
print(json.dumps(out))
` });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { versions: ['2.2.6', '1.15.3', '1.14.0'], sum: 10, det: 1, integral: '2', attached: 'fictional attached material', snapshot: 'fictional snapshot', ssh: 'denied', escape: 'denied', otherMeeting: 'denied' });
});
