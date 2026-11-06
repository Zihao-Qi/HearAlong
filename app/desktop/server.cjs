'use strict';
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { openSync, closeSync, appendFileSync, mkdirSync, fstatSync, readSync } = require('node:fs');
const { createServer } = require('node:net');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { launcherLogLines } = require('./policy.cjs');
const exec = promisify(execFile);
async function output(command, args) {
  return (await exec(command, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024 })).stdout;
}
async function identifyListener(port) {
  if (process.platform !== 'darwin') return null;
  try {
    // No requests to the listener, and no authority from its process title/argv.
    const listeners = await output('/usr/sbin/lsof', ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpu']);
    const pids = [...new Set([...listeners.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1])))];
    if (pids.length !== 1) return null;
    const pid = pids[0];
    const info = (await output('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart='])).trim();
    const match = info.match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== process.getuid()) return null;
    const files = await output('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn']);
    // lsof's first txt entry is the executable (later entries can be shared libraries).
    const executable = files.match(/^n(.+)$/m)?.[1];
    const bundle = executable?.match(/^(.*?\.app)\/Contents\//)?.[1];
    if (!bundle) return null;
    let known = /\/(?:HearAlong|HearAlong Helper)\.app$/.test(bundle);
    if (!known) {
      const id = (await output('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')])).trim();
      known = /^(?:io\.github\.zihao-qi\.hearalong|local\.meeting-research-assistant)/.test(id);
    }
    return known ? { pid, uid: Number(match[1]), started: match[2], executable } : null;
  } catch { return null; } // Missing permissions, tools, or ambiguous identity: never offer to kill.
}
function sameOwner(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.executable === b.executable);
}
// Remember requests for this launch, including across retries and refreshed conflict snapshots.
// A second SIGTERM would bypass the other server's graceful recording drain.
const quitRequests = new Set();
// A process that execs another binary is still the same lifetime: do not signal it twice either.
const ownerKey = owner => JSON.stringify([owner.pid, owner.uid, owner.started]);
const quitRequested = owner => Boolean(owner && quitRequests.has(ownerKey(owner)));
const conflict = message => Object.assign(new Error(message), { portConflict: true, owner: null });
async function quitListener(config, owner, { identify = identifyListener, signal = (pid) => process.kill(pid, 'SIGTERM'), free,
  timeout = 60000, onWaiting = () => {}, now = Date.now, sleep = delay } = {}) {
  if (await free()) return;
  if (!sameOwner(owner, await identify(config.port))) {
    if (await free()) return;
    throw conflict('The other copy has changed. Try again before quitting it.');
  }
  if (!quitRequested(owner)) {
    quitRequests.add(ownerKey(owner));
    try { signal(owner.pid); } // Only the re-identified listener, never a process group or name match.
    catch (error) {
      if (error.code === 'ESRCH') return; // Normal startup rechecks the port, including any replacement listener.
      throw conflict('The other copy could not be asked to quit. Quit it, then try again.');
    }
  }
  onWaiting();
  const deadline = now() + timeout;
  do {
    if (await free()) return;
    if (!sameOwner(owner, await identify(config.port))) {
      if (await free()) return;
      throw conflict('The other copy has changed. Try again before quitting it.');
    }
    await sleep(Math.min(1000, Math.max(0, deadline - now())));
  } while (now() < deadline);
  if (await free()) return;
  throw conflict('The other copy is still running after 60 seconds. Let it finish or quit it yourself, then try again.');
}

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
async function portFree(config) {
  const probe = createServer();
  const free = await new Promise((resolve, reject) => {
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen(config.port, '127.0.0.1', () => resolve(true));
  });
  if (free) await new Promise(resolve => probe.close(resolve));
  return free;
}
async function availablePort(config) {
  // Never adopt an existing server, even if it is another HearAlong.
  if (await portFree(config)) return;
  const owner = await identifyListener(config.port);
  const requested = quitRequested(owner);
  throw Object.assign(new Error(requested
    ? 'The other copy is still finishing its work… Try again when it has finished.'
    : owner ? 'Another copy of HearAlong is already running, so this one cannot start. Quit the other copy, then open HearAlong again.'
    : `Another program is using port ${config.port}, which HearAlong needs. Quit that program, then open HearAlong again.`), { portConflict: true, owner: requested ? null : owner });
}
async function quitOtherCopy(config, owner, onWaiting) {
  await quitListener(config, owner, { free: () => portFree(config), onWaiting });
}
function serverEnvironment(config, env = process.env) {
  const result = { ...env, PORT: String(config.port), MEETING_DATA_DIR: config.data,
    MEETING_OPEN_BROWSER: '0', MEETING_IDLE_EXIT_S: env.MEETING_IDLE_EXIT_S ?? '20' };
  if (config.packaged) {
    // Dock launches have no shell PATH. System tools win; optional FFmpeg remains discoverable.
    result.PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(config.node), '/opt/homebrew/bin', '/usr/local/bin'].join(':');
    result.MEETING_PI = require('node:path').join(config.root, 'node_modules/.bin/pi');
    result.HEARALONG_PDF_TEXT = config.pdfText;
    result.HEARALONG_PACKAGED = '1';
    // Do not let development fixtures or Node injection cross the installed runtime boundary.
    for (const name of Object.keys(result)) {
      if (/^(?:HEARALONG_DESKTOP_TEST|MEETING_TEST_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_)/.test(name)) delete result[name];
    }
  }
  return result;
}
function startServer(config, log, onExit, env = process.env) {
  const version = execFileSync(config.node, ['--version'], { encoding: 'utf8' }).trim();
  if (!version.startsWith('v22.')) throw new Error(`Node 22 is required (found ${version}). Set HEARALONG_NODE.`);
  const fd = openSync(config.log, 'a', 0o600);
  // A detached POSIX child leads its own process group, including server grandchildren.
  const child = spawn(config.node, ['--experimental-strip-types', config.entry], {
    cwd: config.root, detached: true, stdio: ['ignore', fd, fd],
    env: serverEnvironment(config, env),
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
module.exports = { logger, logTail, availablePort, quitOtherCopy, portFree, identifyListener, sameOwner, quitListener, serverEnvironment, startServer, ServerSession };
