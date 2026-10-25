// Real reveal endpoint and periodic page refreshes, with fictional card/material snapshots and no model calls.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { testBrowser } from './test-browser.ts';

const out = resolve(process.argv[2] ?? 'artifacts/board-focus');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'board-focus-'));
const app = await startServer({ directory, port: 0, publicRoot: process.env.BOARD_FOCUS_PUBLIC_ROOT, setup: await dashboardSetup(directory, true), quick: null, heavy: null, recognizer: null, drafts: null, board: null });
const meeting = app.store.createMeeting('Fictional seed library');
const card = { id: 'fictional-card', type: 'action', text: 'Pack twelve marigold envelopes.', confidence: 'high', materials: false, nonProject: false, firstMs: 0, createdAt: 0,
  occurrences: [{ lines: [{ id: 'fictional-line', startMs: 0 }], quote: 'Pack twelve marigold envelopes.' }], dismissed: false, attempts: [] };
const results: string[] = [];
const check = (name: string, ok: boolean) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
  const context = await browser.newContext();
  await context.addInitScript(id => {
    localStorage.setItem('meeting-id', id);
    const counts: Record<string, number> = {};
    (window as unknown as { refreshCounts: typeof counts }).refreshCounts = counts;
    const replace = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...nodes) {
      replace.apply(this, nodes);
      if (this.id) counts[this.id] = (counts[this.id] ?? 0) + 1;
    };
  }, meeting.id);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let revision = 0, showCard = true;
  await page.route('**/api/meetings/*/board', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), cards: showCard ? [{ ...card, text: card.text + (revision ? ` Revision ${revision}.` : '') }] : [] } });
  });
  await page.route(`**/api/meetings/${meeting.id}`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), materials: [{ id: 'fictional-material', label: 'Seed inventory', kind: 'file', scope: `meeting:${meeting.id}` }] } });
  });
  const twoRefreshes = async (container = 'board-cards') => {
    const before = await page.evaluate(id => (window as unknown as { refreshCounts: Record<string, number> }).refreshCounts[id] ?? 0, container);
    await page.waitForFunction(({ id, before }) => ((window as unknown as { refreshCounts: Record<string, number> }).refreshCounts[id] ?? 0) >= before + 2,
      { id: container, before }, { timeout: 15_000 });
  };
  await page.goto(app.url);
  await page.locator('[data-card="fictional-card"]').waitFor({ state: 'attached' });
  const mini = await context.newPage();
  await mini.route('**/api/live*', route => new URL(route.request().url()).pathname !== '/api/live' ? route.fallback() : route.fulfill({ json: {
    recording: { meetingId: meeting.id, session: 1, clockMs: 0, paragraphs: [], paragraphsFrom: 0, paragraphsTag: '', notices: [], pending: [], drafts: [], card }, mini: { native: false, state: 'open' },
  } }));
  await mini.goto(`${app.url}/mini.html`);
  const posted = mini.waitForResponse(r => r.url().endsWith('/api/live/reveal'));
  await mini.locator('.card:not([hidden])').click();
  assert.equal((await posted).status(), 200, 'the mini view uses the real reveal endpoint');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-card') === 'fictional-card', null, { timeout: 5000 });
  revision++;
  await twoRefreshes();
  check('mini reveal: card keeps focus across two Board refreshes', await page.evaluate(() => document.activeElement?.getAttribute('data-card') === 'fictional-card'));

  await page.bringToFront();
  // Start at the revealed card, then Tab to its first button, as a keyboard user would.
  await page.locator('[data-card="fictional-card"]').evaluate(card => { (card as HTMLElement).tabIndex = -1; (card as HTMLElement).focus(); });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'cite card-time');
  revision++; // Also rebuild the card, not just detach/reinsert its existing node.
  await twoRefreshes();
  check('card button keeps focus across two Board refreshes (including replacement)', await page.evaluate(() => document.activeElement?.className === 'cite card-time'));

  await page.getByRole('button', { name: 'Ask about this', exact: true }).click();
  const field = page.locator('[data-key="ask-fictional-card"]');
  await field.fill('Twelve fictional envelopes');
  await field.evaluate(input => (input as HTMLInputElement).setSelectionRange(3, 9));
  revision++;
  await twoRefreshes();
  const fieldState = await field.evaluate(input => ({ focused: document.activeElement === input, value: (input as HTMLInputElement).value,
    start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd, hidden: input.closest('form')!.hidden, active: document.activeElement?.tagName }));
  console.log('field after refreshes:', JSON.stringify(fieldState));
  check('card field keeps focus, value and caret across two Board refreshes', fieldState.focused && fieldState.value === 'Twelve fictional envelopes' && fieldState.start === 3 && fieldState.end === 9);

  await page.locator('#tab-notes').click();
  await twoRefreshes();
  check('clicking elsewhere: Board refresh never pulls focus back', await page.evaluate(() => document.activeElement?.id === 'tab-notes'));
  await page.locator('#meeting-button').click();
  const meetingItem = page.locator('#meeting-list button').first();
  await meetingItem.focus();
  await twoRefreshes('meeting-list');
  check('meeting menu item keeps focus across two status refreshes', await meetingItem.evaluate(item => document.activeElement === item));
  await page.keyboard.press('Escape');

  await page.locator('#open-meeting').click();
  await page.locator('#materials button').first().focus();
  await twoRefreshes('materials');
  check('material Remove button keeps focus across two detail refreshes', await page.locator('#materials button').first().evaluate(button => document.activeElement === button));

  // A removed card is not a reason to send focus to a different card or control.
  await page.locator('#close-settings').click();
  await page.locator('#tab-board').click();
  await page.locator('[data-card="fictional-card"] .card-time').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'cite card-time');
  showCard = false;
  await twoRefreshes();
  check('removed card: no replacement focus is invented', await page.evaluate(() => document.activeElement === document.body));
  // Exercise the exact served helpers with colliding timestamps, as the memory views render them.
  const source = await (await fetch(`${app.url}/app.js`)).text();
  const shared = await (await fetch(`${app.url}/live-shared.js`)).text();
  const slice = (text: string, from: string, until: string) => {
    const start = text.indexOf(from), end = text.indexOf(until, start);
    assert.ok(start >= 0 && end > start, `fixture function boundary: ${from}`);
    return text.slice(start, end);
  };
  const probe = await context.newPage();
  await probe.setContent('<div id="ok-rows"></div><div id="memory-lists"></div>');
  await probe.addScriptTag({ content: slice(source, 'function rememberFocus(container)', 'const focusKey =')
    + slice(source, 'function el(tag, text, className)', '\n}') + '\n}'
    + slice(shared, 'export function stamp(ms)', '\n}').replace('export ', '') + '\n}'
    + '\nlet meetingId = "fictional-meeting", status = null, jumps = []; const scrollToSegment = (_owner, id) => jumps.push(id);\n'
    + slice(source, 'function sourceLine(p)', '\n/**') + slice(source, 'function eventSource(event)', '\nfunction timelineList')
    + `
window.focusFixture = {
  rebuild(container, builder) {
    jumps = [];
    const root = document.getElementById(container);
    const build = (id, startMs) => {
      const row = document.createElement('div'); row.dataset.row = id;
      row.append(window[builder]({ source: { kind: 'meeting', meetingId, lines: [{ id, startMs }] } }));
      return row;
    };
    root.replaceChildren(build('fictional-line-A', 100), build('fictional-line-B', 600));
    root.querySelector('button').focus();
    keepFocus(root, () => root.replaceChildren(build('fictional-line-B', 600)));
  },
  state() { return { focusedRow: document.activeElement.closest('[data-row]')?.dataset.row ?? null, activated: [...jumps] }; },
};` });
  type Fixture = { rebuild(container: string, builder: string): void; state(): { focusedRow: string | null; activated: string[] } };
  for (const [container, builder] of [['ok-rows', 'sourceLine'], ['memory-lists', 'eventSource']]) {
    await probe.evaluate(({ container, builder }) => (window as unknown as { focusFixture: Fixture }).focusFixture.rebuild(container, builder), { container, builder });
    const focused = await probe.evaluate(() => (window as unknown as { focusFixture: Fixture }).focusFixture.state());
    check(`${container}: removing a row never focuses its identical timestamp neighbour`, focused.focusedRow !== 'fictional-line-B');
    await probe.keyboard.press('Enter');
    const activated = await probe.evaluate(() => (window as unknown as { focusFixture: Fixture }).focusFixture.state());
    console.log('timestamp removal:', JSON.stringify({ container, ...activated }));
    check(`${container}: Enter after removal never activates the neighbour`, activated.activated.length === 0);
  }
  await probe.close();
  check('no page errors', errors.length === 0);
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
  console.log(results.join('\n'));
  await writeFile(join(out, 'results.txt'), results.join('\n') + '\n');
}
if (results.some(result => result.startsWith('FAIL'))) process.exitCode = 1;
