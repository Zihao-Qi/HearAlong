import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, mkdir, cp, symlink, stat, readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keychain } from '../src/setup/api-keys.ts';

test('installer exchange swaps bundle inodes atomically and can roll back without rewriting either bundle', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hearalong-exchange-'));
  try {
    await mkdir(join(folder, 'server'));
    await writeFile(join(folder, 'server/package.json'), '{}');
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(folder, 'server/node_modules'));
    const script = join(folder, 'swap.cjs');
    await cp(new URL('../desktop/swap.cjs', import.meta.url), script);
    const first = join(folder, 'first.app'), second = join(folder, 'second.app');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'marker'), 'fictional old app'); await writeFile(join(second, 'marker'), 'fictional new app');
    const a = (await stat(first)).ino, b = (await stat(second)).ino;
    execFileSync(process.execPath, [script, first, second]);
    assert.equal((await stat(first)).ino, b); assert.equal((await stat(second)).ino, a);
    assert.equal(await readFile(join(second, 'marker'), 'utf8'), 'fictional old app');
    execFileSync(process.execPath, [script, first, second]);
    assert.equal((await stat(first)).ino, a); assert.equal((await stat(second)).ino, b);
    const bad = spawnSync(process.execPath, [script, first, join(folder, 'missing')]);
    assert.notEqual(bad.status, 0); assert.equal((await stat(first)).ino, a); assert.equal((await stat(second)).ino, b);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('ad-hoc packaged runtime never launches security, even for keys saved by an older install', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hearalong-keychain-'));
  const previous = process.env.HEARALONG_PACKAGED;
  try {
    const script = join(folder, 'security'), marker = join(folder, 'launched');
    await writeFile(script, `#!/bin/sh\necho launched > '${marker}'\nexit 44\n`, { mode: 0o755 });
    process.env.HEARALONG_PACKAGED = '1';
    const keys = new Keychain(script);
    await assert.rejects(keys.read('google'), /Keychain/);
    await assert.rejects(keys.write('google', 'fictional-key'), /Keychain/);
    await assert.rejects(keys.remove('google'), /Keychain/);
    await assert.rejects(access(marker));
  } finally {
    if (previous === undefined) delete process.env.HEARALONG_PACKAGED; else process.env.HEARALONG_PACKAGED = previous;
    await rm(folder, { recursive: true, force: true });
  }
});
