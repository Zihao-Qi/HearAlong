// Disposable Chromium, scripted Pi and fictional meetings only. No model calls or non-loopback requests.
import './check-env.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from '../test/helpers/setup-pi.ts';
import { checkFix2 } from './ai-mode-fix2-check.ts';

const out = resolve(process.argv[2] ?? 'artifacts/ai-mode'); await mkdir(out, { recursive: true });
const cleanups: (() => unknown)[] = [], screenshots: string[] = [], errors: string[] = [];
const owner = { after(fn: () => unknown) { cleanups.push(fn); } };
const rows = ['ollama example-local 32K 4K no no', 'example main 32K 4K no no', 'example quick 32K 4K no no', 'other main 32K 4K no no'];
const pi = await fakePi(owner, { table: table(rows) });
const browser = await chromium.launch();
async function appFixture(saved: object) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-mode-check-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ setupSeen: true, mainModel: 'example/main', quickModel: 'example/quick', cloudMainModel: 'example/main', cloudQuickModel: 'example/quick', localMainModel: 'ollama/example-local', localQuickModel: 'ollama/example-local', ...saved }));
  const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null,
    ai: { env: pi.env }, setup: { scan: { home: join(directory, 'home'), hfHome: null, envModelPath: null }, ffmpeg: async () => ({ found: true }) } });
  app.store.createMeeting('Example private meeting');
  return { app, directory, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function shot(page: Page, name: string) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
  assert.equal(await page.locator('dialog.setup-ui').evaluateAll(elements => elements.some(e => e.scrollWidth > e.clientWidth)), false, `${name}: dialog overflow`);
  await page.screenshot({ path: join(out, name + '.png'), fullPage: true }); screenshots.push(name + '.png');
}
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const f = await appFixture({ aiMode: 'local' });
    try {
      await page.goto(f.app.url + '/setup');
      await page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Change', exact: true }).click();
      const dialog = page.locator('dialog.setup-ui'), group = dialog.getByRole('radiogroup');
      await dialog.getByText('✓ Ollama · 1 model on this Mac', { exact: true }).waitFor();
      assert.equal(await dialog.locator('#su-ai-main option').count(), 1);
      await group.getByRole('radio', { name: 'On this Mac', exact: true }).focus();
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'su-ai-main');
      assert.equal(await dialog.locator('#su-ai-main').evaluate(e => getComputedStyle(e).outlineWidth), '2px');
      await shot(page, `${width}-local-found-keyboard`);
      await pi.configure({ table: table(rows.slice(1)) });
      await group.getByRole('radio', { name: 'Off', exact: true }).click();
      await dialog.getByText('No AI. Recording, transcription, listening and exports work as usual; notes, the Board, Explain and plans are unavailable.', { exact: true }).waitFor();
      await shot(page, `${width}-off`);
      await group.getByRole('radio', { name: 'On this Mac', exact: true }).click();
      await dialog.getByText('No model server found on this Mac', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: 'Copy ollama pull qwen3:8b', exact: true }).waitFor();
      await shot(page, `${width}-local-not-found`);
      await pi.configure({ table: table(rows) });
      await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
      await dialog.getByText('✓ Ollama · 1 model on this Mac', { exact: true }).waitFor();
      await group.getByRole('radio', { name: 'On this Mac', exact: true }).focus(); await page.keyboard.press('ArrowRight');
      await dialog.locator('#su-cloud-consent').waitFor();
      assert.equal(await group.getByRole('radio', { name: 'Cloud', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      await shot(page, `${width}-cloud-needs-consent`);
      await dialog.locator('#su-cloud-consent').check();
      assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
      await dialog.locator('#su-ai-main').fill('other/main');
      assert.equal(await dialog.locator('#su-cloud-consent').isChecked(), false);
      await dialog.getByText('What goes to example, other', { exact: true }).waitFor();
      await shot(page, `${width}-cloud-new-provider`);
      await dialog.locator('#su-cloud-consent').check(); await shot(page, `${width}-cloud-consented`);
      await group.getByRole('radio', { name: 'Cloud', exact: true }).focus(); await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Save');
      await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'detached' });
      assert.equal(JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')).aiMode, 'off');
      await page.goto(f.app.url); await page.locator('#open-system').click();
      await page.locator('.settings-nav [data-section="cloud"]').click();
      await page.locator('#settings-ai-change').waitFor();
      assert.equal(await page.locator('#board-model').isVisible(), false);
      await shot(page, `${width}-settings-ai`);
    } finally { await f.close(); }
    for (const change of [false, true]) {
      const notice = await appFixture({ aiMode: 'cloud', cloudNotice: true, cloudConsent: { providers: ['example'], time: 1, legacy: true } });
      try {
        await page.goto(notice.app.url); await page.locator('#ai-cloud-notice').waitFor();
        await shot(page, `${width}-notice-${change ? 'change' : 'keep'}`);
        await page.locator(change ? '#ai-notice-change' : '#ai-notice-keep').click();
        await until(async () => !await page.locator('#ai-cloud-notice').isVisible());
        assert.equal(JSON.parse(await readFile(join(notice.directory, 'settings.json'), 'utf8')).cloudNotice, false);
        if (change) { await page.locator('dialog.setup-ui').waitFor(); await page.keyboard.press('Escape'); }
        await page.reload(); assert.equal(await page.locator('#ai-cloud-notice').isVisible(), false);
      } finally { await notice.close(); }
    }
    await context.close();
  }
  await checkFix2(browser, join(out, 'fix2'));
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'report.json'), JSON.stringify({ screenshots, errors, fix2: 'fix2/report.json' }, null, 2));
  console.log(`PASS AI modes, discovery retry, consent, notice, Settings and keyboard at both widths (${screenshots.length} screenshots)`);
} finally { await browser.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
