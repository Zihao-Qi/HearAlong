// FIX2 fixture/interaction driver. Assertions are in setup-check.ts.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

type Check = (page: Page, id: number, facts?: Record<string, any>) => Promise<void>;
export async function runSetupFix2Checks(check: Check) {
  const out = process.env.SETUP_FIX2_OUT!; assert.ok(out); await mkdir(out, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'setup-fix2-'));
  const previous = process.env.MEETING_CLOUD; process.env.MEETING_CLOUD = '0';
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null,
    setup: { scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
  if (previous === undefined) delete process.env.MEETING_CLOUD; else process.env.MEETING_CLOUD = previous;
  const browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
  const results: string[] = [], images: string[] = [], errors: string[] = [];
  const ai = { id: 'ai', state: 'ready', main: { id: 'example/main', source: 'saved' }, quick: { id: 'example/quick', source: 'saved' }, web: false };
  async function shot(page: Page, name: string) { await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); images.push(`${name}.png`); }
  async function fixture(width: number, details = false) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/setup.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    const state = { rows: [ { id: 'speech', state: 'none', download: { state: 'idle' }, downloadTargetPath: '/example/models/download.gguf' }, { id: 'ffmpeg', state: 'missing' }, ai ] };
    await page.route('**/api/setup', route => route.fulfill({ json: state }));
    await page.route('**/api/setup/speech-models', route => route.fulfill({ json: { models: [], truncated: false } }));
    await page.route('**/api/setup/ai/models?refresh=1', route => route.fulfill({ json: { state: 'ok', models: [{ id: 'example/main' }, { id: 'example/quick' }], count: 2, providers: ['example'] } }));
    await page.goto(`${app.url}/setup`);
    await page.evaluate(async ({ state, details }) => {
      const path = '/setup-ui.js'; const { SetupUI } = await import(path);
      const host = document.getElementById('setup-rows')!; if (details) host.id = 'setup-settings';
      const ui = new SetupUI(host, { details }); ui.status = state; ui.active = true; ui.render(); Object.assign(window, { fixUi: ui });
    }, { state, details });
    return { page, context };
  }
  const selected = process.env.SETUP_FIX2_CASES?.split(',').map(Number) ?? [1, 3, 4, 5, 6, 7, 8, 9];
  try {
    for (const id of selected) {
      const failures: string[] = [];
      for (const width of [1280, 390]) {
        const { page, context } = await fixture(width, id === 1);
        try {
          if (id === 1) {
            for (const shape of ['blob', 'snapshot']) {
              const hash = 'a'.repeat(64), path = `/home/example/.cache/huggingface/hub/models--example--parakeet-unified-en-0.6b-gguf/${shape === 'blob' ? `blobs/${hash}` : 'snapshots/rev/model.gguf'}`;
              await page.evaluate(path => { const ui = (window as any).fixUi; Object.assign(ui.status.rows[0], { state: 'ready', label: 'Parakeet 0.6B', path, source: 'Pi Voice' }); ui.render(); }, path);
              await shot(page, `01-${width}-${shape}`); await check(page, id, { shape });
            }
          } else if (id === 3) {
            await page.getByRole('button', { name: 'Other options' }).click(); await page.getByRole('button', { name: 'Choose…' }).waitFor();
            for (const [kind, message] of [
              ['missing', "Not a speech model HearAlong can run: ENOENT: no such file or directory, realpath '/var/example/missing.gguf'"],
              ['unreadable', "Not a speech model HearAlong can run: EACCES: permission denied, open '/private/example/weights.gguf'"],
              ['invalid', 'Not a speech model HearAlong can run: GGUF header is invalid.'],
              ['other', 'Example picker failed.\n    at file:///private/example/picker.ts:12'],
            ]) {
              await page.route('**/api/setup/speech/choose-file', route => route.fulfill({ status: 400, json: { error: message } }));
              await page.getByRole('button', { name: 'Choose…' }).click(); await page.locator('dialog [role="alert"]:not([hidden])').waitFor();
              await shot(page, `03-${width}-${kind}`); await check(page, id, { kind });
            }
          } else if (id === 4) {
            const outcomes = [];
            for (const role of ['speech', 'ai']) {
              const opener = page.locator(`[data-setup-row="${role}"] button`).first(); await opener.click();
              await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).waitFor();
              await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).focus();
              await page.mouse.click(3, 3); await page.waitForTimeout(100);
              outcomes.push({ role, open: await page.getByRole('dialog').count(), focused: await opener.evaluate(e => e === document.activeElement) });
              await shot(page, `04-${width}-${role}-backdrop`); await page.keyboard.press('Escape');
            }
            await check(page, id, { outcomes });
          } else if (id === 5) {
            for (const state of ['damaged', 'noSpace']) {
              await page.evaluate(state => { const ui = (window as any).fixUi; Object.assign(ui.status.rows[0], { state, download: { state, neededBytes: 800000000 } }); ui.render(); }, state);
              await shot(page, `05-${width}-${state}`); await check(page, id);
              await page.getByRole('button', { name: 'Other options', exact: true }).click(); await page.getByRole('button', { name: 'Choose…' }).waitFor(); await page.keyboard.press('Escape');
            }
          } else if (id === 6) {
            await page.evaluate(async () => { const path = '/setup-ui.js'; const { copyCommand } = await import(path); document.getElementById('setup-rows')!.append(copyCommand('pi'), copyCommand('pi install npm:pi-web-access')); });
            await shot(page, `06-${width}-copy-targets`); await check(page, id);
          } else if (id === 7) {
            await page.locator('[data-setup-row="ai"] button').click(); await page.locator('#su-ai-main').waitFor();
            await shot(page, `07-${width}-valid`); await check(page, id, { state: 'valid' });
            await page.locator('#su-ai-main').fill('unknown/model'); await shot(page, `07-${width}-invalid`); await check(page, id, { state: 'invalid' });
            await page.locator('#su-ai-main').fill('example/main'); await check(page, id, { state: 'valid' }); await page.keyboard.press('Escape');
            const envState = await page.evaluate(() => { const ui = (window as any).fixUi; ui.status.rows[2].main.source = 'env'; ui.render(); return ui.status; });
            await page.route('**/api/setup', route => route.fulfill({ json: envState }));
            await page.locator('[data-setup-row="ai"] button').click(); await page.locator('#su-ai-main').waitFor();
            await shot(page, `07-${width}-environment`); await check(page, id, { state: 'env' });
          } else if (id === 8) {
            for (const details of [false, true]) {
              await page.evaluate(details => { const ui = (window as any).fixUi; ui.details = details; ui.choice = { name: 'Example broken', current: 'Example current' }; Object.assign(ui.status.rows[0], { state: 'ready', label: 'Example current', switchError: "Couldn't load example.\n at file:///example/test.ts:1" }); ui.render(); }, details);
              await shot(page, `08-${width}-${details ? 'settings' : 'page'}-failed-switch`); await check(page, id);
            }
          } else if (id === 9) {
            await page.getByRole('button', { name: 'Other options' }).click(); await page.getByRole('button', { name: 'Choose…' }).waitFor();
            await shot(page, `09-${width}-empty-chooser`); await check(page, id);
          }
        } catch (e) { failures.push(`${width}: ${(e as Error).stack}`); }
        finally { await context.close(); }
      }
      const result = failures.length ? `FAIL FIX2.${id}\n${failures.join('\n')}` : `PASS FIX2.${id}`;
      results.push(result); console.log(result); if (failures.length) process.exitCode = 1;
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true });
    await writeFile(join(out, 'index.md'), '# Fix round 2 screenshots\n\n' + images.map(image => `- [${image}](${image})`).join('\n') + '\n\n' + results.map(result => result.split('\n')[0]).join('\n') + '\n');
    await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  }
}
