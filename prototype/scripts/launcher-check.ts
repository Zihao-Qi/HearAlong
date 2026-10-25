// Checks the built helper (M7): it starts the server; closing the last window stops the server by itself (after a recording was
// stopped and sealed) and the helper with it; quitting the helper while a page records stops the recording first; nothing it
// started is left running; a server started outside it is left alone; another program on the port is reported. Runs on temporary
// data folders and its own ports, without opening a Chrome window (MEETING_LAUNCHER_NO_WINDOW); the page is a headless Chrome.
// Usage: npm run build:app && node --experimental-strip-types scripts/launcher-check.ts <speech.wav>
import { testBrowser } from './test-browser.ts';
import { chromium } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MeetingStore } from '../src/store.ts';

const [speech] = process.argv.slice(2);
if (!speech) throw new Error('Usage: launcher-check.ts <speech.wav>');
const binary = resolve('dist/HearAlong Helper.app/Contents/MacOS/HearAlongHelper');
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const answers = async (port: number) => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } };
async function waitFor(what: () => Promise<boolean> | boolean, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await what()) return true; await sleep(250); }
  return false;
}
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const listener = (port: number) => Number(sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')[0] || 0);
const group = (pgid: number) => sh('pgrep', ['-g', String(pgid)]).split('\n').filter(Boolean).map(Number);
const exited = (child: ChildProcess) => new Promise<number | null>(r => { if (child.exitCode !== null) r(child.exitCode); else child.once('exit', code => r(code)); });

const directories: string[] = [];
// Every process a check starts, ended in the finally block even when a check throws (with its group when it has one).
const started: { child: ChildProcess; group?: number }[] = [];
const run = (command: string, args: string[], env: NodeJS.ProcessEnv) => { const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' }); started.push({ child }); return child; };
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'meeting-launcher-')); directories.push(d); return d; };
const browser = await chromium.launch({
  executablePath: testBrowser(), headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(speech)}`],
});
try {
  // 0. The normal case: the helper starts the server; the window records and stops; when the window closes, the server stops by
  // itself a few seconds later, the helper ends, and the recording is sealed.
  const data0 = await temp();
  const port0 = 4390;
  const helper0 = run(binary, [], { MEETING_DATA_DIR: data0, MEETING_LAUNCHER_PORT: String(port0), MEETING_LAUNCHER_NO_WINDOW: '1', MEETING_CLOUD: '0', MEETING_IDLE_EXIT_S: '3' });
  check('the helper starts the server', await waitFor(() => answers(port0), 60_000));
  const pgid0 = Number(sh('ps', ['-o', 'pgid=', '-p', String(listener(port0))]));
  started.push({ child: helper0, group: pgid0 });
  const win = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await win.goto(`http://127.0.0.1:${port0}/`);
  await win.locator('#meeting-button').click();
  await win.locator('#new-meeting').click();
  await win.locator('#meeting-name').waitFor();
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  await win.locator('#start').click();
  await win.locator('#start-mic').click();
  await win.locator('#live-chip').getByText('Recording').waitFor({ timeout: 15_000 });
  await sleep(6000);
  await win.locator('#stop').click();
  await win.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });
  await sleep(4000);
  check('with its window open, the server keeps running', await answers(port0));
  const closedAt = Date.now();
  await win.close({ runBeforeUnload: false }); // the window's goodbye
  const code0 = await Promise.race([exited(helper0), sleep(120_000).then(() => 'timeout' as const)]);
  check('window closed: once the recording is transcribed, the server stops by itself and the helper ends', code0 === 0 && !(await answers(port0)), `${code0} after ${Math.round((Date.now() - closedAt) / 1000)} s`);
  check('window closed: nothing the helper started is left', group(pgid0).length === 0, sh('ps', ['-o', 'pid,command', '-g', String(pgid0)]));
  const store0 = new MeetingStore(data0);
  const m0 = store0.meetings()[0];
  const sealed0 = store0.heldFrames(m0.id).length === 0 && store0.chunks(m0.id).length >= 1 && store0.chunks(m0.id).every(c => c.status === 'completed');
  const detail0 = `${store0.heldFrames(m0.id).length} held; windows: ${store0.chunks(m0.id).map(c => `${c.source.slice(0, 3)} ${c.status}`).join(', ')}`;
  store0.close();
  check('window closed: the recording was sealed and transcribed', sealed0, detail0);

  // 1. Quitting the helper (logging out) while a page records: the recording stops first, the audio is sealed, everything ends.
  const data = await temp();
  const port = 4391;
  const app = run(binary, [], { MEETING_DATA_DIR: data, MEETING_LAUNCHER_PORT: String(port), MEETING_LAUNCHER_NO_WINDOW: '1', MEETING_CLOUD: '0' });
  check('the helper starts the server again', await waitFor(() => answers(port), 60_000));
  const server = listener(port);
  const pgid = Number(sh('ps', ['-o', 'pgid=', '-p', String(server)]));
  check('the server runs in its own process group', pgid === server && pgid !== process.pid, `server ${server}, group ${pgid}`);
  started.push({ child: app, group: pgid });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#meeting-button').click();
  await page.locator('#new-meeting').click();
  await page.locator('#meeting-name').waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor({ timeout: 15_000 });
  await sleep(12_000); // frames saved, the recognizer and the live preview running
  const before = group(pgid);
  check('while recording, the server has started children in its group', before.length >= 2, `${before.length} processes`);
  const quitAt = Date.now();
  app.kill('SIGTERM'); // the same path as the Dock's Quit, without the question
  await page.locator('#quit-banner').waitFor({ state: 'visible', timeout: 10_000 });
  check('the page says the app is quitting and stops its recording', await waitFor(async () => !(await page.locator('#live-chip').isVisible()), 15_000));
  const code = await Promise.race([exited(app), sleep(45_000).then(() => 'timeout' as const)]);
  check('the app quits', code !== 'timeout', `${code} after ${Math.round((Date.now() - quitAt) / 1000)} s`);
  check('the page says the app has quit', await waitFor(async () => /has quit/.test(await page.locator('#quit-text').innerText()), 10_000));
  check('nothing the app started is left', group(pgid).length === 0 && !(await answers(port)), sh('ps', ['-o', 'pid,command', '-g', String(pgid)]));
  await page.close();
  const store = new MeetingStore(data);
  const meeting = store.meetings()[0];
  const held = store.heldFrames(meeting.id).length;
  const chunks = store.chunks(meeting.id).length;
  store.close();
  check('the recording was sealed into windows, nothing left held', held === 0 && chunks >= 1, `${chunks} windows, ${held} frames held`);
  const log = await readFile(join(data, 'logs', 'launcher.log'), 'utf8').catch(() => '');
  check('the server wrote its log', /HearAlong prototype/.test(log));

  // 2. A server started outside the app (npm start) is used, and left running when the app quits.
  const data2 = await temp();
  const port2 = 4392;
  const outside = run(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { MEETING_DATA_DIR: data2, PORT: String(port2), MEETING_CLOUD: '0' });
  await waitFor(() => answers(port2), 60_000);
  const app2 = run(binary, [], { MEETING_DATA_DIR: data2, MEETING_LAUNCHER_PORT: String(port2), MEETING_LAUNCHER_NO_WINDOW: '1' });
  const code2 = await Promise.race([exited(app2), sleep(15_000).then(() => 'timeout' as const)]);
  check('a server already running: the helper starts no second one, ends at once, and leaves it running', code2 === 0 && listener(port2) === outside.pid && await answers(port2) && outside.exitCode === null, `exit ${code2}`);
  // 3. Two quit signals in a row: the second skips the waiting, never the cleanup (the data lock is released).
  outside.kill('SIGTERM');
  await sleep(300);
  outside.kill('SIGTERM');
  const code3 = await Promise.race([exited(outside), sleep(30_000).then(() => 'timeout' as const)]);
  const lockGone = await access(join(data2, 'server.lock')).then(() => false, () => true);
  check('two quit signals: the server still finishes its cleanup and exits', code3 === 0 && lockGone, `exit ${code3}, lock ${lockGone ? 'released' : 'still there'}`);

  // 4. Another program on the port: the app does not take it for HearAlong; it says so and starts nothing.
  const port4 = 4393;
  const foreign = createServer((_req, res) => { res.writeHead(200).end('another program'); });
  await new Promise<void>(r => foreign.listen(port4, '127.0.0.1', r));
  const data4 = await temp();
  const app4 = run(binary, [], { MEETING_DATA_DIR: data4, MEETING_LAUNCHER_PORT: String(port4), MEETING_LAUNCHER_NO_WINDOW: '1' });
  const code4 = await Promise.race([exited(app4), sleep(15_000).then(() => 'timeout' as const)]);
  check('another program on the port: the app reports it and quits, starting no server', code4 === 1 && listener(port4) === process.pid, `exit ${code4}`);
  await new Promise(r => foreign.close(r));
} finally {
  for (const { child, group } of started) {
    if (group && group > 1) { try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ } }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited(child), sleep(5000)]); }
  }
  await browser.close();
  for (const d of directories) await rm(d, { recursive: true, force: true });
}
console.log(results.join('\n'));
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
