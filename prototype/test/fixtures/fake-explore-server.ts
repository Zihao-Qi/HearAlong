// Test-only stand-in for a server running one plan pass: a fake Pi that starts a recorded "script" and waits. The test kills
// this process with SIGKILL (a crash) and checks that the next server start ends both.
// Usage: fake-explore-server.ts <data directory> <out.json>
import { fileURLToPath } from 'node:url';
import { Cooldowns } from '../../src/quota.ts';
import { Explorations } from '../../src/explorations.ts';

const [directory, outPath] = process.argv.slice(2);
const fakePi = fileURLToPath(new URL('./fake-task-pi.ts', import.meta.url));
const explorations = new Explorations({ directory, clock: Date.now, cooldowns: new Cooldowns() });
await explorations.load();
await explorations.submit('meeting-1', {
  kind: 'plan',
  work: ctx => ctx.pi('plan', { model: 'fake', command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', fakePi, 'python', outPath] }),
});
setInterval(() => {}, 60_000);
