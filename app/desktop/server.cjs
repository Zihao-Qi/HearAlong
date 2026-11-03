'use strict';
const { spawn, execFileSync } = require('node:child_process');
const { openSync, closeSync, appendFileSync, mkdirSync, fstatSync, readSync } = require('node:fs');
const { createServer } = require('node:net');
const { dirname } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { launcherLogLines } = require('./policy.cjs');

function logger(config) {
  mkdirSync(dirname(config.log), { recursive: true });
  return message => appendFileSync(config.log, launcherLogLines(message), { mode: 0o600 });
}
function logTail(config) {
  let fd;
  try {
    fd = openSync(config.log, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, 64 * 1024), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').slice(-12).join('\n');
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}
async function availablePort(config) {
  // Do not adopt/load an unrelated server, even if it looks like HearAlong.
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Port ${config.port} is used by another program, so HearAlong cannot start there.`)));
    probe.listen(config.port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}
function startServer(config, log, onExit, env = process.env) {
  const version = execFileSync(config.node, ['--version'], { encoding: 'utf8' }).trim();
  if (!version.startsWith('v22.')) throw new Error(`Node 22 is required (found ${version}). Set HEARALONG_NODE.`);
  const fd = openSync(config.log, 'a', 0o600);
  // A detached POSIX child leads its own process group, including server grandchildren.
  const child = spawn(config.node, ['--experimental-strip-types', config.entry], {
    cwd: config.root, detached: true, stdio: ['ignore', fd, fd],
    env: { ...env, PORT: String(config.port), MEETING_DATA_DIR: config.data,
      MEETING_OPEN_BROWSER: '0', MEETING_IDLE_EXIT_S: env.MEETING_IDLE_EXIT_S ?? '20' },
  });
  closeSync(fd);
  let exited = false;
  child.once('error', error => { exited = true; log(`Helper error: ${error.message}`); onExit(1, null); });
  child.once('exit', (code, signal) => {
    exited = true;
    const number = require('node:os').constants.signals[signal];
    log(signal ? `Server exited on signal ${number} (wait status ${number}).` : `Server exited with status ${code}.`);
    onExit(code, signal);
  });
  log(`Server started (pid ${child.pid}).`);
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const signalGroup = signal => { if (groupAlive()) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  return {
    child, alive: () => !exited,
    async stop() {
      // Never signal the reaped leader: its PID could already have been reused.
      if (!exited) child.kill('SIGTERM');
      const deadline = Date.now() + 30000;
      while (!exited && Date.now() < deadline) await delay(200);
      signalGroup('SIGTERM');
      const grace = Date.now() + 5000;
      while (groupAlive() && Date.now() < grace) await delay(200);
      signalGroup('SIGKILL');
    },
  };
}

// Main-process requests share one cookie, never claim page presence (no X-Page).
class ServerSession {
  constructor(origin) { this.origin = origin; this.cookie = ''; }
  async request(path, body) {
    const response = await fetch(this.origin + path, {
      signal: AbortSignal.timeout(2000), redirect: 'manual',
      method: body ? 'POST' : 'GET',
      headers: { Cookie: this.cookie, ...(body ? { Origin: this.origin, 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    if (path === '/' && response.status === 302 && response.headers.get('location') === '/setup') return ''; // First run still supplies the cookie.
    if (response.status === 403 && path !== '/') { await this.request('/'); throw new Error('Session renewed'); }
    if (!response.ok) throw new Error(`Server status ${response.status}`);
    return path === '/' ? response.text() : response.json();
  }
  async ready() {
    await this.request('/');
    const status = await this.request('/api/status');
    return Array.isArray(status.meetings) && typeof status.config === 'object';
  }
}
module.exports = { logger, logTail, availablePort, startServer, ServerSession };
