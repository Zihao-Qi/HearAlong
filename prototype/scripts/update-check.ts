// Update guard end-to-end contract. Disposable code/public/data roots; never uses the user's server or models.
// Usage: node --experimental-strip-types --import ./test/helpers/pi-env.ts scripts/update-check.ts [evidenceDir]
import assert from 'node:assert/strict';
import { testBrowser } from './test-browser.ts';
import { chromium, type Page } from 'playwright-core';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const out = resolve(process.argv[2] ?? 'artifacts/update-check'); await mkdir(out, { recursive: true });
const shots: string[] = [], errors: string[] = [], results: string[] = [];
const pass = (name: string) => { console.log(`PASS ${name}`); results.push(`PASS ${name}`); };
const verify = async (name: string, check: () => Promise<void>) => {
  try { await check(); pass(name); }
  catch (error) { const message = `FAIL ${name}: ${(error as Error).stack}`; results.push(message); console.error(message); }
};
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); shots.push(`${name}.png`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
};
const browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
const root = await mkdtemp(join(tmpdir(), 'hearalong-update-browser-'));
async function fixture(name: string, helper = true) {
  const codeRoot = join(root, name), directory = join(codeRoot, 'data'); await mkdir(directory, { recursive: true });
  for (const name of ['src', 'public', 'package.json', 'package-lock.json']) await cp(new URL(`../${name}`, import.meta.url), join(codeRoot, name), { recursive: true });
  const setup = await dashboardSetup(directory, true);
  let now = Date.now();
  let exitResolve!: () => void;
  const exited = new Promise<void>(r => { exitResolve = r; });
  const options = { directory, port: 0, codeRoot, publicRoot: join(codeRoot, 'public'), clock: () => now, setup,
    idleMs: helper ? 600_000 : undefined, exit: () => exitResolve(), quick: null, heavy: null, recognizer: null, drafts: null };
  const app = await startServer(options);
  const change = async () => { await writeFile(join(codeRoot, 'src', 'update-example.ts'), '// fictional update'); now += 30_000; };
  return { app, options, change, exited };
}
const visible = async (page: Page) => { await page.locator('#update-bar').waitFor({ timeout: 12_000 }); };
const hidden = async (page: Page) => { await page.locator('#update-bar').waitFor({ state: 'hidden', timeout: 8000 }); };
async function layout(page: Page) {
  const m = await page.evaluate(() => {
    const node = (id: string) => document.getElementById(id)!;
    const box = (id: string) => node(id).getBoundingClientRect();
    const bar = node('update-bar'), top = document.querySelector('.topbar')!, right = document.querySelector('.topbar-right')!;
    const b = box('update-restart'), l = box('update-later'), t = box('start');
    return { text: box('update-text').left, title: box('meeting-title').left, right: b.right, topRight: box('open-system').right,
      h: b.height, laterH: l.height, topH: t.height, gap: b.left - l.right, topGap: parseFloat(getComputedStyle(right).gap),
      py: getComputedStyle(bar).paddingTop, topPy: getComputedStyle(top).paddingTop,
      width: bar.getBoundingClientRect().width, top: bar.getBoundingClientRect().top, headerBottom: top.getBoundingClientRect().bottom,
      role: bar.getAttribute('role'), background: getComputedStyle(bar).backgroundColor };
  });
  for (const [a, b] of [[m.text, m.title], [m.right, m.topRight], [m.h, m.topH], [m.laterH, m.topH], [m.gap, m.topGap], [m.top, m.headerBottom]]) assert.ok(Math.abs(a - b) <= .5, JSON.stringify(m));
  assert.equal(m.py, m.topPy); assert.equal(m.role, 'status'); assert.equal(m.background, 'rgb(238, 242, 253)');
  assert.equal(m.width, page.viewportSize()!.width);
}
try {
  // Fixed baseline list: a new public asset would reproduce the old server's 403 failure.
  const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const map = source.match(/const staticFiles:[\s\S]*?\n\s*};/)![0];
  const keys = [...map.matchAll(/'([^']+)':\s*\[/g)].map(m => m[1]).sort();
  assert.deepEqual(keys, ['/', '/app.js', '/style.css', '/setup', '/setup.html', '/setup.js', '/setup.css', '/setup-ui.js', '/page-session.js', '/pcm-worklet.js', '/mini.html', '/mini.js', '/mini.css', '/live-shared.js', '/preview-composition.js', '/transcript-view.js', '/capture-clock.js', '/capture-gaps.js', '/plans.js', '/plans-fixtures.js', '/plans-fixtures-data.js', '/manifest.webmanifest', '/sw.js', '/starting.html', '/starting.css', '/starting.js', '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/marked-15.0.12.umd.js', '/vendor/purify-3.2.6.min.js', '/vendor/katex-0.16.22.min.js'].sort());
  pass('staticFiles keys unchanged');
  for (const width of [1280, 390]) {
    const f = await fixture(`helper-${width}`);
    const context = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(f.app.url); await page.locator('#meeting-button').waitFor();
      await hidden(page); await shot(page, `${width}-initial`); pass(`${width}: no initial bar`);
      await f.change(); await visible(page); await layout(page); await shot(page, `${width}-ready`); pass(`${width}: content change and exact layout`);

      // Keyboard order from the last top-bar button, and native Enter activation.
      await page.locator('#open-system').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.locator('#update-later').evaluate(n => n === document.activeElement), true);
      await page.keyboard.press('Tab'); assert.equal(await page.locator('#update-restart').evaluate(n => n === document.activeElement), true);
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter'); await hidden(page);
      await page.waitForTimeout(1200); await hidden(page); await shot(page, `${width}-later`);
      await page.reload(); await visible(page); pass(`${width}: keyboard Later, dismissal until reload`);

      const meeting = f.app.store.createMeeting('Example lantern workshop');
      const source = `mic:${randomUUID()}`;
      await f.app.capture.accept(meeting.id, source, 0, 0, Buffer.alloc(64_000));
      await hidden(page); await shot(page, `${width}-recording`);
      await f.app.capture.end(meeting.id, source, 0);
      for (const chunk of f.app.store.chunks(meeting.id)) f.app.store.setStatus(chunk.id, 'completed');
      await visible(page); await shot(page, `${width}-after-recording`); pass(`${width}: recording hides, finished recording restores`);
      const chunk = await f.app.store.addPcm(meeting.id, 'file:queue', 0, 1000, 16000, Buffer.alloc(64_000));
      await hidden(page); await shot(page, `${width}-queued`);
      f.app.store.setStatus(chunk.id, 'completed'); await visible(page); await shot(page, `${width}-after-queue`); pass(`${width}: queued transcription hides and restores`);

      // Race: work starts after the status that displayed Restart; the real endpoint must refuse it.
      let busyStatus = 0;
      await page.route('**/api/restart', async route => {
        const queued = await f.app.store.addPcm(meeting.id, 'file:race', 0, 2000, 16000, Buffer.alloc(64_000));
        const response = await route.fetch(); busyStatus = response.status();
        await route.fulfill({ response });
        setTimeout(() => f.app.store.setStatus(queued.id, 'completed'), 6500);
      });
      await page.locator('#update-restart').click();
      await page.waitForFunction(() => !document.getElementById('update-restart')!.hasAttribute('disabled'));
      assert.equal(busyStatus, 409); await shot(page, `${width}-busy-rejected`);
      await hidden(page); await shot(page, `${width}-busy-hidden`); await visible(page); pass(`${width}: real 409 Busy recovers then status hides`);
      await page.unroute('**/api/restart');

      // A successful response with an intentionally non-exiting stand-in tests width stability and the 10-second fallback.
      let shutdownReported = false;
      for (const pattern of ['**/api/status', '**/segments']) await page.route(pattern, async route => {
        const response = await route.fetch(); const json = await response.json();
        await route.fulfill({ response, json: { ...json, shuttingDown: shutdownReported } });
      });
      await page.route('**/api/restart', route => { shutdownReported = true; return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }); });
      const before = await page.locator('#update-restart').boundingBox();
      await page.locator('#update-later').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await page.getByText('Restarting HearAlong…', { exact: true }).waitFor();
      const after = await page.locator('#update-restart').boundingBox();
      for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(before![key] - after![key]) <= .5, `${key}: Restart box moved`);
      assert.equal(await page.locator('#update-restart').getAttribute('aria-label'), 'Restarting');
      assert.equal(await page.locator('#update-restart').isDisabled(), true);
      assert.equal(await page.locator('#update-spinner').isVisible(), true);
      assert.equal(await page.locator('#update-later').isVisible(), false);
      await page.waitForTimeout(1500); // selected meeting's one-second transcript poll must observe shutdown
      await verify(`${width}: selected-meeting shutdown leaves spinner bar active, never quit overlay`, async () => {
        assert.equal(await page.locator('#quit-banner').isVisible(), false);
        assert.equal(await page.locator('#update-bar').evaluate(n => (n as HTMLElement).inert), false);
        assert.equal(await page.locator('#update-spinner').isVisible(), true);
      });
      await shot(page, `${width}-restarting`); pass(`${width}: Enter Restart, stable box and spinner`);
      await page.getByText("Couldn’t restart. Close HearAlong and open it again.", { exact: true }).waitFor({ timeout: 12_000 });
      assert.equal(await page.locator('#update-bar button:visible').count(), 0);
      await verify(`${width}: selected-meeting failure line is not covered or inert`, async () => {
        assert.equal(await page.locator('#quit-banner').isVisible(), false);
        assert.equal(await page.locator('#update-bar').evaluate(n => (n as HTMLElement).inert), false);
      });
      await shot(page, `${width}-failed`); pass(`${width}: 10 s failure without buttons`);
      await page.unroute('**/api/status'); await page.unroute('**/segments');
      await page.unroute('**/api/restart');
      await page.reload(); await visible(page);

      // Real endpoint/shutdown. Observe the actual custom-scheme navigation at the OS boundary: the stand-in ignores it
      // while the old helper is alive/quitting, and can start a replacement ONLY on a later launch request.
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
      const cdp = await context.newCDPSession(page); await cdp.send('Page.enable');
      let helperReadyAt = Infinity, ignored = 0, launches = 0;
      let replacement: Awaited<ReturnType<typeof startServer>> | undefined;
      let starting: Promise<void> | undefined;
      void f.exited.then(() => { helperReadyAt = Date.now() + 4500; }); // several seconds of helper cleanup after exit
      cdp.on('Page.frameRequestedNavigation', event => {
        if (event.url !== 'meetingassistant://start') return;
        launches++;
        if (Date.now() < helperReadyAt) { ignored++; return; }
        starting ??= startServer({ ...f.options, port: Number(new URL(f.app.url).port) }).then(app => { replacement = app; });
      });
      try {
        await page.locator('#update-restart').click();
        await page.getByText('Starting HearAlong…', { exact: true }).waitFor({ timeout: 15_000 });
        await page.waitForFunction(() => document.getElementById('detail')!.textContent!.includes('allow it'));
        assert.equal(await page.locator('#update-bar').count(), 0, 'no update bar on the actual offline Starting page');
        await shot(page, `${width}-starting`);
        await page.locator('#meeting-button').waitFor({ timeout: 16_000 }); await hidden(page);
        assert.ok(ignored >= 1, 'old helper must ignore at least the first launch');
        assert.ok(launches > ignored && replacement, 'replacement starts only on a post-cleanup launch');
        await shot(page, `${width}-restarted`); pass(`${width}: real restart survives slow helper cleanup (${ignored} ignored / ${launches} launch requests)`);
      } finally { await cdp.detach(); await starting; await replacement?.close(); }
    } catch (error) {
      const message = `FAIL ${width}: ${(error as Error).stack}`; results.push(message); console.error(message);
    } finally { await context.close(); await f.app.close(); }

    const terminal = await fixture(`terminal-${width}`, false);
    const tc = await browser.newContext({ viewport: { width, height: 860 } });
    const tp = await tc.newPage(); tp.on('pageerror', e => errors.push(e.message));
    try {
      await tp.goto(terminal.app.url); await terminal.change(); await visible(tp);
      assert.equal(await tp.locator('#update-text').innerText(), 'HearAlong was updated. Run npm start again to use it.');
      assert.equal(await tp.locator('#update-restart').isVisible(), false);
      await shot(tp, `${width}-terminal`); await tp.locator('#update-later').click(); await hidden(tp);
      pass(`${width}: npm start Terminal line, Later only`);
      for (const [path, name] of [['/mini.html', 'mini'], ['/setup', 'setup']]) {
        await tp.goto(terminal.app.url + path, { waitUntil: 'domcontentloaded' });
        assert.equal(await tp.locator('#update-bar').count(), 0, `${path}: no update-strip markup`); await shot(tp, `${width}-${name}`);
      }
      pass(`${width}: no bar in mini or setup (offline Starting checked in the full restart path)`);
    } catch (error) { const message = `FAIL ${width} Terminal: ${(error as Error).stack}`; results.push(message); console.error(message); }
    finally { await tc.close(); await terminal.app.close(); }
  }
  await verify('390: every compact tab shares one row for standalone and project meetings', async () => {
    const f = await fixture('compact-tabs');
    const context = await browser.newContext({ viewport: { width: 390, height: 860 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(f.app.url); await page.locator('#meeting-button').waitFor();
      const tabs = async (name: string, count: number) => {
        const tops = await page.locator('#compact-tabs [role=tab]:visible').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
        assert.equal(tops.length, count, name); await shot(page, `390-tabs-${name}`);
        assert.ok(tops.every(t => Math.abs(t - tops[0]) <= .5), `${name}: wrapped tabs at ${tops}`);
      };
      // Keep checking all three cases in the red run, rather than stopping at the known no-meeting failure.
      await verify('390: compact tabs with no meetings', () => tabs('empty', 4));
      const meeting = f.app.store.createMeeting('Example compact workshop');
      await page.reload(); await page.getByText(meeting.title, { exact: true }).first().waitFor();
      await tabs('standalone', 4);
      const project = await (await context.request.post(f.app.url + '/api/projects', { headers: { Origin: f.app.url }, data: { name: 'Example lantern project' } })).json();
      const move = await context.request.post(`${f.app.url}/api/meetings/${meeting.id}/project`, { headers: { Origin: f.app.url }, data: { projectId: project.id } });
      assert.equal(move.status(), 200); await page.reload(); await page.locator('#ctab-project').waitFor(); await tabs('project', 5);
    } finally { await context.close(); await f.app.close(); }
  });
  assert.deepEqual(errors, []); pass('no page errors');
} finally {
  await browser.close(); await rm(root, { recursive: true, force: true });
  await writeFile(join(out, 'index.md'), `# Update guard screenshots\n\n${shots.map(s => `- [${s}](${s})`).join('\n')}\n\n## Checks\n\n${results.join('\n')}\n`);
}
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
