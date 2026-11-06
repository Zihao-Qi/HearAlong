// Checks the installed-app parts in Chrome (M7): Chrome finds the page installable (manifest, icons, service worker), and with the
// server stopped development explains npm start; packaged browsing explains the Mac app. No model is called.
// Usage: node --experimental-strip-types scripts/app-check.ts
import './check-env.ts';
import { testBrowser } from './test-browser.ts';
import { chromium } from 'playwright-core';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { until } from '../test/helpers/until.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const directory = await mkdtemp(join(tmpdir(), 'meeting-app-'));
const publicRoot = join(directory, 'public');
await cp(new URL('../public/', import.meta.url), publicRoot, { recursive: true });
await cp(new URL('../test/fixtures/legacy-sw.js', import.meta.url), join(publicRoot, 'sw.js'));
const notice = 'HearAlong is now an app on your Mac. Open HearAlong from your Applications folder. You can remove this Chrome version: open chrome://apps, right-click HearAlong, Remove from Chrome.';
let port = 0;
const setup = await dashboardSetup(directory, true);
let app = await startServer({ directory, port, publicRoot, setup, quick: null, heavy: null, recognizer: null, drafts: null });
port = Number(new URL(app.url).port);
// A real (not incognito) profile in a temporary folder: Chrome does not offer installing apps in incognito windows.
const profile = await mkdtemp(join(tmpdir(), 'meeting-app-profile-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: testBrowser(), headless: true, viewport: { width: 1280, height: 860 } });
try {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url);
  // Installation caches the Starting page; activation claims this tab. Both must finish before the server stops.
  // Keep the predicate synchronous: waitForFunction treats an async predicate's Promise as truthy, even if it resolves false.
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { timeout: 15_000 });
  check('the service worker is active', true);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors') as { installabilityErrors: { errorId: string }[] };
  check('Chrome finds the page installable', installabilityErrors.length === 0, installabilityErrors.map(e => e.errorId).join(', '));
  const manifest = await cdp.send('Page.getAppManifest') as { errors: unknown[]; url: string };
  check('the manifest has no errors', manifest.errors.length === 0, JSON.stringify(manifest.errors));
  check('the Wide/Compact switch is gone', await page.locator('#layout-switch').count() === 0);

  // The server stops: development asks for npm start, never tries to launch the removed helper.
  const externalRequests: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(app.url)) externalRequests.push(request.url()); });
  await app.close();
  await page.goto(`http://127.0.0.1:${port}/`).catch(() => {});
  await page.getByText('HearAlong server is not running', { exact: true }).waitFor({ timeout: 20_000 });
  check('development offline page explains npm start', await page.locator('#detail').innerText() === 'Start it with npm start from the app folder, then try again.');
  check('development offline script has no helper launch', !(await readFile(join(publicRoot, 'starting.js'), 'utf8')).includes('meetingassistant:'));
  app = await startServer({ directory, port, publicRoot, setup, quick: null, heavy: null, recognizer: null, drafts: null });
  await page.locator('#meeting-button').waitFor({ timeout: 15_000 });
  check('development browser has no migration notice', await page.locator('#update-bar').isHidden());
  check('development worker keeps Starting behavior', !(await (await fetch(app.url + '/sw.js')).text()).includes(notice));
  // An existing development cache can still contain the removed helper's script.
  await page.evaluate(async () => {
    await (await caches.open('starting-v2')).put('/starting.js', new Response('/* Fictional stale helper script */'));
  });
  await app.close();
  await cp(new URL('../public/sw.js', import.meta.url), join(publicRoot, 'sw.js'));
  app = await startServer({ directory, port, publicRoot, setup, quick: null, heavy: null, recognizer: null, drafts: null });
  await page.reload();
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await until(() => page.evaluate(async () => {
    const keys = await caches.keys();
    const script = await (await caches.open('starting-v3')).match('/starting.js');
    return keys.includes('starting-v3') && !keys.includes('starting-v2') && Boolean(script && (await script.text()).includes('npm start'));
  }));
  check('development worker refreshes the old helper cache', await page.evaluate(async () => (await (await caches.match('/starting.js'))!.text()).includes('npm start')));
  await app.close();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByText('HearAlong server is not running', { exact: true }).waitFor();
  check('updated development worker serves npm start offline', await page.locator('#detail').innerText() === 'Start it with npm start from the app folder, then try again.');
  app = await startServer({ directory, port, publicRoot, setup, quick: null, heavy: null, recognizer: null, drafts: null });
  await page.locator('#meeting-button').waitFor();
  await app.close();
  await cp(new URL('../public/sw.js', import.meta.url), join(publicRoot, 'sw.js'));
  process.env.HEARALONG_PACKAGED = '1';
  try { app = await startServer({ directory, port, publicRoot, setup, quick: null, heavy: null, recognizer: null, drafts: null }); }
  finally { delete process.env.HEARALONG_PACKAGED; }
  await page.reload();
  await page.locator('#update-text').filter({ hasText: notice }).waitFor();
  check('packaged browser shows the migration line without controls', await page.locator('#update-bar button:visible').count() === 0);
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await until(() => page.evaluate(async () => (await caches.keys()).length === 0));
  check('normal sw.js update replaces the development worker and clears its caches', true);
  // A navigation must always reach the server, never an indefinitely cached shell.
  await page.reload();
  await page.locator('#meeting-button').waitFor();
  const setupPage = await context.newPage();
  await setupPage.goto(app.url + '/setup');
  check('packaged setup also shows the migration line', await setupPage.locator('#setup-error').textContent() === notice);
  await setupPage.close();
  const desktop = await context.newPage();
  desktop.on('pageerror', e => errors.push(e.message));
  await desktop.addInitScript(() => { Object.defineProperty(window, 'hearalong', { value: { desktop: true, microphoneStatus: async () => 'granted' } }); });
  await desktop.goto(app.url);
  check('Electron never shows the migration notice', await desktop.locator('#update-bar').isHidden());
  await desktop.evaluate(async () => {
    const meeting = await (await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Fictional desktop focus' }) })).json();
    localStorage.setItem('meeting-id', meeting.id);
  });
  await desktop.reload();
  await desktop.locator('#start').click(); await desktop.locator('#start-online').click();
  check('desktop call chooser keeps the Chrome tab hidden', await desktop.locator('#call-tab').isHidden());
  check('desktop call chooser focuses the first visible button', await desktop.evaluate(() => document.activeElement === [...document.querySelectorAll<HTMLButtonElement>('#start-menu button')].find(item => !item.hidden && item.offsetParent)));
  await desktop.keyboard.press('Escape'); await desktop.close();
  await app.close();
  await page.goto(`http://127.0.0.1:${port}/`);
  check('offline after worker update: the complete migration line', await page.locator('#detail').textContent() === notice);
  check('offline page has no controls or helper-launch script', await page.locator('button, script').count() === 0);
  check('offline page keeps its styling without the server', await page.locator('main').evaluate(e => getComputedStyle(e).maxWidth) === '440px');
  check('offline worker caches no app shell', (await page.evaluate(() => caches.keys())).length === 0);
  check('development source remains unchanged', (await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')).includes("const OFFLINE_PAGE = '';"));
  check('no external launch requests', externalRequests.length === 0, externalRequests.join(' | '));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  check('the run finished', false, (error as Error).message.split('\n')[0]);
} finally {
  await context.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
console.log(results.join('\n'));
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed`);
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
