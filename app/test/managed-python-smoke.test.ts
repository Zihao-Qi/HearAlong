import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MATH_CASES, smokeErrorExcerpt } from '../scripts/managed-python-smoke.ts';
const exec = promisify(execFile), script = fileURLToPath(new URL('../scripts/managed-python-smoke.ts', import.meta.url));
const noUv = spawnSync('uv', ['--version']).status === 0 ? false : 'uv is not installed (brew install uv); this check runs real offline uv.';

test('managed math smoke explains its download step and requires an explicit data directory', async () => {
  const help = await exec(process.execPath, ['--experimental-strip-types', script, '--help']);
  assert.match(help.stdout, /may download managed Python\/packages/);
  assert.match(help.stdout, /--offline prohibits downloads/);
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', script]), error => (error as any).code === 2);
  assert.deepEqual(MATH_CASES.map(check => check.name), ['numpy', 'scipy.linalg.solve', 'scipy.sparse.linalg.svds', 'sympy']);
});

test('managed math smoke diagnostics retain the first 20 lines of failed tool output', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `fictional error line ${i + 1}`);
  assert.equal(smokeErrorExcerpt(lines.join('\r\n')), lines.slice(0, 20).join('\n'));
});

test('fresh managed math smoke runs preparation and every real tool call offline, reports failures and removes only its scratch', { skip: noUv }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-smoke-check-')), home = join(root, 'home'), data = join(root, 'data');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', script, data, '--offline'], {
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent') }, timeout: 60_000,
  }), error => {
    assert.equal((error as any).code, 1);
    const output = (error as any).stdout as string;
    assert.match(output, /Preparation is offline: downloads forbidden/);
    assert.match(output, /FAIL prepare \(managed interpreter\/packages unavailable offline\)/);
    for (const check of MATH_CASES) assert.ok(output.includes(`FAIL ${check.name}`), output);
    assert.doesNotMatch(output, /^PASS /m);
    return true;
  });
  assert.deepEqual(await readdir(join(data, 'scratch')), []);
  assert.ok((await readdir(data)).includes('python'), 'app-owned cache/owner artifacts are retained, not the entire caller data directory deleted');
});
