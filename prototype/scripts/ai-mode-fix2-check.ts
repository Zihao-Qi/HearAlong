import './check-env.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { Keychain } from '../src/setup/api-keys.ts';
import { fakePi, table, until } from '../test/helpers/setup-pi.ts';

const rows = ['ollama example-local 32K 4K no no', 'openai-codex gpt-6.1-sol 32K 4K no no', 'openai-codex gpt-6-luna 32K 4K no no'];
export async function checkFix2(browser: Browser, out: string) {
  await mkdir(out, { recursive: true });
  const results: { name: string; pass: boolean; error?: string }[] = [];
  const screenshots: string[] = [];
  for (const width of [1280, 390]) {
    const run = async (name: string, saved: object, work: (page: Page, pi: Awaited<ReturnType<typeof fakePi>>, app: Awaited<ReturnType<typeof startServer>>) => Promise<void>, config: Record<string, unknown> = {}, forced = false) => {
      const hooks: (() => unknown)[] = [];
      const pi = await fakePi({ after: fn => hooks.push(fn) }, { table: table(rows), ...config });
      const directory = await mkdtemp(join(tmpdir(), 'ai-fix2-'));
      const keys = new Map<string, string>();
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await writeFile(join(directory, 'settings.json'), JSON.stringify({ setupSeen: true, aiMode: 'local', localMainModel: 'ollama/example-local', localQuickModel: 'ollama/example-local', ...saved }));
      const previous = process.env.MEETING_CLOUD;
      if (forced) process.env.MEETING_CLOUD = '0';
      const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null,
        board: async () => ({ text: '{"items":[]}', ms: 1, attempts: 1, aborted: false, usages: [] }),
        ai: { env: pi.env, tiny: async () => ({ text: 'OK', tools: [], toolEvents: 0, toolResults: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, ms: 1 }) },
        keys: { keychain: { read: async (p: string) => keys.get(p) ?? null, write: async (p: string, key: string) => { keys.set(p, key); }, remove: async (p: string) => { keys.delete(p); } } as unknown as Keychain, fetch: async () => new Response('{"data":[]}') },
        setup: { scan: { home: directory, hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
      if (previous === undefined) delete process.env.MEETING_CLOUD; else process.env.MEETING_CLOUD = previous;
      app.store.createMeeting('Example UI review meeting');
      try {
        await work(page, pi, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const file = `${width}-${name}.png`; await page.screenshot({ path: join(out, file), fullPage: true }); screenshots.push(file);
        results.push({ name: `${width}-${name}`, pass: true });
      } catch (error) {
        const file = `${width}-${name}-failure.png`; await page.screenshot({ path: join(out, file), fullPage: true }).catch(() => {}); screenshots.push(file);
        results.push({ name: `${width}-${name}`, pass: false, error: (error as Error).message });
      } finally { await context.close(); await app.close(); await rm(directory, { recursive: true, force: true }); for (const hook of hooks.reverse()) await hook(); }
    };
    const open = async (page: Page, url: string) => { await page.goto(url + '/setup'); await page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Change', exact: true }).click(); await page.locator('#su-ai-main').waitFor(); };
    const cloud = async (page: Page) => { await page.getByRole('radio', { name: 'Cloud', exact: true }).click(); await page.locator('#su-cloud-consent').waitFor(); };
    await run('1-key-add-live', {}, async (page, _pi, app) => {
      await open(page, app.url); await cloud(page);
      await page.getByRole('button', { name: 'Add a Gemini API key', exact: true }).click(); await page.locator('#su-key-input').fill('fictional-key'); await page.getByRole('button', { name: 'Save key', exact: true }).click();
      await page.getByRole('button', { name: 'Remove the Gemini key', exact: true }).waitFor();
      assert.equal(await page.locator('#su-pi-models option[value="google/fictional"]').count(), 1);
      await page.locator('#su-ai-main').fill('google/fictional'); await page.locator('#su-ai-quick').fill('google/fictional'); await page.locator('#su-cloud-consent').check();
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
    }, { keyRows: { google: ['google fictional 32K 4K no no'] } });
    await run('1-key-remove-no-local-id', {}, async (page, _pi, app) => {
      await open(page, app.url); await cloud(page);
      await page.getByRole('button', { name: 'Add a Gemini API key', exact: true }).click(); await page.locator('#su-key-input').fill('fictional-key'); await page.getByRole('button', { name: 'Save key', exact: true }).click();
      await page.getByRole('button', { name: 'Remove the Gemini key', exact: true }).waitFor();
      await page.locator('#su-ai-main').fill('google/fictional'); await page.getByRole('button', { name: 'Remove the Gemini key', exact: true }).click();
      await page.getByRole('button', { name: 'Add a Gemini API key', exact: true }).waitFor();
      assert.equal((await page.locator('#su-ai-main').inputValue()).startsWith('ollama/'), false);
      assert.equal(await page.locator('#su-pi-models option[value="google/fictional"]').count(), 0);
    }, { keyRows: { google: ['google fictional 32K 4K no no'] } });
    await run('2-cloud-defaults', {}, async (page, _pi, app) => {
      await open(page, app.url); await cloud(page);
      assert.equal(await page.locator('#su-ai-main').inputValue(), 'openai-codex/gpt-6.1-sol');
      assert.equal(await page.locator('#su-ai-quick').inputValue(), 'openai-codex/gpt-6-luna');
      await page.locator('#su-cloud-consent').check(); assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
    });
    await run('2-no-cloud-hint', {}, async (page, _pi, app) => {
      await open(page, app.url); await cloud(page);
      assert.match(await page.locator('dialog.setup-ui').innerText(), /sign in.*Pi|Pi.*sign in|\/login/i);
    }, { table: table(rows.slice(0, 1)) });
    await run('3-dialog-close-promise', {}, async (page, _pi, app) => {
      await page.goto(app.url + '/setup');
      await page.evaluate(async () => {
        const { aiDialog, setupRequest } = await import('/setup-ui.js' as string);
        const snapshot = await setupRequest('/api/setup');
        (window as any).dialogSettled = false;
        void aiDialog(snapshot.rows.find((row: any) => row.id === 'ai'), () => setupRequest('/api/setup')).then(() => { (window as any).dialogSettled = true; });
      });
      await page.locator('#su-ai-main').waitFor(); assert.equal(await page.evaluate(() => (window as any).dialogSettled), false);
      await page.keyboard.press('Escape'); await until(async () => page.evaluate(() => (window as any).dialogSettled));
    });
    await run('3-settings-save-live', { aiMode: 'off', cloudMainModel: 'openai-codex/gpt-6.1-sol', cloudQuickModel: 'openai-codex/gpt-6-luna' }, async (page, _pi, app) => {
      await page.goto(app.url); await page.locator('#open-system').click(); await page.locator('.settings-nav [data-section="cloud"]').click();
      await page.locator('#settings-ai-change').click(); await page.getByRole('radio', { name: 'Cloud', exact: true }).click(); await page.locator('#su-cloud-consent').check();
      await page.getByRole('button', { name: 'Save', exact: true }).last().click(); await page.locator('dialog.setup-ui').waitFor({ state: 'detached' });
      await until(async () => await page.locator('#board-model').isVisible() && await page.locator('#board-model').isEnabled(), 2000);
      assert.match(await page.locator('#cloud').innerText(), /Cloud/);
    });
    await run('3-setup-save-live', { aiMode: 'off', cloudMainModel: 'openai-codex/gpt-6.1-sol', cloudQuickModel: 'openai-codex/gpt-6-luna' }, async (page, _pi, app) => {
      await page.goto(app.url); await page.locator('#open-system').click(); await page.locator('.settings-nav [data-section="setup"]').click();
      await page.locator('#setup-settings [data-setup-row="ai"]').getByRole('button', { name: 'Change', exact: true }).click();
      await page.getByRole('radio', { name: 'Cloud', exact: true }).click(); await page.locator('#su-cloud-consent').check();
      await page.getByRole('button', { name: 'Save', exact: true }).last().click(); await page.locator('dialog.setup-ui').waitFor({ state: 'detached' });
      await page.locator('.settings-nav [data-section="cloud"]').click();
      await until(async () => await page.locator('#board-model').isVisible() && await page.locator('#board-model').isEnabled(), 2000);
      assert.match(await page.locator('#cloud').innerText(), /Cloud/);
    });
    await run('4-recheck-focus', {}, async (page, pi, app) => {
      await pi.configure({ table: table(rows.slice(1)) }); await page.goto(app.url + '/setup');
      await page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Change', exact: true }).click(); await page.getByRole('button', { name: 'Check again', exact: true }).waitFor();
      await pi.configure({ table: table(rows) }); await page.getByRole('button', { name: 'Check again', exact: true }).click(); await page.locator('#su-ai-main').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'su-ai-main');
      const opener = await page.evaluate(() => window.opener === null); await page.getByRole('radio', { name: 'On this Mac', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await page.locator('#su-cloud-consent').waitFor();
      assert.equal(await page.evaluate(() => window.opener === null), opener);
    });
    await run('4-window-opener-unchanged', {}, async (page, _pi, app) => {
      await open(page, app.url); const wasNull = await page.evaluate(() => window.opener === null);
      await page.getByRole('radio', { name: 'On this Mac', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await page.locator('#su-cloud-consent').waitFor();
      assert.equal(await page.evaluate(() => window.opener === null), wasNull);
    });
    for (const change of [false, true]) await run(`4-notice-${change ? 'change' : 'keep'}-focus`, { aiMode: 'cloud', mainModel: 'openai-codex/gpt-6.1-sol', quickModel: 'openai-codex/gpt-6-luna', cloudNotice: true, cloudConsent: { providers: ['openai-codex'], time: 1, legacy: true } }, async (page, _pi, app) => {
      await page.goto(app.url); await page.locator('#ai-cloud-notice').waitFor();
      assert.equal(await page.locator('#ai-cloud-notice').getAttribute('role'), 'status');
      assert.equal(await page.locator('#ai-cloud-notice').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(238, 242, 253)');
      assert.equal(await page.locator('#ai-notice-keep').evaluate(e => getComputedStyle(e).borderTopWidth), '0px');
      await page.screenshot({ path: join(out, `${width}-notice-accent-${change ? 'change' : 'keep'}.png`), fullPage: true });
      screenshots.push(`${width}-notice-accent-${change ? 'change' : 'keep'}.png`);
      await page.locator(change ? '#ai-notice-change' : '#ai-notice-keep').click();
      if (change) { await page.locator('#su-cloud-consent').waitFor(); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog.setup-ui')), true); await page.keyboard.press('Escape'); }
      await page.locator('#ai-cloud-notice').waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-system');
    });
    await run('5-forced-off', {}, async (page, _pi, app) => {
      await page.goto(app.url); await page.locator('#open-system').click(); await page.locator('.settings-nav [data-section="cloud"]').click();
      assert.equal(await page.locator('#cloud').innerText(), 'Off for this start (MEETING_CLOUD=0).'); assert.equal(await page.locator('#settings-ai-change').isVisible(), false);
    }, {}, true);
    await run('5-missing-local-warning', { localMainModel: 'ollama/vanished' }, async (page, _pi, app) => {
      await page.goto(app.url + '/setup'); const row = page.locator('[data-setup-row="ai"]'); await row.getByRole('button', { name: 'Change', exact: true }).waitFor();
      assert.match(await row.innerText(), /no longer listed/); assert.equal(await row.locator('.su-icon circle').first().getAttribute('fill'), '#B45309');
    });
    await run('6-glossary-ai-wording', {}, async (page, _pi, app) => {
      await page.goto(app.url);
      await until(async () => (await page.locator('#build-glossary-note').textContent())?.includes('models') ?? false, 2000);
      assert.equal(await page.locator('#build-glossary-note').textContent(), 'Needs AI models (they are off).');
    });
    await run('6-mockup-and-select-tab-trap', {}, async (page, pi, app) => {
      await open(page, app.url);
      assert.equal(await page.locator('.su-ai-modes').evaluate(e => getComputedStyle(e).display), 'grid');
      assert.equal(await page.locator('label[for="su-ai-main"] strong').innerText(), 'Main model');
      assert.equal(await page.locator('label[for="su-ai-quick"] strong').innerText(), 'Quick model');
      assert.equal(await page.locator('label[for="su-ai-quick"] .su-muted').innerText(), ' · the Board, corrections');
      await page.getByRole('button', { name: 'Save', exact: true }).evaluate((e: HTMLButtonElement) => { e.disabled = true; });
      await page.getByRole('button', { name: 'Close', exact: true }).focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'su-ai-quick');
      await pi.configure({ table: table(rows.slice(1)) }); await page.getByRole('radio', { name: 'Off', exact: true }).click(); await page.getByRole('radio', { name: 'On this Mac', exact: true }).click();
      const retry = page.getByRole('button', { name: 'Check again', exact: true }); await retry.waitFor();
      const small = await retry.evaluate(e => e.getBoundingClientRect().width < e.parentElement!.getBoundingClientRect().width - 20); assert.equal(small, true);
    });
  }
  await writeFile(join(out, 'report.json'), JSON.stringify({ results, screenshots }, null, 2));
  for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
  assert.equal(results.filter(result => !result.pass).length, 0, 'Fix2 browser regressions failed; see report.json.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const browser = await chromium.launch();
  try { await checkFix2(browser, resolve(process.argv[2] ?? 'artifacts/ai-mode-fix2')); } finally { await browser.close(); }
}
