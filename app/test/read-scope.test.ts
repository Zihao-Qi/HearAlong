import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import register, { insideRoots, pathDecision, readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { piTaskArgs, READ_SCOPE_EXTENSION, runPiTask } from '../src/pi-task.ts';
import { fakePi } from './helpers/setup-pi.ts';

async function fixture(t: any) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'read-scope-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, 'Materials'), outside = join(folder, 'outside'), cwd = join(folder, 'scratch');
  for (const path of [root, outside, cwd]) await mkdir(path);
  await writeFile(join(root, 'Café.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'fictional outside');
  await symlink(outside, join(root, 'escape'));
  await symlink(root, join(outside, 'entrance'));
  await symlink(join(outside, 'missing'), join(root, 'dangling'));
  return { folder, root, outside, cwd, roots: readRoots([root, cwd]) };
}

test('file decisions: absolute, relative, traversal, sibling-prefix and missing paths', async t => {
  const f = await fixture(t);
  for (const tool of ['read', 'grep', 'find', 'ls', 'edit', 'write']) {
    for (const path of [join(f.root, 'Café.txt'), '../Materials/Café.txt', join(f.root, 'new', 'missing.txt')]) {
      if (tool === 'edit' || tool === 'write') assert.ok(pathDecision(tool, { path }, f.cwd, f.roots), `${tool}: ${path}`);
      else assert.equal(pathDecision(tool, { path }, f.cwd, f.roots), undefined, `${tool}: ${path}`);
    }
    for (const path of [join(f.outside, 'secret.txt'), '../outside/secret.txt', '../Materials/../outside/secret.txt', `${f.root}-sibling/new.txt`]) {
      assert.deepEqual(pathDecision(tool, { path }, f.cwd, f.roots), { block: true, reason: `${path} is outside this task's materials.` });
    }
  }
  for (const tool of ['edit', 'write']) assert.equal(pathDecision(tool, { path: join(f.cwd, 'output.txt') }, f.cwd, f.roots), undefined);
});

test('symlinks authorize their real target, including missing descendants and dangling links', async t => {
  const f = await fixture(t);
  for (const path of ['escape/secret.txt', 'escape/new.txt', 'dangling/child.txt']) assert.ok(pathDecision('read', { path: join(f.root, path) }, f.cwd, f.roots));
  assert.equal(pathDecision('read', { path: join(f.outside, 'entrance', 'Café.txt') }, f.cwd, f.roots), undefined);
});

test('omitted/default paths use the tool cwd; empty scopes never authorize a file or a shell', async t => {
  const f = await fixture(t);
  for (const tool of ['read', 'grep', 'find', 'ls']) {
    for (const input of [{}, { path: '' }]) {
      assert.equal(pathDecision(tool, input, f.cwd, f.roots), undefined);
      assert.ok(pathDecision(tool, input, f.outside, f.roots));
      assert.ok(pathDecision(tool, input, f.cwd, []));
    }
  }
  for (const tool of ['bash', 'powershell']) assert.ok(pathDecision(tool, { command: 'anything' }, f.cwd, f.roots));
});

test('a file root authorizes that file, not its siblings, parent or nonexistent children', async t => {
  const f = await fixture(t), file = join(f.root, 'Café.txt');
  const roots = readRoots([file]);
  assert.equal(insideRoots(file, roots), true);
  assert.equal(insideRoots(f.root, roots), false);
  assert.equal(insideRoots(join(f.root, 'other.txt'), roots), false);
  assert.equal(insideRoots(join(file, 'child'), roots), false);
  await link(file, join(f.root, 'hardlink.txt'));
  assert.equal(insideRoots(join(f.root, 'hardlink.txt'), roots), false);
});

test('filesystem identity handles macOS case and Unicode aliases without assuming a case-insensitive volume', async t => {
  const f = await fixture(t);
  const variants = [join(f.folder, 'materials', 'café.txt'), join(f.root.normalize('NFD'), 'Café.txt'.normalize('NFD'))];
  for (const path of variants) {
    let exists = false;
    try { await realpath(path); exists = true; } catch { /* A case-sensitive/non-normalizing volume need not have this alias. */ }
    assert.equal(insideRoots(path, readRoots([join(f.root, 'Café.txt')])), exists);
  }
  // Pi expands @, ~, file URLs and screenshot-name variants before a read; authorize that selected path too.
  assert.equal(pathDecision('read', { path: `@${join(f.root, 'Café.txt')}` }, f.cwd, f.roots), undefined);
  assert.equal(pathDecision('read', { path: new URL(`file://${join(f.outside, 'secret.txt')}`).href }, f.cwd, f.roots)?.block, true);
  await symlink(join(f.outside, 'secret.txt'), join(f.root, 'Capture’s.txt'));
  assert.ok(pathDecision('read', { path: join(f.root, "Capture's.txt") }, f.cwd, f.roots));
});

test('replacing a captured root with an outside symlink does not grant a new root', async t => {
  const f = await fixture(t);
  await rename(f.root, join(f.folder, 'moved-materials'));
  await symlink(f.outside, f.root);
  assert.ok(pathDecision('read', { path: join(f.root, 'secret.txt') }, f.cwd, f.roots));
});

test('missing or malformed environment scope installs a blocking hook rather than failing extension initialization', async t => {
  const f = await fixture(t), before = process.env[READ_SCOPE_ENV];
  t.after(() => { if (before === undefined) delete process.env[READ_SCOPE_ENV]; else process.env[READ_SCOPE_ENV] = before; });
  for (const value of [undefined, 'broken', '[]', '[{}]']) {
    if (value === undefined) delete process.env[READ_SCOPE_ENV]; else process.env[READ_SCOPE_ENV] = value;
    let handler: any;
    await register({ registerTool() {}, on: (event: string, fn: any) => { if (event === 'tool_call') handler = fn; } } as any);
    assert.equal(handler({ toolName: 'read', input: { path: f.root } }, { cwd: f.cwd }).block, true);
  }
});

test('the hook executes the canonical target, not the original symlink spelling', async t => {
  const f = await fixture(t), before = process.env[READ_SCOPE_ENV];
  t.after(() => { if (before === undefined) delete process.env[READ_SCOPE_ENV]; else process.env[READ_SCOPE_ENV] = before; });
  process.env[READ_SCOPE_ENV] = JSON.stringify(f.roots);
  let handler: any;
  await register({ registerTool() {}, on: (event: string, fn: any) => { if (event === 'tool_call') handler = fn; } } as any);
  const event = { toolName: 'read', input: { path: join(f.outside, 'entrance', 'Café.txt') } };
  assert.equal(handler(event, { cwd: f.cwd }), undefined);
  assert.equal(event.input.path, join(f.root, 'Café.txt'));
});

test('tasks without explicit roots fail closed; a scoped task gets only its captured roots and cwd', async t => {
  const f = await fakePi(t);
  for (const tools of [undefined, 'read', 'read,calculate']) {
    const args = piTaskArgs('Example', { model: 'example/main', cwd: f.cwd, tools, extensions: ['not-loaded.ts'] });
    assert.ok(args.includes('--no-tools'));
    assert.ok(!args.includes('--tools'));
    assert.ok(!args.includes('not-loaded.ts'));
    await runPiTask('Example', { model: 'example/main', cwd: f.cwd, env: { ...f.env, [READ_SCOPE_ENV]: 'inherited-invalid-scope' }, tools });
  }
  const args = piTaskArgs('Example', { model: 'example/main', cwd: f.cwd, tools: 'read', readRoots: [] });
  assert.ok(args.includes(READ_SCOPE_EXTENSION));
  assert.ok(!args.includes('--no-tools'));
  await assert.rejects(runPiTask('Example', { model: 'example/main', cwd: f.cwd, env: f.env, tools: 'read', readRoots: [join(f.cwd, 'absent-root')] }), /ENOENT/);
});

test('preassembled Pi CLI arguments cannot bypass the extension or the missing-roots fallback', async t => {
  const f = await fakePi(t);
  const base = { model: 'example/main', cwd: f.cwd, env: f.env, tools: 'read' };
  const args = ['--mode', 'json', '--model', base.model, '--tools', 'read', '--no-session', '--', 'Example'];
  await runPiTask('Example', { ...base, command: f.command, args, readRoots: [] });
  await runPiTask('Example', { ...base, args });
  const calls = await f.calls();
  assert.ok(calls[0].args.includes(READ_SCOPE_EXTENSION));
  assert.ok(calls[1].args.includes('--no-tools'));
  assert.ok(!calls[1].args.includes('--tools'));
  await assert.rejects(runPiTask('Example', { ...base, args: ['Example'] }), /declare --mode/);
});
