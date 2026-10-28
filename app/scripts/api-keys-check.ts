// Usage: MEETING_TEST_CHROME=<disposable Chromium> node --experimental-strip-types scripts/api-keys-check.ts [outDir]
// Own API keys in the AI models dialog, end to end in a headless browser: a fake Pi, a fake `security` (no Keychain) and fake
// provider model lists on 127.0.0.1. Fictional keys and data only; no model calls.
import './check-env.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { fakePi, table, until } from '../test/helpers/setup-pi.ts';
import { fakeProviders, fakeSecurity } from '../test/helpers/api-keys.ts';

const out = resolve(process.argv[2] ?? 'artifacts/api-keys-check'); await mkdir(out, { recursive: true });
const cleanups: (() => unknown)[] = [], shots: string[] = [], checks: string[] = [], errors: string[] = [];
const owner = { after(fn: () => unknown) { cleanups.push(fn); } };
const GOOD = 'AIza-fictional-browser-key-7781', BAD = 'AIza-fictional-wrong-key-0000';
const SUBSCRIPTION = table(['openai-codex gpt-6.1-sol 272K 128K yes yes', 'openai-codex gpt-6-luna 272K 128K yes no']);
const GOOGLE = { google: ['google gemini-fictional-pro 1M 64K yes yes', 'google gemini-fictional-flash 1M 64K yes yes'] };
const SIGNED_OUT = 'No models available. Use /login to log into a provider.';
const pi = await fakePi(owner, { table: SIGNED_OUT, keyRows: GOOGLE, stored: [] });
const security = await fakeSecurity(owner), providers = await fakeProviders(owner, { google: GOOD });
Object.assign(pi.env, providers.env);
Object.assign(process.env, pi.env, security.env);
const directory = await mkdtemp(join(tmpdir(), 'api-keys-check-'));
await writeFile(join(directory, 'settings.json'), JSON.stringify({ setupSeen: true, aiMode: 'cloud' }));
const logs: string[] = [];
for (const name of ['log', 'warn', 'error'] as const) { const original = console[name]; console[name] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); original(...args); }; }
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, actions: null, board: null,
  ai: { env: pi.env }, setup: { scan: { home: join(directory, 'home'), envModelPath: null, hfHome: null }, ffmpeg: async () => ({ found: true }) } });
