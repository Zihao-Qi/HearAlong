// Deterministic per-file I/O failures without depending on UID/root permission behavior.
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const originalOpen = fs.openSync, originalRead = fs.readSync;
const states = new Map();
fs.openSync = function (path, ...args) {
  if (path === workerData.fault.path && workerData.fault.kind === 'open') throw Object.assign(new Error('Fictional permission denial'), { code: 'EACCES' });
  const fd = originalOpen.call(this, path, ...args);
  if (path === workerData.fault.path) states.set(fd, { scanningText: false });
  return fd;
};
fs.readSync = function (fd, buffer, offset, length, position) {
  const state = states.get(fd);
  if (state?.scanningText && position >= 64 * 1024) throw Object.assign(new Error('Fictional late read failure'), { code: 'EIO' });
  const count = originalRead.call(this, fd, buffer, offset, length, position);
  if (state && !count) state.scanningText = true; // Entire binary preflight finished; fail during the text pass.
  return count;
};
require(workerData.runner);
