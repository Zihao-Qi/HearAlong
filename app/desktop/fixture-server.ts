// Local Electron check only: same real server/routes, empty scripted recognizer, fictional data.
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.env.HEARALONG_DESKTOP_TEST !== '1') throw new Error('Check fixture requires HEARALONG_DESKTOP_TEST=1');
const directory = process.env.MEETING_DATA_DIR!;
await mkdir(directory, { recursive: true });
const setup = await dashboardSetup(directory, true);
if (process.env.HEARALONG_DESKTOP_TEST_SETUP === '1') {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ setupSeen: false }));
}
const app = await startServer({ directory, port: Number(process.env.PORT),
  idleMs: Number(process.env.MEETING_IDLE_EXIT_S ?? 20) * 1000,
  onIdle: () => stop(), setup,
  recognizer: { async transcribe() { return { text: '', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1,
    audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' as const }; }, close() {} },
  drafts: null, quick: null, heavy: null, board: null,
});
// Both remain in the server's group, including an intentionally stubborn grandchild.
const child = spawn(process.execPath, ['-e', `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
`, join(directory, 'descendants.json')], { stdio: 'ignore' });
child.on('error', error => { throw error; });
await writeFile(join(directory, 'ready.json'), JSON.stringify({ pid: process.pid, url: app.url }));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
