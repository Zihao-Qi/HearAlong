import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import register, { readRoots, READ_SCOPE_ENV } from '../pi-extensions/read-scope.ts';
import { createGrepToolDefinition } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js';
import { createFindToolDefinition } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/find.js';
import { fixture as planFixture, rawPlan, PINS, tool } from './plans-fixture.ts';
import { checkPlans } from '../src/plans/validate.ts';

type Input = Record<string, unknown>;
async function toolsFor(cwd: string, paths: string[]) {
  const previous = process.env[READ_SCOPE_ENV];
  process.env[READ_SCOPE_ENV] = JSON.stringify(readRoots([...paths, cwd]));
  const definitions: Record<string, any> = {};
  try { await register({ registerTool: (definition: any) => { definitions[definition.name] = definition; }, on() {} } as any); }
  finally { if (previous === undefined) delete process.env[READ_SCOPE_ENV]; else process.env[READ_SCOPE_ENV] = previous; }
  assert.ok(definitions.grep && definitions.find, 'the bundled extension must replace both managed-tool implementations');
  const execute = (name: string, input: Input, signal?: AbortSignal) => definitions[name].execute('fictional-call', input, signal, undefined, { cwd });
  const text = async (name: string, input: Input, signal?: AbortSignal): Promise<string> => (await execute(name, input, signal)).content[0].text;
  return { definitions, execute, text };
}
async function fixture(t: any) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'node-search-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const material = join(folder, 'material'), cwd = join(folder, 'scratch');
  await mkdir(material); await mkdir(cwd);
  return { folder, material, cwd, ...await toolsFor(cwd, [material]) };
}

test('replacement tools keep Pi names, parameters, regex/literal/case flags and relative output', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.definitions.grep.parameters, createGrepToolDefinition('.').parameters);
  assert.deepEqual(f.definitions.find.parameters, createFindToolDefinition('.').parameters);
  await writeFile(join(f.material, 'guide.txt'), 'one lantern\nLANTERN 42\nlantern.*\n');
  assert.equal(await f.text('grep', { path: f.material, pattern: '^LANTERN \\d+$' }), 'guide.txt:2: LANTERN 42');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'lantern', ignoreCase: true, limit: 1 }), 'guide.txt:1: one lantern\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]');
  assert.equal(await f.text('grep', { path: join(f.material, 'guide.txt'), pattern: 'LANTERN.*', literal: true, ignoreCase: true }), 'guide.txt:3: lantern.*');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'absent' }), 'No matches found');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.md' }), 'No files found matching pattern');
  await assert.rejects(f.execute('grep', { path: f.material, pattern: '[' }), /regular expression/i);
});

test('glob filters use basenames without slashes and relative paths with slashes; find includes folders', async t => {
  const f = await fixture(t);
  await mkdir(join(f.material, 'src')); await mkdir(join(f.material, 'src', 'nested'));
  for (const file of ['a.ts', 'D.TS', 'src/b.ts', 'src/c.js', 'src/nested/d.spec.ts']) await writeFile(join(f.material, file), 'fictional match');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.ts' }), 'D.TS\na.ts\nsrc/b.ts\nsrc/nested/d.spec.ts');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.TS' }), 'D.TS');
  assert.equal(await f.text('find', { path: f.material, pattern: 'src/**/*.ts' }), 'src/b.ts\nsrc/nested/d.spec.ts');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.{js,ts}' }), 'D.TS\na.ts\nsrc/b.ts\nsrc/c.js\nsrc/nested/d.spec.ts');
  assert.equal(await f.text('find', { path: f.material, pattern: '[ab].ts' }), 'a.ts\nsrc/b.ts');
  assert.equal(await f.text('find', { path: f.material, pattern: 'nested' }), 'src/nested/');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'match', glob: '**/*.spec.ts' }), 'src/nested/d.spec.ts:1: fictional match');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'match', glob: '!*.ts' }), 'D.TS:1: fictional match\nsrc/c.js:1: fictional match');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.ts', limit: 1 }), 'D.TS\n\n[1 results limit reached. Use limit=2 for more, or refine pattern]');
  await writeFile(join(f.cwd, 'default.txt'), 'default path');
  assert.equal(await f.text('find', { pattern: '*.txt' }), 'default.txt');
  await assert.rejects(f.execute('find', { path: join(f.cwd, 'default.txt'), pattern: '*' }), /Not a directory/);
});

test('default limits remain 100 matching lines and 1000 find results', async t => {
  const f = await fixture(t);
  await writeFile(join(f.material, 'guide.txt'), 'fictional lantern\n'.repeat(110));
  const grep = await f.execute('grep', { path: f.material, pattern: 'lantern' });
  assert.equal(grep.details.matchLimitReached, 100);
  assert.equal(grep.content[0].text.split('\n\n')[0].split('\n').length, 100);
  for (let batch = 0; batch < 10; batch++) await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(f.material, `f${batch * 100 + i}.txt`), '')));
  const find = await f.execute('find', { path: f.material, pattern: '*.txt' });
  assert.equal(find.details.resultLimitReached, 1000);
  assert.equal(find.content[0].text.split('\n\n')[0].split('\n').length, 1000);
});

