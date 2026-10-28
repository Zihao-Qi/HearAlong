// Checks the helper's native mini window (docs/design/M7-native-mini.md §7): it is hidden until a recording runs and the user is
// in another app; by default it stays hidden then, and with the setting on it shows by itself without taking the focus, on every desktop and over full-screen apps (by its settings),
// with the lines in its page; closed by hand it stays closed and the app's Mini view button opens it again; Stop in it asks once,
// stops the app's recording and brings the app forward; it hides when the recording ends. The page is a headless Chrome; the
// window is real and appears briefly at the top right of the screen. The helper writes the window's state to a test folder and
// runs scripts in its page from there (MEETING_HELPER_TEST_DIR).
// With --fullscreen, a stand-in app also goes into native full screen for a few seconds (it takes over the screen meanwhile), to see
// the window over it for real.
// Usage: npm run build:app && node --experimental-strip-types scripts/native-mini-check.ts <speech.wav> [outDir=artifacts/mini-view] [--fullscreen]
import { testBrowser } from './test-browser.ts';
import { chromium } from 'playwright-core';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fullScreen = process.argv.includes('--fullscreen');
const [speech, out = 'artifacts/mini-view'] = process.argv.slice(2).filter(a => a !== '--fullscreen');
if (!speech) throw new Error('Usage: native-mini-check.ts <speech.wav> [outDir]');
const outDir = resolve(out);
await mkdir(outDir, { recursive: true });
const binary = resolve('dist/HearAlong Helper.app/Contents/MacOS/HearAlongHelper');
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(what: () => Promise<boolean> | boolean, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await what()) return true; await sleep(250); }
  return false;
}
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const answers = async (port: number) => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } };
const exited = (child: ChildProcess) => new Promise<number | null>(r => { if (child.exitCode !== null) r(child.exitCode); else child.once('exit', code => r(code)); });

const data = await mkdtemp(join(tmpdir(), 'meeting-native-mini-'));
const testDir = await mkdtemp(join(tmpdir(), 'meeting-native-mini-test-'));
const port = 4394;
type Panel = { visible: boolean; onActiveSpace: boolean; level: number; floatingLevel: number; allSpaces: boolean; allApplications: boolean; fullScreenAuxiliary: boolean; nonactivating: boolean; hidesOnDeactivate: boolean; width: number; height: number; helperActive: boolean };
const panel = async (): Promise<Panel | null> => { try { return JSON.parse(await readFile(join(testDir, 'panel.json'), 'utf8')); } catch { return null; } };
/** Runs a script in the native window's page (as an async function body) and returns its result. */
async function inPage(source: string): Promise<unknown> {
  await rm(join(testDir, 'eval.out'), { force: true });
  await writeFile(join(testDir, 'eval.js'), source);
  if (!(await waitFor(() => access(join(testDir, 'eval.out')).then(() => true, () => false), 5000))) throw new Error('The window\'s page did not answer.');
  const result = JSON.parse(await readFile(join(testDir, 'eval.out'), 'utf8'));
  if (result.error) throw new Error(result.error);
  return result.ok;
}
if (sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])) throw new Error(`Port ${port} is in use; this check needs it free.`);
// HearAlong itself is never in front here (a stand-in bundle id): the window opens as soon as the recording starts,
// as when the user switches to the call. Nothing takes the focus.
const helper = spawn(binary, [], { stdio: 'ignore', env: { ...process.env, MEETING_DATA_DIR: data, MEETING_LAUNCHER_PORT: String(port), MEETING_LAUNCHER_NO_WINDOW: '1',
  MEETING_CLOUD: '0', MEETING_HELPER_TEST_DIR: testDir, MEETING_HELPER_APP_BUNDLE_ID: 'local.meeting-assistant.check-stand-in' } });
