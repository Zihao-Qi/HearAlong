import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, cp, symlink, stat, readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const { assertUnquarantined } = createRequire(import.meta.url)('../desktop/quarantine.cjs');

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
    const fresh = join(folder, 'fresh.app');
    execFileSync(process.execPath, [script, '--install', first, fresh]);
    assert.equal((await stat(fresh)).ino, a); await assert.rejects(stat(first), /ENOENT/);
    const empty = join(folder, 'empty.app'), file = join(folder, 'file.app'), link = join(folder, 'link.app');
    await mkdir(empty); await writeFile(file, 'fictional foreign file'); await symlink(second, link);
    for (const target of [second, empty, file, link]) {
      const refused = spawnSync(process.execPath, [script, '--install', fresh, target]);
      assert.notEqual(refused.status, 0); assert.equal((await stat(fresh)).ino, a);
    }
    assert.equal((await stat(second)).ino, b); assert.equal(await readFile(file, 'utf8'), 'fictional foreign file');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('package quarantine gate rejects a quarantine attribute on any nested file', { skip: process.platform !== 'darwin' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'hearalong-quarantine-'));
  try {
    const bundle = join(folder, 'bundle'), nested = join(bundle, 'Resources/nested');
    await mkdir(nested, { recursive: true });
    const file = join(nested, 'fictional.txt'), listing = join(folder, 'attributes');
    await writeFile(file, 'fictional build input');
    assertUnquarantined(bundle, listing);
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Fixture;', file]);
    assert.throws(() => assertUnquarantined(bundle, listing), /com.apple.quarantine/);
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', file]);
    assertUnquarantined(bundle, listing);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
