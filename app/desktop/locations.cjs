'use strict';
const { resolve, join, dirname } = require('node:path');
const { accessSync, constants, existsSync } = require('node:fs');

function findNode(env) {
  if (env.HEARALONG_NODE) return resolve(env.HEARALONG_NODE);
  for (const directory of (env.PATH || '').split(require('node:path').delimiter)) {
    const candidate = join(directory, 'node');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Next PATH entry. */ }
  }
  throw new Error('Node 22 was not found. Set HEARALONG_NODE to its path.');
}
function locations(env = process.env, packaged = false) {
  // Step 2 changes only this module to resolve bundled Node/server and installed data.
  if (packaged) throw new Error('This development shell is not packaged yet.');
  const root = resolve(__dirname, '..');
  const data = resolve(root, env.MEETING_DATA_DIR || 'data');
  const port = Number(env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (data === join(root, 'data') && existsSync(resolve(root, '../prototype/data')) && !existsSync(data)) {
    throw new Error('Your meetings are still in prototype/data — move that folder to app/data, then restart');
  }
  const testing = !packaged && env.HEARALONG_DESKTOP_TEST === '1';
  return {
    root, data, port, testing, node: findNode(env),
    entry: join(root, testing ? 'desktop/fixture-server.ts' : 'src/server.ts'),
    log: join(data, 'logs/launcher.log'), userData: join(dirname(data), data.endsWith('/Electron') ? 'HearAlong-Electron' : 'Electron'),
    origin: `http://127.0.0.1:${port}`,
    starting: join(__dirname, 'starting.html'), preload: join(__dirname, 'preload.cjs'),
    icon: join(root, 'public/icons/icon-512.png'),
  };
}
module.exports = { locations, findNode };
