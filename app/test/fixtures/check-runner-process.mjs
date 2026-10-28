// Fictional process fixtures: no application, model or network work.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [mode, pidFile, profile, browserPidFile] = process.argv.slice(2);
if (mode === 'suite') {
  const start = (path, detached = false, userData) => new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'helper', path, ...(userData ? [`--user-data-dir=${userData}`] : [])],
      { detached, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', resolve);
  });
  await start(pidFile);
  if (profile) await start(browserPidFile, true, profile);
  console.log('Fictional suite and helpers ready');
} else {
  process.on('SIGTERM', () => {});
  writeFileSync(pidFile, String(process.pid));
  process.send?.('ready');
  process.disconnect?.();
}
setInterval(() => {}, 60_000);
