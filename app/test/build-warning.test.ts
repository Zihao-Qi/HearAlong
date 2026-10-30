import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute only the warning tail, never the builder, compiler, registration, or a helper.
for (const [name, pids, exit] of [['none', '', 1], ['one', '48211', 0], ['several', '48211\n48212', 0], ['pgrep fails', '', 2]] as const) {
  test(`build warning: ${name} (no app build)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hearalong-build-warning-'));
    try {
      const source = await readFile(new URL('../scripts/build-app.sh', import.meta.url), 'utf8');
      const marker = '# Warning only: never stop or reactivate a running helper during a build.\n';
      assert.equal(source.split(marker).length, 2);
      await writeFile(join(dir, 'pgrep'), `#!/bin/sh\n[ "$1" = '-f' ] && [ "$2" = '/Contents/MacOS/HearAlongHelper' ] || exit 99\nprintf '%s' '${pids}'\nexit ${exit}\n`, { mode: 0o755 });
      const result = spawnSync('/bin/sh', ['-eu', '-c', source.split(marker)[1]], { env: { ...process.env, PATH: dir }, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 0, 'warning never changes a successful build status');
      assert.equal(result.stderr, '');
      const expected = pids ? pids.split('\n').map(pid => `An older HearAlong is still running (pid ${pid}). Opening the app now would bring that one back.\nQuit it from the menu bar icon, or run: kill ${pid}\n`).join('') : '';
      assert.equal(result.stdout, expected);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