test('context blocks preserve match/context separators, line numbers, CRLF and duplicate overlaps', async t => {
  const f = await fixture(t), file = join(f.material, 'guide.txt');
  await writeFile(file, 'before\r\nmatch one\r\nmatch two\r\nafter\r\n');
  assert.equal(await f.text('grep', { path: file, pattern: '^match', context: 1 }),
    'guide.txt-1- before\nguide.txt:2: match one\nguide.txt-3- match two\nguide.txt-2- match one\nguide.txt:3: match two\nguide.txt-4- after');
});

test('large context and result requests stay within Pi’s 50 KiB output cap', async t => {
  const f = await fixture(t), file = join(f.material, 'guide.txt');
  await writeFile(file, `${'x'.repeat(800)}\n`.repeat(1000) + 'match\n');
  const result = await f.execute('grep', { path: file, pattern: 'match', context: 1_000_000_000, limit: 1_000_000_000 });
  assert.equal(result.details.truncation.truncated, true);
  assert.ok(result.details.truncation.outputBytes <= 50 * 1024);
  assert.equal(result.details.linesTruncated, true);
  assert.match(result.content[0].text, /50\.0KB limit reached/);
  const all = await f.execute('grep', { path: file, pattern: '.', limit: 1_000_000_000 });
  assert.equal(all.details.truncation.truncated, true);
  assert.ok(all.details.truncation.outputBytes <= 50 * 1024);
});

test('context history copies short prefixes instead of retaining whole multi-MiB source lines', { timeout: 30000 }, async t => {
  const f = await fixture(t), file = join(f.material, 'context.txt'), fd = await open(file, 'w');
  try {
    const row = Buffer.from('x'.repeat(1024 * 1024 - 1) + '\n');
    for (let i = 0; i < 128; i++) await fd.write(row);
    await fd.write(Buffer.from('fictional match\n'));
  } finally { await fd.close(); }
  const result = await f.execute('grep', { path: file, pattern: 'fictional match', context: 128 });
  assert.ok(result.content[0].text.startsWith('context.txt-1- '));
  assert.equal(result.details.linesTruncated, true);
  assert.equal(result.details.truncation.truncated, true);
});

test('binary files are skipped even when their NUL comes after an early text match', async t => {
  const f = await fixture(t);
  await writeFile(join(f.material, 'binary.bin'), Buffer.concat([Buffer.from('fictional binary canary\n'), Buffer.alloc(100_000, 65), Buffer.from([0])]));
  await writeFile(join(f.material, 'text.txt'), 'fictional text lantern');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'fictional' }), 'text.txt:1: fictional text lantern');
});

test('long lines are searched past the displayed prefix; over-8-MiB lines fail explicitly, never silently miss', async t => {
  const f = await fixture(t), file = join(f.material, 'long.txt');
  await writeFile(file, 'x'.repeat(200_000) + 'fictional lantern\n');
  const result = await f.execute('grep', { path: file, pattern: 'fictional lantern$' });
  assert.equal(result.details.linesTruncated, true);
  assert.ok(result.content[0].text.startsWith(`long.txt:1: ${'x'.repeat(500)}... [truncated]`));
  await writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(f.execute('grep', { path: file, pattern: 'absent' }), /line exceeds 8 MiB/);
});

