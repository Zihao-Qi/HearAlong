// Headless first-run browser contract. Only disposable data, fictional GGUFs, a local HTTP transfer and a fake Pi.
// SETUP_CHECK_OUT=/absolute/evidence/folder node --experimental-strip-types scripts/setup-check.ts
import assert from 'node:assert/strict';
import { testBrowser } from './test-browser.ts';
import { chromium, type Page } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { ModelDownload } from '../src/setup/model-download.ts';
import { fakePi, table, until } from '../test/helpers/setup-pi.ts';
import { gguf, model } from '../test/helpers/gguf.ts';

if (process.env.SETUP_CHECK_FIX2 === '1') {
  const { runSetupFix2Checks } = await import('./setup-fix2-check.ts');
  await runSetupFix2Checks(assertSetupFix2);
  process.exit(process.exitCode ?? 0);
}
if (process.env.SETUP_CHECK_FIX1 === '1') {
  const { runSetupFix1Checks } = await import('./setup-fix1-check.ts');
  await runSetupFix1Checks(assertSetupFix1);
  process.exit(process.exitCode ?? 0);
}

const out = resolve(process.env.SETUP_CHECK_OUT ?? 'artifacts/setup-check'); await mkdir(out, { recursive: true });
const cleanups: (() => unknown)[] = [], shots: string[] = [], checks: string[] = [], errors: string[] = [];
const directory = await mkdtemp(join(tmpdir(), 'hearalong-setup-ui-'));
const pi = await fakePi({ after(fn) { cleanups.push(fn); } });
const models = Array.from({ length: 320 }, (_, i) => `example example-${String(i).padStart(3, '0')} 128K 8K yes yes`);
const piTable = table(models); await pi.configure({ table: piTable });
const payload = gguf({ name: 'Example downloaded speech', padding: 1_000_000 });
let mode = 'slow', ffFound = false, ffDelay = 0, free = Infinity, selectedFile: string | null = null, download!: ModelDownload;
const downloadServer = createServer((req, res) => {
  const offset = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
  res.writeHead(offset ? 206 : 200, { 'Content-Length': payload.length - offset, ...(offset ? { 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` } : {}) });
  let position = offset;
  const timer = setInterval(() => {
    if (mode === 'drop' && position > offset + 50_000) { res.destroy(); return; }
    const end = Math.min(payload.length, position + (mode === 'fast' || mode === 'bad' ? payload.length : 20_000));
    const bytes = Buffer.from(payload.subarray(position, end)); if (mode === 'bad') bytes.fill(1);
    res.write(bytes); position = end; if (position === payload.length) res.end();
  }, 80);
  res.on('close', () => clearInterval(timer));
});
await new Promise<void>(r => downloadServer.listen(0, '127.0.0.1', r));
const address = downloadServer.address(); assert.ok(address && typeof address !== 'string');
let app = await startServer({ directory, port: 0, quick: null, heavy: null, drafts: null, actions: null, board: null,
  ai: { env: pi.env },
  setup: {
    scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, picker: async () => selectedFile,
    worker: { workerScript: new URL('../test/fixtures/switch-worker.ts', import.meta.url), loadMs: 10_000 },
    ffmpeg: async () => { await new Promise(r => setTimeout(r, ffDelay)); return { found: ffFound, ...(ffFound ? { ffmpeg: '/example/bin/ffmpeg', ffprobe: '/example/bin/ffprobe' } : {}) }; },
    createDownload(options) { download = new ModelDownload({ ...options, url: `http://127.0.0.1:${address.port}/model`, bytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'), freeSpace: async () => free }); return download; },
  },
});
const browser = await chromium.launch({ executablePath: testBrowser(), headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); shots.push(`${name}.png`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
}
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(app.url); assert.match(page.url(), /\/setup$/); pass(`${width}: first open redirects before app`);
    const api = async (path: string, method = 'GET', value?: unknown) => {
      const response = await context.request.fetch(`${app.url}${path}`, { method, headers: { Origin: app.url }, ...(value === undefined ? {} : { data: value }) });
      const data = await response.json(); if (!response.ok()) throw new Error(data.error); return data;
    };
    const refresh = async () => { await page.reload(); await page.locator('[data-setup-row="speech"]').waitFor(); };
    const speech = page.locator('[data-setup-row="speech"]'), ai = page.locator('[data-setup-row="ai"]');
    if (width === 1280) {
      await page.locator('#open-app:disabled').waitFor(); await shot(page, `${width}-none-ff-missing-ai-choose`);
      await page.getByRole('button', { name: 'Other options' }).click(); await page.getByText('Looked in Pi Voice', { exact: false }).waitFor();
      await shot(page, `${width}-speech-none`); await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Copy brew install ffmpeg', exact: true }).click();
      await page.getByRole('button', { name: 'Copied', exact: true }).waitFor(); pass('copy visible and aria labels');
      ffDelay = 2500; const checking = api('/api/setup/recheck', 'POST'); await new Promise(r => setTimeout(r, 150)); await refresh();
      await speech.getByText('Looking on this Mac…').waitFor(); await shot(page, `${width}-looking`); await checking; ffDelay = 0;
      // A real transfer exercises pause, resume, connection loss, damaged and space refusal through the page.
      mode = 'slow'; await speech.getByRole('button', { name: 'Download', exact: true }).click(); await speech.getByRole('button', { name: 'Pause' }).waitFor();
      await shot(page, `${width}-downloading`); await speech.getByRole('button', { name: 'Pause' }).click(); await speech.getByText('Paused at', { exact: false }).waitFor();
      await shot(page, `${width}-paused`); mode = 'drop'; await speech.getByRole('button', { name: 'Resume' }).click();
      await speech.getByText('Connection lost at', { exact: false }).waitFor(); await shot(page, `${width}-connection-lost`);
      await api('/api/setup/speech/cancel', 'POST'); mode = 'bad'; await refresh(); await speech.getByRole('button', { name: 'Download', exact: true }).click();
      await speech.getByText('The file is damaged.').waitFor(); await shot(page, `${width}-damaged`);
      free = 0; await speech.getByRole('button', { name: 'Download again' }).click(); await speech.getByText('Not enough space.', { exact: false }).waitFor();
      await shot(page, `${width}-no-space`); free = Infinity; mode = 'fast'; await speech.getByRole('button', { name: 'Try again' }).click();
      await speech.getByRole('button', { name: 'Change', exact: true }).waitFor(); await shot(page, `${width}-speech-ready`);
      // Hash checking is deliberately held at the injectable download boundary; no browser response is mocked.
      download.state = { state: 'checking' }; await refresh(); await speech.getByText('Checking the file…').waitFor(); await shot(page, `${width}-checking-file`);
      download.state = { state: 'done', path: download.path }; ffFound = true; await api('/api/setup/recheck', 'POST');
      // Long merged discovery list, including one failed preflight worker and a slow one.
      for (let i = 0; i < 16; i++) await model(join(directory, 'models', `${i === 0 ? 'slow' : i === 1 ? 'broken' : `example-${i}`}.gguf`), {
        name: `Example speech ${String(i).padStart(2, '0')}`, family: i % 3 === 0 ? 'whisper' : 'parakeet',
      });
      await api('/api/setup/recheck', 'POST');
    }
    await refresh();
    assert.equal(await page.getByText('Recording needs Google Chrome').count(), 0, 'Chrome does not need a Chrome row');
    if (width === 390) {
      ffDelay = 2500; const looking = api('/api/setup/recheck', 'POST'); await page.waitForTimeout(100); await refresh();
      await speech.getByText('Looking on this Mac…').waitFor(); await shot(page, `${width}-looking`); await looking; ffDelay = 0; await refresh();
    }
    // Repeat all stable transfer render states at both widths, server-injected rather than client-only fixtures.
    for (const state of [
      { state: 'downloading', bytes: 312_000_000, total: 731_357_568, etaSeconds: 61 },
      { state: 'paused', bytes: 312_000_000 }, { state: 'interrupted', bytes: 312_000_000, reason: 'Example dropped connection' },
      { state: 'checking' }, { state: 'damaged' }, { state: 'noSpace', neededBytes: 831_357_568 },
    ] as const) {
      download.state = state; await refresh(); await shot(page, `${width}-speech-${state.state}`);
      if (state.state === 'downloading') await speech.getByRole('button', { name: 'Pause' }).click();
      if (['paused', 'interrupted', 'damaged', 'noSpace'].includes(state.state)) {
        const action = state.state === 'damaged' ? 'Download again' : state.state === 'noSpace' ? 'Try again' : 'Resume';
        mode = 'fast'; await speech.getByRole('button', { name: action, exact: true }).click();
        await until(() => download.state.state === 'done');
      }
    }
    download.state = { state: 'paused', bytes: 0 }; mode = 'slow'; await refresh();
    await speech.getByRole('button', { name: 'Resume' }).click(); await speech.getByRole('button', { name: 'Pause' }).waitFor();
    await speech.getByRole('button', { name: 'Pause' }).click(); await speech.getByText('Paused at', { exact: false }).waitFor();
    mode = 'fast'; await speech.getByRole('button', { name: 'Resume' }).click(); await until(() => download.state.state === 'done'); await refresh();
    await page.waitForFunction(() => document.querySelector('[data-setup-row="speech"] .su-detail')?.textContent?.endsWith(' · downloaded'));
    await shot(page, `${width}-speech-ready-downloaded`);
    await speech.getByRole('button', { name: 'Change' }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Show all 16' }).waitFor(); assert.equal(await page.locator('dialog .su-model-list .su-row').count(), 3);
    assert.equal(await page.locator('dialog .su-choice .su-in-use').count(), 1, 'the downloaded model is marked In use');
    await shot(page, `${width}-speech-folded`); await page.getByRole('button', { name: 'Show all 16' }).click();
    await page.getByRole('searchbox').fill('speech 15'); assert.equal(await page.locator('dialog .su-model-list .su-row').count(), 1);
    await shot(page, `${width}-speech-filter`); await page.getByRole('searchbox').fill('not a model'); await page.getByText('No model matches', { exact: false }).waitFor();
    await shot(page, `${width}-speech-no-match`); await page.getByRole('searchbox').fill(''); await shot(page, `${width}-speech-all`);
    await page.getByRole('button', { name: 'Show fewer' }).click(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.closest('[data-setup-row="speech"]') && document.activeElement.textContent === 'Change');
    // Keyboard-only picker action and Escape on both dialogs.
    await speech.getByRole('button', { name: 'Change' }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Speech model', exact: true }).waitFor();
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Escape');
    selectedFile = null; await speech.getByRole('button', { name: 'Change' }).click(); await page.getByRole('button', { name: 'Choose…' }).click();
    assert.equal(await page.getByRole('dialog', { name: 'Speech model', exact: true }).count(), 1);
    selectedFile = join(directory, 'not-a-model.gguf'); await page.getByRole('button', { name: 'Choose…' }).click();
    await page.getByRole('alert').getByText('Couldn’t open this file.', { exact: true }).waitFor(); await shot(page, `${width}-speech-picker-error`);
    selectedFile = join(directory, 'models', 'example-2.gguf'); await page.getByRole('button', { name: 'Choose…' }).click();
    await page.getByRole('dialog', { name: 'Speech model', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(200);
    // A complete keyboard-only speech choice: open, expand, type a filter, Use, and return.
    await speech.getByRole('button', { name: 'Change' }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Show all 16' }).waitFor();
    for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement?.textContent?.startsWith('Show all'))); i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter'); await page.getByRole('searchbox').waitFor();
    await page.keyboard.type('speech 04'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Speech model', exact: true }).waitFor({ state: 'detached' }); await page.waitForTimeout(200);
    // The worker fixture gives slow.gguf a 1500ms preflight and broken.gguf a real failure.
    for (const number of ['00', '01', '03']) {
      const recording = number === '00' ? app.store.createMeeting('Example pending change') : null;
      const source = `mic:${randomUUID()}`;
      if (recording) await app.capture.accept(recording.id, source, 0, 0, Buffer.alloc(64));
      await speech.getByRole('button', { name: 'Change' }).click(); await page.getByRole('button', { name: /Show all/ }).click();
      await page.getByRole('button', { name: `Use Example speech ${number}`, exact: true }).click();
      if (number === '01') {
        await speech.getByText('Couldn’t switch to Example speech 01. Still using Example speech 00.', { exact: true }).waitFor();
        await shot(page, `${width}-switch-failed`);
      }
      else {
        if (recording) {
          await refresh(); await speech.getByText('Change applies after recording', { exact: false }).waitFor(); await shot(page, `${width}-switch-after-recording`);
          await app.capture.end(recording.id, source, 0); await page.waitForTimeout(1000);
          await refresh(); await speech.getByText('Loading the speech model…').waitFor(); await shot(page, `${width}-switch-pending`);
        }
        await page.waitForTimeout(1700); await refresh();
      }
      if (recording) { await app.jobs.wait(); app.store.deleteMeeting(recording.id); }
    }
    await speech.getByText('no live preview', { exact: false }).waitFor(); await shot(page, `${width}-no-live-preview`);
    const current = (await api('/api/setup')).rows.find((r: { id: string }) => r.id === 'speech').path;
    await rm(current); await api('/api/setup/recheck', 'POST'); await refresh(); await speech.getByText('The saved speech model is missing:', { exact: false }).waitFor(); await shot(page, `${width}-saved-file-missing`);
    await model(current, { name: 'Example speech 03', family: 'whisper' }); await api('/api/setup/recheck', 'POST');
    // Pi states come from the fake executable, including slow auth and a quota refusal.
    for (const [name, config] of [
      ['signed-out', { table: 'No models available. Use /login to log into a provider.', listDelay: 1000 }],
      ['unreadable', { table: 'unexpected format', listDelay: 1000 }], ['choose', { table: piTable }],
    ] as const) {
      await pi.configure(config); await api('/api/setup/recheck', 'POST'); await refresh(); await shot(page, `${width}-ai-${name}`);
      if (name === 'signed-out') { await ai.getByRole('button', { name: 'Copy pi', exact: true }).click(); await ai.getByRole('button', { name: 'Copied', exact: true }).waitFor(); }
      if (name !== 'choose') {
        await ai.getByRole('button', { name: 'Check again' }).click(); await ai.getByRole('button', { name: 'Checking…' }).waitFor();
        await shot(page, `${width}-ai-${name}-rechecking`); await ai.getByRole('button', { name: 'Check again' }).waitFor();
      }
    }
    const command = pi.env.MEETING_PI;
    pi.env.MEETING_PI = join(directory, 'missing-pi'); await api('/api/setup/recheck', 'POST'); await refresh();
    await ai.getByText('Pi is not installed. Run npm ci.').waitFor(); await shot(page, `${width}-ai-not-installed`);
    await ai.getByRole('button', { name: 'Check again' }).click(); await ai.getByRole('button', { name: 'Check again' }).waitFor();
    pi.env.MEETING_PI = command; await api('/api/setup/recheck', 'POST'); await refresh();
    const openAi = async () => { await ai.getByRole('button', { name: /Choose models|Change/ }).click(); await page.locator('#su-ai-main').waitFor(); };
    await openAi(); assert.equal(await page.locator('#su-pi-models option').count(), 320); await shot(page, `${width}-ai-dialog`);
    await page.locator('#su-ai-main').fill('unknown'); await page.locator('#su-ai-main-error').waitFor(); assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), false);
    await shot(page, `${width}-ai-invalid`); await page.locator('#su-ai-main').fill('example/example-001'); await page.locator('#su-ai-quick').fill('example/example-002');
    // Catalog changes between open and save: the 400 is the real server's validation message.
    await pi.configure({ table: table(['example other 128K 8K yes yes']) }); await api('/api/setup/recheck', 'POST'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').getByText('Pi doesn’t list example/example-001.').waitFor(); await shot(page, `${width}-ai-400`);
    await page.keyboard.press('Escape'); await pi.configure({ table: piTable, authDelay: 2500 }); await api('/api/setup/recheck', 'POST'); await refresh();
    await ai.getByRole('button', { name: /Choose models|Change/ }).focus(); await page.keyboard.press('Enter'); await page.locator('#su-ai-main').waitFor();
    await page.keyboard.press('Tab'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('example/example-001');
    await page.keyboard.press('Tab'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('example/example-002');
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await ai.getByText('Checking access…').waitFor(); await shot(page, `${width}-ai-checking`); await ai.getByText('example-001, example-002', { exact: true }).waitFor({ timeout: 10_000 }); await shot(page, `${width}-ai-ready`);
    await pi.configure({ table: piTable, auth: { status: 'not_ready', reason: 'Example quota exhausted' } }); await api('/api/setup/recheck', 'POST'); await refresh();
    await ai.getByText('No access · Example quota exhausted').waitFor(); await shot(page, `${width}-ai-no-access`);
    await openAi(); await page.keyboard.press('Escape');
    await pi.configure({ table: table(['example other 128K 8K yes yes']) }); await api('/api/setup/recheck', 'POST'); await refresh(); await shot(page, `${width}-ai-missing`);
    await openAi(); await page.keyboard.press('Escape');
    await pi.configure({ table: piTable }); await api('/api/setup/recheck', 'POST'); await refresh();
    pi.env.MEETING_HEAVY_MODEL = 'example/example-001'; await refresh(); await openAi();
    assert.equal(await page.locator('#su-ai-main').inputValue(), 'example/example-001');
    assert.equal(await page.locator('#su-ai-main').evaluate((e: HTMLInputElement) => e.readOnly), true);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), false);
    await shot(page, `${width}-ai-environment`); await page.keyboard.press('Escape'); delete pi.env.MEETING_HEAVY_MODEL; await refresh();
    // Prompt is a real Chrome permission state; fake UI accepts it, and fake audio never touches a physical microphone.
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'prompt', origin: app.url, browserContextId: targetInfo.browserContextId });
    await refresh(); await page.getByRole('button', { name: 'Allow', exact: true }).waitFor(); await shot(page, `${width}-microphone-not-asked`);
    await page.evaluate(() => {
      const tracks: MediaStreamTrack[] = []; Object.assign(window, { setupTestTracks: tracks });
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); tracks.push(...stream.getTracks()); return stream; };
    });
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.getByText('Say something', { exact: true }).waitFor(); await shot(page, `${width}-microphone-level`); await page.waitForTimeout(4300);
    assert.equal(await page.evaluate(() => { const tracks = (window as unknown as { setupTestTracks: MediaStreamTrack[] }).setupTestTracks; return tracks.length > 0 && tracks.every(t => t.readyState === 'ended'); }), true);
    await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: app.url, browserContextId: targetInfo.browserContextId });
    await refresh(); await page.getByText('Allowed', { exact: true }).waitFor(); await shot(page, `${width}-microphone-allowed`);
    await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: app.url, browserContextId: targetInfo.browserContextId });
    await refresh(); await page.getByText('Blocked.', { exact: false }).waitFor(); await shot(page, `${width}-microphone-blocked`);
    await api('/api/setup/seen', 'POST'); await page.goto(app.url); await page.locator('#meeting-button').waitFor();
    await page.locator('#open-system').click(); await page.locator('.settings-nav [data-section="setup"]').click(); await page.locator('#setup-settings .su-row').first().waitFor(); await shot(page, `${width}-settings-setup`);
    await page.locator('#setup-settings [data-setup-row="speech"]').getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Show all 16' }).waitFor(); await shot(page, `${width}-settings-speech-dialog`); await page.keyboard.press('Escape');
    await page.locator('#setup-settings [data-setup-row="ai"]').getByRole('button', { name: 'Change' }).click();
    await page.locator('#su-ai-main').waitFor(); await shot(page, `${width}-settings-ai-dialog`); await page.keyboard.press('Escape');
    await page.locator('.settings-nav [data-section="speech"]').click(); assert.equal(await page.locator('#model').count(), 0); await shot(page, `${width}-settings-speech`);
    await page.locator('.settings-nav [data-section="cloud"]').click(); await page.locator('#setup-web').getByText('Web search is not installed.', { exact: false }).waitFor(); await shot(page, `${width}-settings-web`);
    await page.getByRole('button', { name: 'Copy pi install npm:pi-web-access', exact: true }).click(); await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await page.locator('#close-settings').click();
    const meeting = app.store.createMeeting('Example returning meeting'); ffFound = false; await api('/api/setup/recheck', 'POST'); await page.goto(app.url);
    await page.locator('#meeting-button').waitFor(); await page.locator('#status-dot.error:not([hidden])').waitFor(); await page.locator('#open-system').click();
    assert.equal(await page.locator('.settings-nav [data-section="setup"]').getAttribute('aria-current'), 'page'); await shot(page, `${width}-speech-off-opens-setup`);
    pass(`${width}: states, dialogs, validation, settings, existing meetings remain readable`);
    // Keep a meeting for second width; remove it to verify needed-not-ready/no-meetings explicitly below.
    await page.locator('#close-settings').click();
    app.store.deleteMeeting(meeting.id); await page.goto(app.url); assert.match(page.url(), /\/setup$/); pass(`${width}: needed missing with no meetings redirects`);
    ffFound = true; await api('/api/setup/recheck', 'POST'); await api('/api/settings', 'PUT', { setupSeen: false });
    await context.close();
  }
  // A separately isolated first-run also covers AI off, an empty scan, FFmpeg recheck and the outside-Chrome row at each width.
  for (const width of [1280, 390]) {
    const fresh = await mkdtemp(join(tmpdir(), 'hearalong-setup-off-')); let found = false, delay = 0;
    const previousCloud = process.env.MEETING_CLOUD; delete process.env.MEETING_CLOUD;
    await pi.configure({ table: piTable, listDelay: 2500 });
    const reading = await startServer({ directory: fresh, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, ai: { env: pi.env },
      setup: { scan: { home: join(fresh, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found }) } });
    const readingContext = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await readingContext.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(reading.url);
      await page.getByText('Reading Pi’s models…').waitFor(); await shot(page, `${width}-ai-reading`);
      await page.getByRole('button', { name: 'Choose models' }).waitFor(); await shot(page, `${width}-ai-choose-fresh`);
      await page.getByRole('button', { name: 'Choose models' }).click(); await page.locator('#su-ai-main').waitFor();
      assert.equal(await page.locator('#su-pi-models option').count(), 320);
      await shot(page, `${width}-ai-choose-dialog`); await page.keyboard.press('Escape');
    } finally { await readingContext.close(); await reading.close(); }
    process.env.MEETING_CLOUD = '0';
    const off = await startServer({ directory: fresh, port: 0, quick: null, heavy: null, recognizer: null, drafts: null,
      setup: { scan: { home: join(fresh, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => { await new Promise(r => setTimeout(r, delay)); return { found }; },
        download: { url: `http://127.0.0.1:${address.port}/model`, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') } } });
    if (previousCloud === undefined) delete process.env.MEETING_CLOUD; else process.env.MEETING_CLOUD = previousCloud;
    const context = await browser.newContext({ viewport: { width, height: 900 }, userAgent: 'Mozilla/5.0 Firefox/140.0' });
    try {
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(off.url);
      await page.getByText('Off for this start (MEETING_CLOUD=0).').waitFor();
      await page.getByText('None found. Parakeet:', { exact: false }).waitFor(); await page.getByText('Recording needs Google Chrome').waitFor();
      assert.equal(await page.locator('[data-setup-row="ai"] button').count(), 0);
      await shot(page, `${width}-none-off-ff-missing-outside-chrome`);
      await page.getByRole('button', { name: 'Copy brew install ffmpeg', exact: true }).click();
      await page.getByRole('button', { name: 'Copied', exact: true }).waitFor(); await shot(page, `${width}-ffmpeg-copied`);
      // Click the real handoff link, but intercept its default navigation: never launch the owner's Chrome.
      const handoff = page.getByRole('link', { name: 'Open in Chrome', exact: true });
      await handoff.evaluate((a: HTMLAnchorElement) => a.addEventListener('click', event => { event.preventDefault(); a.dataset.testClicked = a.href; }, { once: true }));
      await handoff.click(); assert.equal(await handoff.getAttribute('data-test-clicked'), `google-chrome://${new URL(off.url).host}/setup`);
      await page.getByRole('button', { name: 'Other options' }).click(); await page.getByText('Looked in Pi Voice', { exact: false }).waitFor();
      await shot(page, `${width}-empty-speech-chooser`); mode = 'slow';
      if (width === 1280) await page.getByRole('dialog', { name: 'Speech model', exact: true }).getByRole('button', { name: 'Download', exact: true }).click();
      else { await page.keyboard.press('Escape'); await page.locator('[data-setup-row="speech"]').getByRole('button', { name: 'Download', exact: true }).click(); }
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor(); await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByText('Paused at', { exact: false }).waitFor(); mode = 'fast'; await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.locator('[data-setup-row="speech"]').getByRole('button', { name: 'Change', exact: true }).waitFor();
      found = true; delay = 2500; await page.locator('[data-setup-row="ffmpeg"]').getByRole('button', { name: 'Check again' }).click();
      await page.locator('[data-setup-row="ffmpeg"]').getByRole('button', { name: 'Checking…' }).waitFor(); await shot(page, `${width}-ffmpeg-checking`);
      await page.locator('[data-setup-row="ffmpeg"]').getByText('Found', { exact: true }).waitFor(); delay = 0;
      let reads = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/setup') reads++; });
      await page.waitForTimeout(2200); assert.equal(reads, 0, 'no setup polling when all rows are idle'); pass(`${width}: off, empty scan, FFmpeg recheck, outside Chrome and idle polling`);
    } finally { await context.close(); await off.close(); await rm(fresh, { recursive: true, force: true }); }
  }
  assert.deepEqual(errors, []); pass('no page errors');
} finally {
  await browser.close(); await app.close(); await new Promise<void>(r => downloadServer.close(() => r()));
  for (const cleanup of cleanups.reverse()) await cleanup(); await rm(directory, { recursive: true, force: true });
  await writeFile(join(out, 'index.md'), '# Setup UI browser evidence\n\n' + shots.map(s => `- [${s}](${s})`).join('\n') + '\n\n## Checks\n' + checks.map(s => `- PASS ${s}`).join('\n') + '\n');
}

export async function assertSetupFix2(page: Page, id: number, facts: Record<string, any> = {}) {
  switch (id) {
    case 1:
      assert.equal(await page.locator('[data-setup-row="speech"] .su-detail').innerText(),
        `Parakeet 0.6B · ~/.cache/huggingface/…/parakeet-unified-en-0.6b-gguf${facts.shape === 'snapshot' ? '/model.gguf' : ''} (Pi Voice)`); break;
    case 3:
      assert.equal(await page.locator('dialog [role="alert"]').innerText(), facts.kind === 'invalid' ? 'This file isn’t a speech model.' : facts.kind === 'other' ? 'Example picker failed.' : 'Couldn’t open this file.'); break;
    case 4:
      assert.deepEqual(facts.outcomes, [{ role: 'speech', open: 0, focused: true }, { role: 'ai', open: 0, focused: true }]); break;
    case 5:
      assert.equal(await page.getByRole('button', { name: 'Other options', exact: true }).count(), 1);
      assert.equal(await page.locator('[data-setup-row="speech"] .su-button.primary').count(), 1); break;
    case 6:
      for (const copy of await page.locator('[data-copy-command]').all()) { const box = await copy.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44, 'every Copy target is at least 44 × 44 px'); }
      break;
    case 7: {
      const input = page.locator('#su-ai-main'), ids = (await input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
      assert.deepEqual(ids, facts.state === 'env' ? ['su-ai-main-environment'] : facts.state === 'invalid' ? ['su-ai-main-error'] : []);
      for (const id of ids) assert.equal(await page.locator(`#${id}`).isVisible(), true);
      assert.equal(await page.locator('#su-ai-quick').getAttribute('aria-describedby'), null, 'valid Quick has no hidden-hint description'); break;
    }
    case 8:
      assert.doesNotMatch(await page.locator('#setup-rows').innerText(), /'/, 'new visible setup prose uses curly apostrophes'); break;
    case 9:
      assert.equal(await page.locator('dialog .su-model-list .su-row .su-title').innerText(), 'None found');
      assert.equal(await page.locator('dialog .su-model-list .su-row .su-detail').innerText(), 'Looked in Pi Voice, the Hugging Face cache and MEETING_MODEL_PATH'); break;
  }
}

// FIX1 assertions stay beside the original browser contract; the companion module only drives fixtures/interactions.
export async function assertSetupFix1(page: Page, id: number, facts: Record<string, any> = {}) {
  switch (id) {
    case 1:
      assert.equal(facts.idle, false, 'setup must keep the server alive beyond grace + idle');
      assert.ok(facts.heartbeats >= 3, 'setup sends X-Page heartbeats'); break;
    case 2:
      assert.equal(facts.count, 4, 'four cached rows visible before held response');
      assert.match(facts.missing, /Install it in Terminal/); assert.equal(facts.missingVisible, true);
      assert.equal(await page.locator('#setup-settings .su-row:visible').count(), 4, 'keep cached rows on a failed first refresh'); break;
    case 3:
      assert.deepEqual(facts, { action: true, focus: true, visible: true, 'model-action': true, 'model-focus': true }, 'action completion and foreground repair clear Speech off for both FFmpeg and a loading model'); break;
    case 4:
      assert.equal(facts.firstError, false, 'one transient busy failure is silent');
      assert.equal(facts.secondError, true, 'two consecutive busy failures show an error');
      assert.equal(facts.reads, 7, 'busy polling recovers after six failed responses');
      assert.deepEqual(facts.times.slice(1).map((t: number, i: number) => t - facts.times[i]), [1000, 2000, 4000, 8000, 10000, 10000]);
      assert.equal(await page.locator('#fix1-error').isVisible(), false, 'success clears the error');
      assert.equal(facts.staleState, 'ready', 'late busy response cannot overwrite a newer ready snapshot'); break;
    case 5:
      assert.equal(await page.locator('#setup-settings .su-meter').count(), 0, 'late permission response must not restart the meter');
      assert.equal(await page.evaluate(() => (window as any).delayedMicStream.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended')), true); break;
    case 6:
      assert.equal(typeof facts.speech.downloadTargetPath, 'string', 'download target is present after restart, even when transfer is idle');
      assert.match(await page.locator('[data-setup-row="speech"] .su-detail').innerText(), / · downloaded$/);
      assert.equal(await page.locator('dialog .su-choice .su-in-use').count(), 1); break;
    case 7:
      for (const width of [1280, 390]) assert.deepEqual(facts[width], { Download: true, Pause: true, Resume: true, 'Download again': true, 'Try again': true, 'Check again': true, Allow: true });
      break;
    case 8:
      assert.equal(await page.getByRole('link', { name: 'Open in Chrome' }).evaluate(e => e.closest('[data-setup-row]')?.getAttribute('data-setup-row')), 'chrome');
      assert.equal(await page.getByRole('link', { name: 'Open in Chrome' }).evaluate(e => e === document.activeElement), true); break;
    case 9:
      assert.doesNotMatch((await page.locator('.su-detail').allInnerTexts()).join('\n'), /\/private\/var|\/Users\/example|Hugging Face cache/);
      assert.match(await page.locator('[data-setup-row="speech"] .su-detail').innerText(), /^Whisper base · cache · no live preview$/); break;
    case 10: {
      const text = await page.locator('[data-setup-row="speech"] .su-detail').innerText();
      assert.equal(text, 'Parakeet 0.6B · ~/.cache/huggingface/…/speech/parakeet-unified-en-0.6b-Q8_0.gguf (Pi Voice)');
      assert.equal(text.split('parakeet-unified-en-0.6b-Q8_0.gguf').length - 1, 1); break;
    }
    case 11: {
      const row = page.locator('#setup-settings [data-setup-row="speech"]');
      assert.match(await row.innerText(), /Couldn’t switch to Example broken\. Still using Example current\./);
      const error = await row.locator('.su-switch-error').innerText(); assert.ok(error.length <= 120); assert.doesNotMatch(error, /\n|\s+at\s|\.ts:\d|\.gguf\.pids/);
      assert.equal(await row.locator('.su-error').count(), 0, 'calm row, not a red stack trace');
      const errorBox = await row.locator('.su-switch-error').boundingBox(); assert.ok(errorBox && errorBox.height <= 22, 'technical error occupies one visual line'); break;
    }
    case 12:
      assert.equal(await page.locator('dialog .su-model-list .su-in-use').count(), 0, 'downloaded model excluded from On this Mac');
      assert.equal(await page.locator('dialog .su-in-use').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Show all 4', exact: true }).count(), 1); break;
    case 13: {
      const use = await page.locator('dialog .su-model-list .su-button').first().boundingBox(), current = await page.locator('dialog .su-choice .su-in-use').boundingBox();
      assert.ok(use && current); assert.ok(Math.abs(use.width - current.width) <= 0.5, 'In use has Use button width');
      assert.ok(Math.abs(use.x + use.width - current.x - current.width) <= 0.5, 'In use and Use have the same right edge'); break;
    }
    case 14:
      assert.equal(await page.locator('dialog .su-count').innerText(), 'From Pi · 1 model from 1 provider'); break;
    case 15: {
      assert.equal(await page.getByText('Model choices are set by the environment for this start.', { exact: true }).count(), 0);
      const hint = page.getByText('Set by the environment.', { exact: true }), save = page.getByRole('button', { name: 'Save', exact: true });
      assert.equal(await hint.count(), 1); assert.equal(await save.isDisabled(), true);
      assert.equal(await save.getAttribute('aria-describedby'), await hint.getAttribute('id')); assert.equal(await save.getAttribute('title'), await hint.innerText()); break;
    }
  }
}
