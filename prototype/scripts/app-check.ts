// Checks the installed-app parts in Chrome (M7): Chrome finds the page installable (manifest, icons, service worker), and with the
// server stopped the app shows "Starting…" and loads by itself once the server is back. No model is called.
// Usage: node --experimental-strip-types scripts/app-check.ts
import { chromium } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const directory = await mkdtemp(join(tmpdir(), 'meeting-app-'));
const port = 4394;
const setup = await dashboardSetup(directory, true);
let app = await startServer({ directory, port, setup, quick: null, heavy: null, recognizer: null, drafts: null });
// A real (not incognito) profile in a temporary folder: Chrome does not offer installing apps in incognito windows.
const profile = await mkdtemp(join(tmpdir(), 'meeting-app-profile-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.MEETING_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, viewport: { width: 1280, height: 860 } });
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

  // The server stops: reopening the app shows "Starting…"; when the server is back, the app loads by itself.
  await app.close();
  await page.goto(`http://127.0.0.1:${port}/`).catch(() => {});
  await page.locator('text=Starting HearAlong').waitFor({ timeout: 20_000 });
  check('server stopped: the app shows Starting…', true);
  check('server stopped: the Starting page runs (asks Chrome to open the helper)', /allow it/.test(await page.locator('#detail').innerText()));
  app = await startServer({ directory, port, setup, quick: null, heavy: null, recognizer: null, drafts: null });
  await page.locator('#meeting-button').waitFor({ timeout: 15_000 });
  check('server back: the app loads by itself', true);
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
