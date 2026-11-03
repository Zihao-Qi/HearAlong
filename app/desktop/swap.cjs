'use strict';
// Installer-only, after signature verification. Use the shipped Node/Koffi, never a user's toolchain.
const { join } = require('node:path');
const { lstatSync } = require('node:fs');
const { createRequire } = require('node:module');
const install = process.argv[2] === '--install';
const paths = process.argv.slice(install ? 3 : 2);
if (process.platform !== 'darwin' || process.arch !== 'arm64' || paths.length !== 2) process.exit(1);
if ((install ? paths.slice(0, 1) : paths).some(path => !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) process.exit(1);
const koffi = createRequire(join(__dirname, 'server/package.json'))('koffi');
const system = koffi.load('/usr/lib/libSystem.B.dylib');
const exchange = system.func('int renameatx_np(int, const char *, int, const char *, unsigned int)');
// AT_FDCWD = -2, RENAME_SWAP = 2, RENAME_EXCL = 4. Both paths must be on the same filesystem.
if (exchange(-2, paths[0], -2, paths[1], install ? 4 : 2) !== 0) {
  console.error(install ? 'Could not install HearAlong without replacing an existing item.' : 'Could not atomically replace HearAlong.');
  process.exitCode = 1;
}