const browser = await chromium.launch();
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); shots.push(`${name}.png`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
}
const settings = async () => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
const height = async (locator: import('playwright-core').Locator) => (await locator.boundingBox())!.height;
/** The line's label fits on one line beside its buttons. */
const oneLine = (locator: import('playwright-core').Locator) => locator.evaluate(element => {
  const style = getComputedStyle(element); return element.getBoundingClientRect().height <= parseFloat(style.lineHeight === 'normal' ? '20' : style.lineHeight) * 1.5;
});
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const dialog = page.locator('dialog.setup-ui'), keyLine = dialog.locator('.su-key-line').filter({ hasText: /own API key:/ });
    const input = dialog.locator('#su-key-input'), count = dialog.locator('.su-count');
    const open = async () => {
      await page.goto(`${app.url}/setup`);
      const row = page.locator('[data-setup-row="ai"]');
      await row.getByRole('button', { name: /^(Change|Choose models)$/ }).first().waitFor();
      await row.getByRole('button', { name: /^(Change|Choose models)$/ }).first().click();
      await dialog.locator('.su-keys').waitFor();
    };
    if (width === 1280) {
      // Signed out: the row says a key is the other way in, and the dialog can add one.
      await page.goto(`${app.url}/setup`);
      const row = page.locator('[data-setup-row="ai"]');
      await row.getByText('Sign in with Pi in Terminal, then type /login — or add an API key with Choose models').waitFor();
      await row.getByRole('button', { name: 'Choose models' }).click(); await dialog.locator('.su-keys').waitFor();
      // Nothing is signed in: the line is the other way in, fits beside three buttons, and the error points to it.
      await keyLine.waitFor();
      assert.equal(await keyLine.locator('.su-key-text').textContent(), 'Or use your own API key:');
      assert.deepEqual(await keyLine.locator('button').allTextContents(), ['Gemini', 'OpenAI', 'Anthropic']);
      assert.ok(await oneLine(keyLine.locator('.su-key-text')), 'the line wraps beside three buttons');
      await dialog.getByText('Pi isn’t signed in. Run pi, then /login — or add a key above.', { exact: true }).waitFor();
      for (const b of await keyLine.locator('button').all()) assert.ok(await height(b) >= 44, 'provider buttons are 44 px');
      await shot(page, `${width}-signed-out`);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      await pi.configure({ table: SIGNED_OUT, keyRows: GOOGLE, stored: ['anthropic'] });
      await row.getByRole('button', { name: 'Choose models' }).click(); await dialog.locator('.su-keys').waitFor();
      pass('signed-out row and line offer the key, without contradicting the error');
    } else {
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: ['anthropic'] });
      await open();
    }
    await keyLine.getByRole('button', { name: 'Add a Gemini API key' }).waitFor();
    assert.deepEqual(await keyLine.locator('button').allTextContents(), ['Gemini', 'OpenAI']);
    await dialog.getByText('Anthropic · signed in through Pi', { exact: true }).waitFor();
    await shot(page, `${width}-keys-line`); pass(`${width}: one button per provider without a credential; Pi's own sign-in shown muted`);
    // Keyboard: Tab between the buttons, Enter opens the form with focus in the key field, Escape leaves only the form.
    await keyLine.getByRole('button', { name: 'Add a Gemini API key' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Add an OpenAI API key');
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
    await until(() => input.evaluate(element => element === document.activeElement));
    const label = (await dialog.locator('label[for="su-key-input"]').textContent())!;
    assert.equal(label, 'Gemini API key · from aistudio.google.com/apikey');
    assert.equal(await dialog.locator('.su-key-form a').getAttribute('href'), 'https://aistudio.google.com/apikey');
    await dialog.getByText('Google bills you per use. The key stays in this Mac’s Keychain. On Google’s free tier, Google may use what you send to improve its products.', { exact: true }).waitFor();
    assert.equal(await input.getAttribute('type'), 'password');
    assert.equal(await keyLine.count(), 0);
    assert.ok(await height(dialog.locator('.su-key-form').getByRole('button', { name: 'Cancel' })) >= 44, 'Cancel is 44 px');
    await shot(page, `${width}-form`);
    await page.keyboard.press('Escape');
    await until(async () => await input.count() === 0 && await dialog.isVisible());
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key-add')), 'google');
    pass(`${width}: keyboard opens the form, Escape closes only the form and returns focus`);

    // Rejected, then unreachable: nothing saved, the typed key stays for correction.
    await page.keyboard.press('Enter'); await input.fill(BAD);
    providers.state.delayMs = 1200; await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Checking…' }).waitFor();
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    // Escape while checking leaves everything as it is: the form stays and keeps checking.
    await page.keyboard.press('Escape');
    assert.ok(await dialog.isVisible() && await input.count() === 1 && await dialog.getByRole('button', { name: 'Checking…' }).count() === 1, 'Escape while checking closed something');
    await shot(page, `${width}-checking`);
    await dialog.getByText('Google didn’t accept this key. Check it and try again.', { exact: true }).waitFor();
    providers.state.delayMs = 0;
    assert.equal(await input.getAttribute('aria-invalid'), 'true'); assert.equal(await input.inputValue(), BAD);
    assert.equal(await dialog.getByRole('button', { name: 'Save key' }).isDisabled(), false, 'Save key stays usable after a rejection');
    await shot(page, `${width}-rejected`);
    pi.env.MEETING_GOOGLE_API_BASE = 'http://127.0.0.1:9/google';
    await input.fill(GOOD); assert.equal(await input.getAttribute('aria-invalid'), 'false');
    await dialog.getByRole('button', { name: 'Save key' }).click();
    await dialog.getByText('Couldn’t reach Google. Check the connection.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Save key' }).isDisabled(), false, 'Save key stays usable after a connection failure');
    await shot(page, `${width}-unreachable`);
    pi.env.MEETING_GOOGLE_API_BASE = providers.env.MEETING_GOOGLE_API_BASE;
    assert.deepEqual(await security.store(), {}); assert.deepEqual((await settings()).apiKeys ?? [], []);
    pass(`${width}: rejected and unreachable keys are not saved and say why`);

    // A good key: the line, the count and the model list change in the same dialog.
    const before = (await count.textContent())!;
    // Retry with the mouse; Close and the backdrop wait while the key is checked, so nothing is saved unseen.
    providers.state.delayMs = 1200;
    await dialog.getByRole('button', { name: 'Save key' }).click();
    await dialog.getByRole('button', { name: 'Checking…' }).waitFor();
    assert.equal(await dialog.locator('.su-close').isDisabled(), true, 'Close waits while checking');
    await page.mouse.click(3, 3); await page.keyboard.press('Escape');
    assert.ok(await dialog.isVisible(), 'the dialog closed while checking');
    providers.state.delayMs = 0;
    const saved = dialog.locator('.su-key-line').filter({ hasText: 'Gemini · 2 models · key ending 7781' });
    await saved.waitFor();
    assert.equal(await dialog.locator('.su-close').isDisabled(), false);
    assert.ok(await height(saved.getByRole('button', { name: 'Remove the Gemini key' })) >= 44, 'Remove is 44 px');
    assert.notEqual(await count.textContent(), before);
    assert.match((await count.textContent())!, width === 1280 ? /^From Pi · 2 models from 1 provider$/ : /^From Pi · 4 models from 2 providers$/);
    assert.ok((await dialog.locator('datalist option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).includes('google/gemini-fictional-pro'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'su-ai-main');
    assert.deepEqual(await keyLine.locator('button').allTextContents(), ['OpenAI']);
    assert.equal(await dialog.locator('[role="alert"]:visible').count(), 0);
    assert.deepEqual(await security.store(), { 'HearAlong/google': GOOD });
    await shot(page, `${width}-saved`);
    pass(`${width}: a saved key lists its models at once and leaves only the other buttons`);

    // Choose a Gemini model, then remove the key: the choice goes back to the default and the dialog says so for 5 s.
    await dialog.locator('#su-ai-main').fill('google/gemini-fictional-pro');
    if (width === 1280) await dialog.locator('#su-ai-quick').fill('google/gemini-fictional-flash');
    await dialog.locator('#su-cloud-consent').check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await settings()).mainModel, 'google/gemini-fictional-pro');
    await open();
    // One steady, initially empty status node: its text is set and cleared, never re-created.
    const status = await dialog.locator('[role="status"]').elementHandle();
    assert.ok(status, 'no status node'); assert.equal(await status.textContent(), '');
    await dialog.getByRole('button', { name: 'Remove the Gemini key' }).click();
    const noticeText = width === 1280 ? 'Main and Quick models are back to the defaults.' : 'Main model is back to the default.';
    const notice = dialog.getByText(noticeText, { exact: true });
    await notice.waitFor();
    assert.equal(await status.textContent(), noticeText);
    assert.equal(await dialog.locator('#su-ai-main').inputValue(), width === 1280 ? '' : 'openai-codex/gpt-6.1-sol');
    assert.equal(await dialog.locator('.su-key-line').filter({ hasText: 'key ending' }).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key-add')), 'google');
    assert.equal((await settings()).mainModel, null); assert.deepEqual(await security.store(), {});
    await shot(page, `${width}-removed`);
    // Typing a key while the notice clears: focus and keystrokes stay in the field.
    await dialog.getByRole('button', { name: 'Add an OpenAI API key' }).click();
    await page.keyboard.type('sk-fict');
    await until(async () => await status.textContent() === '', 7000);
    await page.keyboard.type('ional');
    assert.equal(await input.inputValue(), 'sk-fictional'); assert.equal(await input.evaluate(element => element === document.activeElement), true);
    assert.equal(await status.evaluate(element => element.isConnected && element === element.closest('dialog')!.querySelector('[role="status"]')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-key-add')), 'openai');
    pass(`${width}: removing resets the provider's chosen models and says so for 5 s, without moving focus`);

    if (width === 1280) {
      // A key saved, then the user signs in through Pi: the line says Pi's sign-in is used; Remove still works.
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: ['anthropic'] });
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      await open();
      await dialog.getByRole('button', { name: 'Add a Gemini API key' }).click(); await input.fill(GOOD); await page.keyboard.press('Enter');
      await dialog.locator('.su-key-line').filter({ hasText: 'key ending 7781' }).waitFor();
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: ['anthropic', 'google'] });
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      await open();
      const shadowed = dialog.locator('.su-key-line').filter({ hasText: 'Gemini · Pi’s own sign-in is used, not this key' });
      await shadowed.waitFor(); assert.equal(await dialog.getByText('bills you per use').count(), 0);
      await shot(page, `${width}-shadowed`);
      await shadowed.getByRole('button', { name: 'Remove the Gemini key' }).click();
      await dialog.getByText('Gemini · signed in through Pi', { exact: true }).waitFor();
      assert.deepEqual(await security.store(), {});
      pass('a key overridden by Pi’s own sign-in says so and can be removed');
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: ['anthropic'] });
      // Signed in through Pi, no provider key yet: the longer label still fits beside three buttons.
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: [] });
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      await open();
      await until(async () => await keyLine.locator('button').count() === 3);
      assert.equal(await keyLine.locator('.su-key-text').textContent(), 'More models with your own API key:');
      assert.ok(await oneLine(keyLine.locator('.su-key-text')), 'the line wraps beside three buttons');
      await shot(page, `${width}-three-buttons`);
      await pi.configure({ table: SUBSCRIPTION, keyRows: GOOGLE, stored: ['anthropic'] });
      pass('both line labels fit beside three buttons at 1280 px');
    }
    await context.close();
  }
  // The key text never reached the data folder or the server's output.
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true })).filter(e => e.isFile())) {
    const text = await readFile(join(entry.parentPath, entry.name)).then(b => b.toString('latin1'));
    assert.ok(!text.includes(GOOD) && !text.includes(BAD), `${entry.name} holds a key`);
  }
  assert.ok(logs.every(line => !line.includes(GOOD) && !line.includes(BAD)), 'a key reached the server output');
  pass('no key in the data folder or the server output');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
  for (const cleanup of cleanups.reverse()) await cleanup();
  await writeFile(join(out, 'summary.txt'), `${checks.map(c => `PASS ${c}`).join('\n')}\n${errors.length ? `Page errors:\n${errors.join('\n')}\n` : ''}Screenshots: ${shots.join(', ')}\n`);
}
console.log(`${checks.length} checks passed. Screenshots in ${out}`);
