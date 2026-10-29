import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryRoots } from '../pi-extensions/calculate.ts';

// Fictional packages test resolution offline, not a substitute for the skipped real-mathjs check.
test('calculation read allowances include only the maths dependency closure, including subpath-only packages', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'calculate-libraries-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const math = join(root, 'node_modules', 'mathjs'), dependency = join(root, 'node_modules', '@fictional', 'runtime');
  await mkdir(math, { recursive: true }); await mkdir(dependency, { recursive: true });
  await writeFile(join(math, 'package.json'), JSON.stringify({ name: 'mathjs', main: 'index.cjs', dependencies: { '@fictional/runtime': '1.0.0' } }));
  await writeFile(join(math, 'index.cjs'), 'module.exports = { fictional: true };');
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fictional/runtime', exports: { './package.json': './package.json', './helper': './helper.cjs' } }));
  await writeFile(join(dependency, 'helper.cjs'), 'module.exports = 1;');
  const libraries = libraryRoots(join(root, 'runner.cjs'));
  assert.equal(libraries.entry, join(math, 'index.cjs'));
  assert.deepEqual(libraries.roots.sort(), [math, dependency].sort());
  assert.ok(!libraries.roots.includes(join(root, 'node_modules')));
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: '@fictional/runtime', exports: { './package.json': './package.json' }, dependencies: { 'fictional-missing-dependency': '1.0.0' } }));
  assert.throws(() => libraryRoots(join(root, 'runner.cjs')), /fictional-missing-dependency/);
});
