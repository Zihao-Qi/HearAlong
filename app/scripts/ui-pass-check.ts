// Fictional response fixtures on the real dashboard; no model, microphone, or private data.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { testBrowser } from './test-browser.ts';
import { checkSetupPage } from './setup-page-cases.ts';

const out = resolve(process.argv[2] ?? 'artifacts/ui-pass');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'ui-pass-'));
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
try {
  const setup = await dashboardSetup(directory, true);
  const saved = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...saved, aiMode: 'cloud', cloudConsent: { providers: ['example'], time: 1 } }));
  app = await startServer({ directory, port: 0, setup, recognizer: null, drafts: null, quick: null, heavy: null, actions: null,
    board: async () => { throw new Error('No model calls in this check.'); } });
  const meeting = app.store.createMeeting('Weekly sync');
  const session = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const created = await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { Cookie: session, Origin: app.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Star garden', fromMeetingId: meeting.id }) });
  assert.equal(created.status, 201);
  const project = await created.json();
  browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(id => localStorage.setItem('meeting-id', id), meeting.id);
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('requestfailed', r => console.error('REQUEST FAILED', r.url(), r.failure()));
  page.on('console', m => { if (m.type() === 'error') console.error('BROWSER', m.text()); });
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
  let storageError: string | null = null, mode = 'cloud', used = 2;
  let files = { state: 'ok', folder: '~/Research/star-garden/project-memory', captured: 0, skipped: 0, skippedFiles: [] as string[] };
  await page.route('**/api/status', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, transcriptionStorageError: storageError, ai: { ...data.ai, mode } } });
  });
  await page.route('**/api/settings', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, aiMode: mode, autoAnswersEnabled: mode !== 'off' } });
  });
  await page.route(`**/api/meetings/${meeting.id}/board`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), autoUsed: used, enabled: mode !== 'off' } });
  });
  await page.route(`**/api/projects/${project.id}/memory`, async route => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), files } });
  });
  await page.route(`**/api/meetings/${meeting.id}`, async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, project: { ...data.project, repoPath: '~/Research/star-garden' } } });
  });
  await page.goto(app.url);
  await page.waitForFunction(() => document.getElementById('meeting-title')?.textContent === 'Weekly sync');
  const open = async (section: string) => {
    if (!await page.locator('#settings').isVisible()) await page.locator('#open-system').click();
    await page.locator(`.settings-nav [data-section="${section}"]`).click();
  };
  await open('cloud');
  await page.waitForFunction(() => document.getElementById('auto-answers-detail')?.textContent === 'Up to 5 per meeting. 2 used so far.');
  assert.equal(await page.locator('#auto-answers').isChecked(), true);
  assert.equal(await page.locator('#auto-answers').isVisible(), true);
  assert.doesNotMatch(await page.locator('#scan-board').getAttribute('title') ?? '', /automatic answers used/);
  await shot('ai-ticked-2-used'); pass('AI: default ticked, current meeting count, Scan tooltip has no count');
  await page.locator('#auto-answers').uncheck();
  await page.waitForFunction(() => document.getElementById('auto-answers-detail')?.textContent === 'Up to 5 per meeting. You can still press Answer on a question.');
  await page.waitForFunction(() => !(document.getElementById('auto-answers') as HTMLInputElement).checked && !document.getElementById('auto-answers')?.dataset.running);
  await shot('ai-unticked');
  const cookie = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  const request = async (value: object) => {
    const response = await fetch(`${app!.url}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, Origin: app!.url, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200);
  };
  await page.reload(); await open('cloud');
  assert.equal(await page.locator('#auto-answers').isChecked(), false); pass('AI: unticked persists on reload');
  mode = 'local'; await page.reload(); await open('cloud');
  assert.equal(await page.locator('#auto-answers').isVisible(), true); pass('AI: switch is visible in On this Mac mode');
  mode = 'off'; await page.reload(); await open('cloud');
  assert.equal(await page.locator('#auto-answers').isVisible(), false); pass('AI: switch is hidden with AI Off');
  mode = 'cloud'; used = 0; await request({ autoAnswers: true }); await page.reload(); await open('cloud');
  await page.waitForFunction(() => document.getElementById('auto-answers-detail')?.textContent === 'Up to 5 per meeting.');
  pass('AI: unused meeting has no usage suffix');
  await page.locator('#close-settings').click();
  for (const [error, text, name] of [
    ['ENOSPC: fictional transcript write failed', 'Transcription paused: the disk is full. Details', 'paused-disk-full'],
    ['SQLITE_IOERR_WRITE: fictional disk I/O error', 'Transcription paused: couldn’t save. Details', 'paused-other'],
  ]) {
    storageError = error;
    await page.waitForFunction(text => document.getElementById('connection')?.textContent === text, text);
    assert.equal(await page.locator('#connection').evaluate(e => getComputedStyle(e).color), 'rgb(92, 68, 0)');
    assert.equal(await page.locator('#connection').evaluate(e => getComputedStyle(e).whiteSpace), 'nowrap');
    await page.locator('#connection button').focus(); await page.waitForTimeout(2300);
    assert.equal(await page.locator('#connection button').evaluate(e => document.activeElement === e), true, 'status polling keeps Details focused');
    await page.locator('#connection button').evaluate(e => (e as HTMLButtonElement).blur());
    await shot(name);
    await page.locator('#connection button').click();
    assert.equal(await page.locator('.settings-section[data-section="activity"]').isVisible(), true);
    await page.waitForTimeout(2300);
    assert.equal(await page.locator('#log .log-line').filter({ hasText: `Transcription storage: ${error}` }).count(), 1);
    await page.locator('#close-settings').click(); pass(`${name}: exact text, warning ink, Details opens Activity, one full error across polls`);
  }
  storageError = null;
  await page.waitForFunction(() => document.getElementById('connection')?.textContent === '');
  assert.equal(await page.locator('#connection').evaluate(e => e.classList.contains('warn')), false); pass('storage warning clears after recovery');
  for (const [state, skipped, text, name] of [
    ['ok', 0, 'Memory files: ~/Research/star-garden/project-memory', 'memory-ok'],
    ['ok', 2, 'Memory files: ~/Research/star-garden/project-memory · 2 files skipped (links or over 1 MB)', 'memory-skipped'],
    ['not ours', 0, 'Memory files are off: project-memory/ has files HearAlong didn’t write.', 'memory-not-ours'],
  ] as const) {
    files = { ...files, state, skipped, skippedFiles: skipped ? ['inbox/linked.md', 'inbox/large.md'] : [] };
    await open('project');
    await page.waitForFunction(text => document.getElementById('project-files')?.textContent === text, text);
    const warning = state === 'not ours' ? page.locator('#project-files') : page.locator('#project-files span');
    if (skipped || state === 'not ours') assert.equal(await warning.evaluate(e => getComputedStyle(e).color), 'rgb(92, 68, 0)');
    await shot(name);
    await open('project'); await page.waitForTimeout(100);
    if (skipped) for (const file of files.skippedFiles) assert.equal(await page.locator('#log .log-line').filter({ hasText: `Memory file refused (${file})` }).count(), 1);
    pass(`${name}: exact single-line wording, warning ink and deduplicated Activity names`);
  }
  files = { ...files, state: 'ok', skipped: 1, skippedFiles: ['inbox/linked.md'] }; await open('project');
  await page.waitForFunction(() => document.getElementById('project-files')?.textContent?.endsWith('1 file skipped (links or over 1 MB)'));
  files = { ...files, state: 'repo missing', skipped: 0 }; await open('project');
  await page.waitForFunction(() => document.getElementById('project-files')?.textContent === 'The repo folder is missing: memory files are paused. Save the folder’s new location above.');
  pass('memory: singular skipped wording and repo-missing wording unchanged');

  let speechReady = true;
  const setupPage = await context.newPage(); setupPage.on('pageerror', e => errors.push(e.message));
  await setupPage.route('**/api/setup', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, seen: false, rows: data.rows.map((r: { id: string }) => r.id === 'speech'
      ? { ...r, state: speechReady ? 'ready' : 'none', label: 'Parakeet 0.6B', source: 'downloaded', path: '/fictional/model.gguf', downloadTargetPath: '/fictional/model.gguf' }
      : r.id === 'ffmpeg' ? { ...r, state: 'missing' } : { ...r, state: 'ready', mode: 'local', main: { id: 'ollama/example-garden:4b' }, quick: { id: 'ollama/example-garden:4b' } }) } });
  });
  await request({ audioRetention: 'day' }); await setupPage.goto(`${app.url}/setup`);
  await setupPage.getByText('recordings use about 230 MB an hour, kept 1 day', { exact: false }).waitFor();
  assert.deepEqual(await setupPage.locator('.su-group').first().locator('[data-setup-row]').evaluateAll(es => es.map(e => e.getAttribute('data-setup-row'))), ['speech']);
  assert.deepEqual(await setupPage.locator('.su-group').last().locator('[data-setup-row]').evaluateAll(es => es.map(e => e.getAttribute('data-setup-row'))), ['ai', 'microphone', 'ffmpeg']);
  assert.equal(await setupPage.locator('[data-setup-row="ffmpeg"] .su-detail').innerText(), 'Only for importing audio or video files. Install it in Terminal, or from ffmpeg.org');
  await setupPage.screenshot({ path: join(out, 'first-run-setup.png') }); pass('setup: Needed speech only; Optional AI, microphone, FFmpeg; exact import and retention text');
  for (const [setting, kept] of [['week', 'kept 1 week'], ['month', 'kept 1 month'], ['always', 'kept until you delete them']]) {
    await request({ audioRetention: setting }); await setupPage.reload();
    await setupPage.waitForFunction(kept => document.querySelector('[data-setup-row="speech"] .su-detail')?.textContent?.endsWith(kept), kept);
  }
  pass('setup: week, month and Always come from saved settings');
  speechReady = false; await setupPage.reload(); await setupPage.locator('#open-app:disabled').waitFor();
  speechReady = true; await setupPage.reload(); await setupPage.locator('#open-app:not(:disabled)').waitFor();
  pass('setup: Open HearAlong requires ready speech, not optional FFmpeg');
  await page.locator('#close-settings').click(); await open('setup');
  assert.deepEqual(await page.locator('#setup-settings [data-setup-row]').evaluateAll(es => es.map(e => e.getAttribute('data-setup-row'))), ['speech', 'ai', 'microphone', 'ffmpeg']);
  await page.locator('#close-settings').click();
  const cdp = await context.newCDPSession(setupPage);
  await cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 Firefox/140.0' }); await setupPage.reload();
  await setupPage.locator('[data-setup-row="chrome"]').waitFor();
  assert.deepEqual(await setupPage.locator('[data-setup-row]').evaluateAll(es => es.map(e => e.getAttribute('data-setup-row'))), ['speech', 'ai', 'microphone', 'chrome', 'ffmpeg']);
  const handoff = setupPage.getByRole('link', { name: 'Open in Chrome', exact: true });
  await handoff.evaluate((a: HTMLAnchorElement) => a.addEventListener('click', event => { event.preventDefault(); a.dataset.checkedHref = a.href; }, { once: true }));
  await handoff.click(); assert.equal(await handoff.getAttribute('data-checked-href'), `google-chrome://${new URL(app.url).host}/setup`);
  await open('speech'); assert.equal(await page.locator('#model').count(), 0);
  await open('cloud'); assert.equal(await page.locator('#setup-web').isVisible(), false); assert.equal(await page.locator('#setup-web').textContent(), '');
  await page.locator('#close-settings').click();
  pass('setup: Settings uses the same order; Chrome handoff is exact; obsolete speech/web controls absent');
  // Read and open the supplied design in this same test Chrome, without external requests.
  if (process.env.UI_PASS_MOCKUP) {
    const source = await readFile(process.env.UI_PASS_MOCKUP, 'utf8');
    await page.route('**/ui-pass-mockup', route => route.fulfill({ contentType: 'text/html', body: source }));
    await page.goto(`${app.url}/ui-pass-mockup`);
    for (const id of ['t-auto', 't-setup', 't-paused', 't-memory']) await page.locator(`#${id}`).click();
    pass('supplied mockup opened in test Chrome; tabs 1–4 inspected');
  }
  await checkSetupPage(browser, app.url, out); pass('current setup contracts, including surviving FIX1/FIX2 cases');
  assert.deepEqual(errors, []); pass('no browser page errors');
  console.log(`${checks} checks passed`);
} finally {
  await browser?.close(); await app?.close(); await rm(directory, { recursive: true, force: true });
}