test('both replacements preserve outside, unknown-key, exclusion, hardlink and symlink refusals', async t => {
  const f = await fixture(t), safe = join(f.material, 'safe');
  await mkdir(safe); await writeFile(join(safe, 'guide.txt'), 'fictional');
  const outside = join(f.folder, 'outside.txt'); await writeFile(outside, 'fictional outside canary');
  for (const name of ['grep', 'find']) {
    const pattern = name === 'grep' ? 'fictional' : '*.txt';
    await assert.rejects(f.execute(name, { path: outside, pattern }), /outside this task's materials/);
    await assert.rejects(f.execute(name, { path: safe, pattern, extra: true }), /outside this task's materials/);
    assert.match(await f.text(name, { path: safe, pattern }), /guide\.txt/);
  }
  for (const problem of ['.gitignore', 'access-token.txt', 'node_modules']) {
    const file = join(f.material, problem); await writeFile(file, 'fictional ignored');
    for (const name of ['grep', 'find']) await assert.rejects(f.execute(name, { path: f.material, pattern: '*' }), /excluded or sensitive paths/);
    await rm(file);
  }
  await link(outside, join(f.material, 'hard.txt'));
  for (const name of ['grep', 'find']) await assert.rejects(f.execute(name, { path: f.material, pattern: '*' }), /excluded or sensitive paths/);
  await rm(join(f.material, 'hard.txt'));
  await symlink(outside, join(f.material, 'escape.txt'));
  for (const name of ['grep', 'find']) await assert.rejects(f.execute(name, { path: f.material, pattern: '*' }), /excluded or sensitive paths/);
});

test('read-scope’s 20,000-entry recursion refusal remains in force for both replacements', async t => {
  const f = await fixture(t), file = join(f.material, 'guide.txt');
  // Distinct empty directories, not hardlinks (which would exercise a different refusal).
  for (let batch = 0; batch < 200; batch++) await Promise.all(Array.from({ length: 100 }, (_, i) => mkdir(join(f.material, `d${batch * 100 + i}`))));
  await writeFile(file, 'fictional');
  for (const name of ['grep', 'find']) {
    await assert.rejects(f.execute(name, { path: f.material, pattern: '*' }), /excluded or sensitive paths/);
  }
});

test('ancestor/global ignores are not consulted outside the authorized tree', async t => {
  const f = await fixture(t);
  await writeFile(join(f.folder, '.gitignore'), '*.txt\n');
  await writeFile(join(f.material, 'guide.txt'), 'fictional lantern');
  assert.equal(await f.text('grep', { path: f.material, pattern: 'lantern' }), 'guide.txt:1: fictional lantern');
  assert.equal(await f.text('find', { path: f.material, pattern: '*.txt' }), 'guide.txt');
});

test('cancellation before work and during worker execution settles promptly, including pathological regexes', async t => {
  const f = await fixture(t), file = join(f.material, 'guide.txt');
  await writeFile(file, 'a'.repeat(30_000) + '!\n');
  const already = AbortSignal.abort();
  for (const name of ['grep', 'find']) await assert.rejects(f.execute(name, { path: f.material, pattern: '*'}, already), /Operation aborted/);
  const started = performance.now();
  await assert.rejects(f.execute('grep', { path: file, pattern: '(a+)+$' }, AbortSignal.timeout(150)), /Operation aborted/);
  assert.ok(performance.now() - started < 3000, 'worker termination must not wait for regex evaluation');
  await assert.rejects(f.execute('find', { path: f.material, pattern: '*' }, AbortSignal.timeout(1)), /Operation aborted/);
});

test('replacement grep output remains material evidence and validates quotes; cut suffixes stay unseen', async t => {
  const f = await planFixture(); t.after(f.close);
  const search = await toolsFor(f.cwd, [f.materials]);
  const args = { path: f.materials, pattern: 'Reopen the kiln', context: 1 };
  const result = await search.execute('grep', args);
  await f.evidence.record(tool('grep', args, result.content[0].text, { details: result.details }));
  let saved = await f.evidence.read();
  const item = saved.items[0]; assert.ok(item.tool === 'grep');
  assert.deepEqual(item.blocks, [{ from: 11, lines: [
    'Log entry 11 records the cupboard inventory and cleaning supplies.',
    'Reopen the kiln room at quarter past two after the latch inspection.',
    'Log entry 13 records the cupboard inventory and cleaning supplies.',
  ] }]);
  const check = (quote: string) => checkPlans({ plans: [rawPlan({ stateNow: [{ id: 'k1', text: 'Fictional access rule', source: { type: 'file', path: 'R1/notes/plan.md', line: 12, quote } }] })] },
    { run: 'r', refs: f.input.refs, evidence: saved, pins: PINS }).evidence['r:k1'].result.ok;
  assert.equal(check('reopen the kiln room at quarter past two after the latch inspection'), true);
  const suffix = 'The unseen fictional cupboard must stay closed';
  await writeFile(f.file, 'x'.repeat(600) + suffix + '\n');
  const longArgs = { path: f.file, pattern: suffix };
  const long = await search.execute('grep', longArgs);
  await f.evidence.record(tool('grep', longArgs, long.content[0].text, { details: long.details }));
  saved = await f.evidence.read();
  const cut = saved.items.at(-1); assert.ok(cut?.tool === 'grep');
  assert.deepEqual(cut.cutLines, [1]);
  assert.equal(cut.blocks[0].lines[0], 'x'.repeat(500));
  assert.equal(check(suffix), false);
});

test('a 192 MiB fictional file is searched under a small heap without whole-file memory growth', { timeout: 30000 }, async t => {
  const f = await fixture(t), file = join(f.material, 'large.txt');
  const fd = await open(file, 'w');
  try {
    const chunk = Buffer.from(('f'.repeat(1023) + '\n').repeat(1024));
    for (let i = 0; i < 192; i++) await fd.write(chunk);
    await fd.write(Buffer.from('fictional lantern at end\n'));
  } finally { await fd.close(); }
  const runner = fileURLToPath(new URL('./fixtures/search-memory.ts', import.meta.url));
  const isolation = fileURLToPath(new URL('../scripts/check-isolation.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--max-old-space-size=64', '--import', isolation, runner, file, f.cwd], { timeout: 25000 });
  const measured = JSON.parse(stdout);
  assert.equal(measured.text, `${basename(file)}:196609: fictional lantern at end`);
  assert.ok(measured.peakMiB < 160, `peak RSS ${measured.peakMiB} MiB must stay below the 192 MiB input size`);
  t.diagnostic(`192 MiB input; isolated Node + worker peak RSS ${measured.peakMiB.toFixed(1)} MiB`);
});
