// Regression drivers for FIX1. Assertions (including visual ones) live in setup-check.ts.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { model, gguf } from '../test/helpers/gguf.ts';
import { until } from '../test/helpers/setup-pi.ts';

type Check = (page: Page, id: number, facts?: Record<string, any>) => Promise<void>;
const speechPath = '/private/var/folders/example/T/models/parakeet.gguf';
const catalogue = [
  { id: 'downloaded', name: 'Parakeet 0.6B', path: speechPath, inUse: true, streaming: true, source: 'downloaded' },
  { id: 'moonshine', name: 'Moonshine base', path: '/home/example/Downloads/moonshine.gguf', inUse: false, streaming: true, source: '~/Downloads' },
  { id: 'whisper', name: 'Whisper base', path: '/private/var/folders/example/T/cache/whisper.gguf', inUse: false, streaming: false, source: '/private/var/folders/example/T/cache' },
  { id: 'voxtral', name: 'Voxtral Mini', path: '/home/example/.cache/huggingface/voxtral.gguf', inUse: false, streaming: true, source: 'Hugging Face cache' },
  { id: 'moonshine-tiny', name: 'Moonshine tiny', path: '/home/example/Downloads/tiny.gguf', inUse: false, streaming: true, source: '~/Downloads' },
].map(m => { const file = { path: m.path, source: m.source, bytes: 100, fileType: 'Q8_0' }; return { ...m, sources: [m.source], files: [file], chosenFile: file }; });
const aiModels = { state: 'ok', models: [{ id: 'example/main' }, { id: 'example/quick' }], count: 2, providers: ['example'] };
function snapshot(change: Record<string, any> = {}) {
  return { seen: false, rows: [
    { id: 'speech', state: 'ready', label: 'Parakeet 0.6B', path: speechPath, source: 'downloaded', streaming: true,
      downloadTargetPath: speechPath, download: { state: 'done', path: speechPath }, ...change.speech },
    { id: 'ffmpeg', state: 'found', path: '/example/bin/ffmpeg', ...change.ffmpeg },
    { id: 'ai', state: 'ready', main: { id: 'example/main', source: 'saved' }, quick: { id: 'example/quick', source: 'saved' }, web: false, ...change.ai },
  ] };
}
export async function runSetupFix1Checks(check: Check) {
  const out = process.env.SETUP_FIX1_OUT!; assert.ok(out, 'SETUP_FIX1_OUT is required'); await mkdir(out, { recursive: true });
  const results: string[] = [], images: string[] = [], errors: string[] = [];
  const browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const body = gguf({ name: 'Parakeet 0.6B', padding: 50_000 });
  const transfer = createServer((_req, res) => { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); });
  await new Promise<void>(r => transfer.listen(0, '127.0.0.1', r));
  const address = transfer.address(); assert.ok(address && typeof address !== 'string'); const transferPort = address.port;
  async function fixture(options: { seen?: boolean; ready?: boolean; idle?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'setup-fix1-')); let found = true, delay = 0, idle = false;
    const file = options.ready === false ? null : await model(join(directory, 'current.gguf'), { name: 'Example current' });
    await model(join(directory, 'models', 'broken.gguf'), { name: 'Example broken' });
    if (options.ready === false) await rm(join(directory, 'models', 'broken.gguf'));
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ setupSeen: options.seen ?? true, speechModelPath: file }));
    const start = async (port = 0): Promise<Awaited<ReturnType<typeof startServer>>> => {
      const previous = process.env.MEETING_CLOUD; process.env.MEETING_CLOUD = '0';
      try { return await startServer({ directory, port, quick: null, heavy: null, actions: null, board: null, drafts: null,
        ...(options.idle ? { idleMs: 1000, onIdle: () => { idle = true; void app.close(); } } : {}),
        setup: { scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null },
          ffmpeg: async () => { await new Promise(r => setTimeout(r, delay)); return { found, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }; },
          worker: { workerScript: new URL('../test/fixtures/switch-worker.ts', import.meta.url) },
          download: { url: `http://127.0.0.1:${transferPort}/model`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') } } });
      } finally { if (previous === undefined) delete process.env.MEETING_CLOUD; else process.env.MEETING_CLOUD = previous; }
    };
    let app = await start();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    return { page, context, get app() { return app; }, setFound(value: boolean) { found = value; }, setDelay(value: number) { delay = value; }, get idle() { return idle; },
      async restart() { const port = Number(new URL(app.url).port); await app.close(); app = await start(port); },
      async repairModel() { await model(join(directory, 'models', 'slow.gguf'), { name: 'Example repaired' }); },
      async dispose() { await context.close(); await app.close(); await rm(directory, { recursive: true, force: true }); } };
  }
  async function shot(page: Page, name: string) { await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); images.push(`${name}.png`); }
  async function isolated(width: number, state = snapshot(), details = false, firefox = false) {
    const f = await fixture(); await f.page.setViewportSize({ width, height: 900 });
    if (firefox) await f.context.setExtraHTTPHeaders({});
    const cdp = await f.context.newCDPSession(f.page);
    if (firefox) await cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 Firefox/140.0' });
    await f.page.route('**/setup.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await f.page.route('**/api/setup', route => route.fulfill({ json: state }));
    await f.page.route('**/api/setup/speech-models', route => route.fulfill({ json: { models: catalogue, truncated: false } }));
    await f.page.route('**/api/setup/ai/models?refresh=1', route => route.fulfill({ json: aiModels }));
    await f.page.goto(`${f.app.url}/setup`);
    await f.page.evaluate(async ({ state, details }) => {
      const modulePath = '/setup-ui.js'; const { SetupUI } = await import(modulePath);
      const host = document.getElementById('setup-rows')!;
      if (details) host.id = 'setup-settings';
      const error = document.createElement('p'); error.id = 'fix1-error'; error.hidden = true; host.after(error);
      const ui = new SetupUI(host, { details, onError(e: Error | null) { error.hidden = !e; error.textContent = e?.message ?? ''; } });
      Object.assign(window, { fixUi: ui, fixSnapshot: state }); ui.status = state; ui.active = true; ui.render();
    }, { state, details });
    return f;
  }
  async function recheck(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.context.request.post(`${f.app.url}/api/setup/recheck`, { headers: { Origin: f.app.url } }); assert.ok(response.ok());
  }
  const selected = process.env.SETUP_FIX1_CASES?.split(',').map(Number) ?? Array.from({ length: 15 }, (_, i) => i + 1);
  async function run(id: number, fn: () => Promise<void>) {
    if (!selected.includes(id)) return;
    try { await fn(); results.push(`PASS FIX1.${id}`); }
    catch (e) { results.push(`FAIL FIX1.${id} ${(e as Error).stack}`); process.exitCode = 1; }
    console.log(results.at(-1));
  }
  try {
    await run(1, async () => {
      const f = await fixture({ seen: false, idle: true });
      try {
        let heartbeats = 0; f.page.on('request', request => { if (request.headers()['x-page']) heartbeats++; });
        await f.page.goto(`${f.app.url}/setup`); await f.page.locator('#open-app:not([disabled])').waitFor();
        await f.page.waitForTimeout(64_000); await shot(f.page, '01-1280-alive-after-grace');
        await f.page.setViewportSize({ width: 390, height: 900 }); await shot(f.page, '01-390-alive-after-grace');
        await check(f.page, 1, { idle: f.idle, heartbeats });
        await f.page.locator('#open-app').click(); await f.page.locator('#meeting-button').waitFor();
        await f.page.close(); await until(() => f.idle, 10_000);
      } finally { await f.dispose(); }
      const closing = await fixture({ seen: false, idle: true });
      try { await closing.page.goto(`${closing.app.url}/setup`); await closing.page.locator('[data-setup-row="speech"]').waitFor(); await closing.page.close(); await until(() => closing.idle, 10_000); }
      finally { await closing.dispose(); }
    });
    await run(2, async () => {
      for (const width of [1280, 390]) {
        const f = await fixture(); f.setFound(false); await f.page.goto(`${f.app.url}/setup`); await recheck(f); await f.page.goto(f.app.url); // No meetings: allow dashboard through a fictional meeting.
        // A seen returning user with a meeting can read the dashboard while FFmpeg is absent.
        f.app.store.createMeeting('Example readable meeting'); await f.page.goto(f.app.url); await f.page.setViewportSize({ width, height: 900 });
        let release!: () => void; const gate = new Promise<void>(r => release = r);
        try {
          await f.page.locator('#status-dot.error').waitFor();
          await f.page.route('**/api/setup', async route => { await gate; await route.fulfill({ status: 503, json: { error: 'Example unavailable status' } }); });
          await f.page.locator('#open-system').click();
          const first = { count: await f.page.locator('#setup-settings .su-row:visible').count(), missing: await f.page.locator('#setup-settings').innerText(),
            missingVisible: await f.page.locator('#setup-settings [data-setup-row="ffmpeg"] .su-detail').isVisible() };
          await shot(f.page, `02-${width}-held-snapshot`); release(); await f.page.locator('#setup-settings-error:not([hidden])').waitFor();
          await shot(f.page, `02-${width}-failed-refresh`); await check(f.page, 2, first);
        } finally { release(); await f.dispose(); }
      }
    });
    await run(3, async () => {
      const facts: Record<string, boolean> = {};
      for (const path of ['action', 'focus', 'visible', 'model-action', 'model-focus']) {
        const f = await fixture({ ready: !path.startsWith('model-') }); f.setFound(path === 'model-focus'); f.app.store.createMeeting('Example returning meeting');
        try {
          await f.page.goto(`${f.app.url}/setup`); await recheck(f); await f.page.goto(f.app.url); await f.page.locator('#status-dot.error').waitFor();
          if (path.startsWith('model-')) await f.repairModel();
          if (path.endsWith('action')) {
            f.setDelay(1500); await f.page.locator('#open-system').click(); await f.page.locator('#setup-settings [data-setup-row="ffmpeg"] button', { hasText: 'Check again' }).waitFor();
            await f.page.locator('#setup-settings [data-setup-row="ffmpeg"] button', { hasText: 'Check again' }).click(); await f.page.locator('#close-settings').click(); f.setFound(true); await f.page.waitForTimeout(path === 'model-action' ? 4500 : 2200);
          } else {
            // Simulate a Terminal install at the OS boundary, without updating the server's cached setup row.
            f.setFound(true);
            if (path.endsWith('focus')) await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
            else await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await f.page.waitForTimeout(path === 'model-focus' ? 3500 : 800);
          }
          facts[path] = !(await f.page.locator('#status-dot').evaluate(e => !e.hasAttribute('hidden') && e.classList.contains('error')));
          for (const width of [1280, 390]) { await f.page.setViewportSize({ width, height: 900 }); await shot(f.page, `03-${width}-${path}-recovered`); }
        } finally { await f.dispose(); }
      }
      const f = await isolated(1280); try { await check(f.page, 3, facts); } finally { await f.dispose(); }
    });
    await run(4, async () => {
      const state = snapshot({ speech: { state: 'downloading', download: { state: 'downloading', bytes: 100, total: 1000, etaSeconds: 2 } } });
      const f = await isolated(1280, state); let reads = 0; const times: number[] = [];
      try {
        await f.page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
        await f.page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
        await f.page.unroute('**/api/setup');
        await f.page.route('**/api/setup', async route => { reads++; times.push(await f.page.evaluate(() => Date.now())); await route.fulfill(reads <= 6 ? { status: 503, json: { error: 'Example transient failure' } } : { json: snapshot() }); });
        await f.page.evaluate(() => { void (window as any).fixUi.refresh(); }); await f.page.waitForTimeout(150);
        const firstError = await f.page.locator('#fix1-error').isVisible();
        let secondError = false;
        for (const ms of [1000, 2000, 4000, 8000, 10000, 10000]) {
          await f.page.clock.runFor(ms); await f.page.waitForTimeout(150);
          if (reads === 2) {
            secondError = await f.page.locator('#fix1-error').isVisible();
            for (const width of [1280, 390]) { await f.page.setViewportSize({ width, height: 900 }); await shot(f.page, `04-${width}-error-after-two`); }
          }
        }
        await f.page.unroute('**/api/setup');
        let release!: () => void, sequenceReads = 0; const gate = new Promise<void>(r => release = r);
        await f.page.route('**/api/setup', async route => {
          if (++sequenceReads === 1) { await gate; await route.fulfill({ json: state }); }
          else await route.fulfill({ json: snapshot() });
        });
        await f.page.evaluate(() => { void (window as any).fixUi.refresh(); }); await until(() => sequenceReads === 1);
        await f.page.evaluate(() => (window as any).fixUi.refresh()); release(); await f.page.waitForTimeout(150);
        const staleState = await f.page.evaluate(() => (window as any).fixUi.status.rows[0].state);
        for (const width of [1280, 390]) { await f.page.setViewportSize({ width, height: 900 }); await shot(f.page, `04-${width}-retry-recovery`); }
        await check(f.page, 4, { reads, times, firstError, secondError, staleState });
      } finally { await f.dispose(); }
    });
    await run(5, async () => {
      const f = await fixture();
      try {
        await f.page.goto(f.app.url); await f.page.locator('#open-system').click(); await f.page.locator('.settings-nav [data-section="setup"]').click(); await f.page.locator('#setup-settings .su-row').first().waitFor();
        await f.page.evaluate(async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          Object.assign(window, { delayedMicStream: stream, resolveMic: null });
          navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { (window as any).resolveMic = () => resolve(stream); });
        });
        const cdp = await f.context.newCDPSession(f.page); const { targetInfo } = await cdp.send('Target.getTargetInfo');
        await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'prompt', origin: f.app.url, browserContextId: targetInfo.browserContextId });
        await f.page.getByRole('button', { name: 'Allow', exact: true }).waitFor(); await f.page.getByRole('button', { name: 'Allow', exact: true }).click();
        await f.page.locator('#close-settings').click(); await f.page.locator('#open-system').click(); await f.page.locator('.settings-nav [data-section="setup"]').click();
        await f.page.evaluate(() => (window as any).resolveMic()); await f.page.waitForTimeout(200);
        for (const width of [1280, 390]) { await f.page.setViewportSize({ width, height: 900 }); await shot(f.page, `05-${width}-late-microphone`); await check(f.page, 5); }
      } finally { await f.dispose(); }
    });
    await run(6, async () => {
      const f = await fixture({ ready: false, seen: false });
      try {
        await f.page.goto(`${f.app.url}/setup`); await f.page.getByRole('button', { name: 'Download', exact: true }).click(); await f.page.locator('#open-app:not([disabled])').waitFor();
        await f.restart(); await f.page.reload(); await f.page.locator('[data-setup-row="speech"]').waitFor();
        for (const width of [1280, 390]) {
          await f.page.setViewportSize({ width, height: 900 }); await shot(f.page, `06-${width}-source-after-restart`);
          await f.page.locator('[data-setup-row="speech"]').getByRole('button', { name: 'Change' }).click(); await f.page.getByRole('button', { name: 'Choose…' }).waitFor();
          await shot(f.page, `06-${width}-after-restart`); const response = await f.context.request.get(`${f.app.url}/api/setup`); const data = await response.json(); await check(f.page, 6, { speech: data.rows.find((r: any) => r.id === 'speech') });
          await f.page.keyboard.press('Escape');
        }
      } finally { await f.dispose(); }
    });
    await run(7, async () => {
      const observations: Record<string, Record<string, boolean>> = {};
      for (const width of [1280, 390]) {
      observations[width] = {};
      for (const [state, label] of [['none', 'Download'], ['downloading', 'Pause'], ['paused', 'Resume'], ['damaged', 'Download again'], ['noSpace', 'Try again'], ['recheck', 'Check again'], ['mic', 'Allow']]) {
        const f = await isolated(width, snapshot({ speech: { state, download: { state, bytes: 100, total: 1000, etaSeconds: 1, neededBytes: 1000 } }, ffmpeg: state === 'recheck' ? { state: 'missing' } : {} }));
        let release!: () => void; const gate = new Promise<void>(r => release = r);
        try {
          await f.page.route('**/api/setup/**', async route => { if (route.request().method() === 'POST') { await gate; await route.fulfill({ json: snapshot() }); } else await route.fallback(); });
          if (state === 'mic') {
            const cdp = await f.context.newCDPSession(f.page); const { targetInfo } = await cdp.send('Target.getTargetInfo'); await cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'prompt', origin: f.app.url, browserContextId: targetInfo.browserContextId });
            await f.page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}); });
          }
          const target = f.page.getByRole('button', { name: label, exact: true }); await target.click();
          observations[width][label] = await f.page.getByRole('button', { name: state === 'recheck' ? 'Checking…' : label, exact: true }).isDisabled(); await shot(f.page, `07-${width}-${state}-disabled`);
        } finally { release(); await f.dispose(); }
      }
      }
      const f = await isolated(1280); try { await check(f.page, 7, observations); } finally { await f.dispose(); }
    });
    await run(8, async () => {
      for (const width of [1280, 390]) {
        const f = await isolated(width, snapshot(), false, true);
        try { await f.page.getByRole('link', { name: 'Open in Chrome' }).focus(); await f.page.evaluate(() => (window as any).fixUi.render()); await shot(f.page, `08-${width}-chrome-focus`); await check(f.page, 8); }
        finally { await f.dispose(); }
      }
    });
    for (const id of [9, 10, 11, 12, 13, 14, 15]) await run(id, async () => {
      const failures: string[] = [];
      for (const width of [1280, 390]) {
        try {
        if (id === 11) {
          const f = await fixture();
          try {
            await f.page.setViewportSize({ width, height: 900 }); await f.page.goto(f.app.url); await f.page.locator('#open-system').click(); await f.page.locator('.settings-nav [data-section="setup"]').click();
            await f.page.locator('#setup-settings [data-setup-row="speech"]').getByRole('button', { name: 'Change' }).click(); await f.page.getByRole('button', { name: 'Use Example broken', exact: true }).click();
            await f.page.waitForTimeout(1800); await shot(f.page, `11-${width}-failed-switch`); await check(f.page, 11);
          } finally { await f.dispose(); }
          continue;
        }
        const state = id === 10 ? snapshot({ speech: { source: 'Pi Voice', path: '/home/example/.cache/huggingface/hub/models--example--speech/snapshots/revision/parakeet-unified-en-0.6b-Q8_0.gguf', download: { state: 'idle' } } })
          : id === 9 ? snapshot({ speech: { source: '/private/var/folders/example/T/cache', path: '/private/var/folders/example/T/cache/whisper.gguf', label: 'Whisper base', download: { state: 'idle' }, streaming: false } })
          : id === 15 ? snapshot({ ai: { main: { id: 'example/main', source: 'env' } } }) : snapshot();
        const f = await isolated(width, state, id === 10);
        try {
          if ([9, 12, 13].includes(id)) {
            await f.page.locator('[data-setup-row="speech"]').getByRole('button', { name: 'Change' }).click(); await f.page.getByRole('button', { name: 'Choose…' }).waitFor();
            if (id === 9) await f.page.getByRole('button', { name: /Show all/ }).click();
            if (id === 13) { await f.page.getByRole('button', { name: /Show all/ }).click(); await f.page.getByRole('searchbox').fill('Moonshine base'); }
          }
          if ([14, 15].includes(id)) {
            await f.page.unroute('**/api/setup/ai/models?refresh=1'); await f.page.route('**/api/setup/ai/models?refresh=1', route => route.fulfill({ json: id === 14 ? { state: 'ok', count: 1, providers: ['example'], models: [{ id: 'example/main' }] } : aiModels }));
            await f.page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Change' }).click(); await f.page.locator('#su-ai-main').waitFor();
          }
          await shot(f.page, `${String(id).padStart(2, '0')}-${width}-visual`); await check(f.page, id);
        } finally { await f.dispose(); }
        } catch (e) { failures.push(`${width}: ${(e as Error).stack}`); }
      }
      assert.deepEqual(failures, []);
    });
    if (errors.length) { results.push(`FAIL page errors ${errors.join(' | ')}`); process.exitCode = 1; }
  } finally {
    await browser.close(); await new Promise<void>(r => transfer.close(() => r()));
    await writeFile(join(out, 'index.md'), '# Fix round 1 screenshots\n\n' + images.map(image => `- [${image}](${image})`).join('\n') + '\n\n' + results.map(r => r.split('\n')[0]).join('\n') + '\n');
    await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  }
}