const browser = await chromium.launch({
  executablePath: testBrowser(), headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(speech)}`],
});
let pgid = 0;
try {
  if (!(await waitFor(() => answers(port), 60_000))) throw new Error('The helper did not start the server.');
  // Only the server this helper started (its child) is ended at the end, with its group.
  const server = sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')[0];
  if (Number(sh('ps', ['-o', 'ppid=', '-p', server])) !== helper.pid) throw new Error('The server on the port is not the helper\'s.');
  pgid = Number(sh('ps', ['-o', 'pgid=', '-p', server]));
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#meeting-button').click();
  await page.locator('#new-meeting').click();
  await page.locator('#meeting-name').waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  await sleep(1500);
  check('before recording: no window', !(await panel())?.visible);

  // By default the window opens only from the app's Mini view button: recording with the user in another app does not show it.
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor({ timeout: 15_000 });
  await sleep(3000);
  check('setting off (the default): recording, the user in another app: no window, the app offers Mini view', !(await panel())?.visible && await page.locator('#mini-view').isVisible());
  await page.locator('#stop').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  // "Open the mini window by itself when I leave the app", turned on as Settings does.
  const turnedOn = await page.evaluate(async () => (await (await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ miniOpensItself: true }) })).json()).miniOpensItself);
  check('the setting turns on', turnedOn === true);

  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor({ timeout: 15_000 });
  const shownAt = Date.now();
  check('setting on: recording, the user in another app: the window shows by itself', await waitFor(async () => Boolean((await panel())?.visible), 5000), `${((Date.now() - shownAt) / 1000).toFixed(1)} s`);
  const p = (await panel())!;
  check('it floats above normal windows', p.level >= p.floatingLevel, `level ${p.level}`);
  check('on every desktop and over full-screen apps (all Spaces, all apps, full-screen auxiliary)', p.allSpaces && p.allApplications && p.fullScreenAuxiliary);
  check('it is set not to activate the helper when clicked, and stays while the helper is inactive (a real click: the user\'s try-out)', p.nonactivating && !p.hidesOnDeactivate);
  check('showing it took the focus from no one', !p.helperActive);
  check('it is 360 × 268 at first (or as the user left it), within 260–640 px wide', p.width >= 260 && p.width <= 640, `${p.width} × ${p.height}`);
  check('the app\'s Mini view button is hidden while the window is open', await page.locator('#mini-view').waitFor({ state: 'hidden', timeout: 2500 }).then(() => true, () => false));
  check('its page is the mini view: recording, its clock running, Stop', await waitFor(async () => /Recording\s*0\d:\d\d/.test(String(await inPage("return document.querySelector('.status').innerText")).replace(/\n/g, ' ')), 5000));
  check('its page shows the lines', await waitFor(async () => Number(await inPage("return document.querySelectorAll('#m-scroll .ln').length")) >= 1, 40_000));
  await writeFile(join(testDir, 'snapshot.request'), 'native-mini.png');
  await waitFor(() => access(join(testDir, 'native-mini.png')).then(() => true, () => false), 5000);
  await copyFile(join(testDir, 'native-mini.png'), join(outDir, 'native-mini.png')).catch(() => {});

  if (fullScreen) {
    // A call app in native full screen (its own Space): the window must be on screen over it, in front.
    const standIn = join(testDir, 'fullscreen-standin');
    execFileSync('swiftc', ['-o', standIn, 'scripts/fullscreen-standin.swift', '-framework', 'Cocoa']);
    const report = JSON.parse(execFileSync(standIn, [String(helper.pid)], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').at(-1)!);
    check('over an app in native full screen: the window is on screen, in front of it', report.fullScreen && report.helperOnScreen && report.helperInFront, JSON.stringify(report));
    check('after the full-screen app leaves, the window is still shown', Boolean((await panel())?.visible));
  }

  // Closed by hand: stays closed (no reopening by itself); the app's button returns and opens it again.
  await writeFile(join(testDir, 'close.request'), '');
  check('closed by hand: it hides', await waitFor(async () => !(await panel())?.visible, 3000));
  check('closed by hand: the app offers Mini view again', await page.locator('#mini-view').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false));
  await sleep(2000);
  check('closed by hand: it does not come back by itself', !(await panel())?.visible);
  await page.locator('#mini-view').click();
  check('the app\'s Mini view button opens it again', await waitFor(async () => Boolean((await panel())?.visible), 3000));

  // Stop in it: asks once; then the app's recording stops (through the server), the app is asked forward, and the window hides.
  await inPage("document.querySelector('.stop').click(); return true");
  // Clicks below are the page's own (a script); a real mouse click in the window is the user's try-out.
  check('Stop asks once', String(await inPage("return [...document.querySelectorAll('.status button')].map(b => b.textContent).join('|')")) === 'Stop recording|Keep recording');
  await inPage("document.querySelector('.keep').click(); return true");
  check('Keep recording returns', String(await inPage("return document.querySelector('.status button').textContent")) === 'Stop');
  await inPage("document.querySelector('.stop').click(); return true");
  const stopAt = Date.now();
  await inPage("document.querySelector('.stop-now').click(); return true");
  check('Stop recording: it says Stopping… at once', /Stopping/.test(String(await inPage("return document.querySelector('.status').innerText"))));
  const stopped = await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 10_000 }).then(() => true, () => false);
  check('Stop recording in the window stops the app\'s recording', stopped, `${((Date.now() - stopAt) / 1000).toFixed(1)} s`);
  check('it asks for the app to come forward', /activate/.test(await readFile(join(testDir, 'messages.log'), 'utf8').catch(() => '')));
  check('recording stopped: the window hides', await waitFor(async () => !(await panel())?.visible, 3000));
  const nativeErrors = await inPage('return window.miniErrors') as string[];
  check('no page errors (the app\'s page and the window\'s page)', errors.length === 0 && nativeErrors.length === 0, [...errors, ...nativeErrors].join(' | '));
  await page.close();
} catch (error) {
  check('the check ran to its end', false, (error as Error).message.split('\n')[0]);
} finally {
  helper.kill('SIGTERM');
  await Promise.race([exited(helper), sleep(40_000)]);
  if (pgid > 1) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } }
  if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
  await browser.close();
  await rm(data, { recursive: true, force: true });
  await rm(testDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed; snapshot in ${outDir}/native-mini.png`);
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
