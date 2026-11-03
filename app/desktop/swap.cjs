'use strict';
// Installer-only, after signature verification. Use the shipped Node/Koffi, never a user's toolchain.
const { join } = require('node:path');
const { lstatSync } = require('node:fs');
const { createRequire } = require('node:module');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== 4) process.exit(1);
const paths = process.argv.slice(2);
if (paths.some(path => !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) process.exit(1);
const koffi = createRequire(join(__dirname, 'server/package.json'))('koffi');
const system = koffi.load('/usr/lib/libSystem.B.dylib');
const exchange = system.func('int renameatx_np(int, const char *, int, const char *, unsigned int)');
// AT_FDCWD = -2, RENAME_SWAP = 2. Both directories must be on the same filesystem.
if (exchange(-2, paths[0], -2, paths[1], 2) !== 0) {
  console.error('Could not atomically replace HearAlong.');
  process.exitCode = 1;
}
