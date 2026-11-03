'use strict';
const { spawn, execFile } = require('node:child_process');
const { accessSync, constants, mkdirSync, statSync, existsSync, openSync, closeSync } = require('node:fs');
const { join } = require('node:path');
const { promisify } = require('node:util');

async function captureBinary(config, log, env = process.env) {
  if (config.packaged || config.testing) return config.captureBinary;
  const compiler = (env.PATH || '').split(require('node:path').delimiter).map(dir => join(dir, 'swiftc')).find(path => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  if (!compiler) { log('Meeting-app audio unavailable: swiftc not found.'); return null; }
  const sources = ['AppAudio.swift', 'AudioPipeline.swift', 'AppCaptureClient.swift', 'capture-main.swift'].map(file => join(config.root, 'launcher', file));
  const directory = join(__dirname, '.build'), binary = join(directory, 'hearalong-capture');
  try {
    mkdirSync(directory, { recursive: true });
    if (!existsSync(binary) || sources.some(file => statSync(file).mtimeMs > statSync(binary).mtimeMs)) {
      await promisify(execFile)(compiler, ['-O', '-module-cache-path', join(directory, 'swift'), '-o', binary, ...sources], { timeout: 120000 });
    }
    return binary;
  } catch (error) { log(`Meeting-app audio unavailable: ${error.message}`); return null; }
}

// Own only this child, not a process group. A failed capture must never stop the microphone/server.
function startCapture(binary, config, serverGroup, log) {
  let child, timer, stopping = false, attempt = 0;
  const exited = new WeakSet();
  function start() {
    if (stopping) return;
    let fd;
    try {
      fd = openSync(config.log, 'a', 0o600);
      child = spawn(binary, [config.origin, config.origin, String(serverGroup)], { stdio: ['ignore', fd, fd] });
    } finally { if (fd !== undefined) closeSync(fd); }
    const owned = child;
    const exit = (code, signal, error) => {
      if (exited.has(owned)) return;
      exited.add(owned);
      log(`Audio capture exited (${error?.message || signal || code}).`);
      if (!stopping) {
        const seconds = Math.min(30, 2 ** Math.min(attempt++, 5));
        log(`Restarting audio capture in ${seconds} s.`);
        timer = setTimeout(start, seconds * 1000);
      }
    };
    owned.once('error', error => exit(null, null, error));
    owned.once('exit', (code, signal) => exit(code, signal));
    log(`Audio capture started (pid ${owned.pid}).`);
  }
  start();
  return {
    pid: () => child?.pid,
    async stop() {
      stopping = true; clearTimeout(timer);
      const owned = child;
      if (!owned || exited.has(owned)) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { if (!exited.has(owned)) owned.kill('SIGKILL'); resolve(); }, 10000);
        owned.once('exit', () => { clearTimeout(timer); resolve(); });
        owned.kill('SIGTERM');
      });
    },
  };
}
module.exports = { captureBinary, startCapture };
