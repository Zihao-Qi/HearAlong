// Usage: MEETING_TEST_CHROME=<bundled headless shell> node --experimental-strip-types scripts/pane-head-check.ts [outDir]
// All data is fictional, in a disposable store. No cloud calls or user browser/profile.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
const out = resolve(process.argv[2] ?? 'artifacts/pane-head-check');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'pane-head-check-'));
const quote = 'Check the supplier quote before shipping the display labels on Friday.';
const notes = async () => ({ model: 'scripted', text: JSON.stringify({ title: 'Label shipment',
  summary: [{ text: quote, cites: ['S1'], quote }], decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [] }) });
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, notes, actions: null, board: null });
let browser: Browser | undefined;
const screenshots: string[] = [], errors: string[] = [], measurements: Record<string, unknown> = {};
try {
  const meeting = app.store.createMeeting('Label shipment');
  const chunk = await app.store.addPcm(meeting.id, 'mic:test', 0, 0, 16000, Buffer.alloc(64000));
  app.store.completeChunk(chunk.id, { text: quote, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  const segment = app.store.visibleSegments(meeting.id)[0];
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${app.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  };
  await call(`/api/meetings/${meeting.id}/notes`, {});
  for (let i = 0; i < 100 && !(await call(`/api/meetings/${meeting.id}/notes`)).notes; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok((await call(`/api/meetings/${meeting.id}/notes`)).notes);
  assert.ok(process.env.MEETING_TEST_CHROME, 'Explicit bundled headless browser required');
  browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
  const card = (n: number) => ({ id: `fixture-${n}`, type: 'decision', text: `Shipment decision ${n}`, confidence: 'high', materials: false,
    nonProject: false, firstMs: 0, createdAt: n, dismissed: false, attempts: [], occurrences: [{ scanId: `scan-${n}`, quote,
      matched: 'corrected', publishedAt: n, glossaryVersion: null, lines: [{ id: segment.id, revision: 0, startMs: 0, endMs: 2000, text: quote }] }] });
  const shot = async (page: Page, name: string) => { const path = join(out, `${name}.png`); await page.screenshot({ path }); screenshots.push(path); };
  // A meeting's first board snapshot is a baseline, even when selected or reloaded off-screen.
  const other = app.store.createMeeting('Supplier check-in');
  for (const width of [1280, 390]) for (const kind of ['notes', 'plans']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(({ id, kind }) => {
        if (!sessionStorage.getItem('initial-snapshot-seeded')) {
          localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', kind); localStorage.setItem('compact-tab', kind);
          sessionStorage.setItem('initial-snapshot-seeded', 'yes');
        }
      }, { id: other.id, kind });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      const cards = Array.from({ length: 22 }, (_, i) => card(1001 + i));
      let targetPolls = 0, next = 1023;
      await page.route('**/api/meetings/*/board', async route => {
        const response = await route.fetch(); const data = await response.json();
        const target = new URL(route.request().url()).pathname === `/api/meetings/${meeting.id}/board`;
        if (target) targetPolls++;
        await route.fulfill({ json: { ...data, cards: target ? cards : [] } });
      });
      await page.goto(`${app.url}/?plans-fixture=plans`);
      const prefix = width < 900 ? 'ctab' : 'tab';
      const badge = width < 900 ? 'compact-badge' : 'board-badge';
      await page.locator(`#${prefix}-${kind}`).click();
      await page.locator('#meeting-button').click();
      await page.locator('#meeting-list [role="menuitemradio"]').filter({ hasText: 'Label shipment' }).click();
      for (const phase of ['selected', 'reloaded']) {
        if (phase === 'reloaded') await page.reload();
        await page.locator('[data-card="fixture-1001"]').waitFor({ state: 'attached' });
        assert.equal(await page.locator(`#${prefix}-${kind}`).getAttribute('aria-selected'), 'true');
        const name = `${width}-${kind}-${phase}`;
        await shot(page, `${name}-baseline`);
        assert.equal(await page.locator(`#${badge}`).isVisible(), false, `${name}: existing cards in the first snapshot are not arrivals`);
        const polled = targetPolls;
        await page.waitForTimeout(3200);
        assert.ok(targetPolls > polled, `${name}: a subsequent board poll completed`);
        assert.equal(await page.locator(`#${badge}`).isVisible(), false, `${name}: polling must not badge baseline cards`);
        cards.push(card(next++), card(next++));
        await page.waitForFunction(id => document.getElementById(id)!.textContent === '+2' && !document.getElementById(id)!.hidden, badge);
        await shot(page, `${name}-plus2`);
        console.log(`PASS ${name}: initial snapshot and next poll have no badge; two later cards give +2`);
      }
    } finally { await context.close(); }
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addInitScript(({ id }) => {
        if (!sessionStorage.getItem('pane-head-seeded')) {
          localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'board'); localStorage.setItem('compact-tab', 'board');
          localStorage.setItem('board-width', '400'); sessionStorage.setItem('pane-head-seeded', 'yes');
        }
      }, { id: meeting.id });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      console.log(`Checking ${width}`);
      page.on('pageerror', error => errors.push(error.message));
      let cards = [card(1)];
      await page.route('**/api/meetings/*/board', async route => {
        const response = await route.fetch(); const data = await response.json();
        await route.fulfill({ json: { ...data, cards } });
      });
      await page.goto(`${app.url}/?plans-fixture=plans`);
      const prefix = width < 900 ? 'ctab' : 'tab';
      const badge = width < 900 ? 'compact-badge' : 'board-badge';
      const tab = (id: string) => page.locator(`#${prefix}-${id}`);
      const rects = () => page.evaluate(prefix => ['notes', 'plans'].map(id => {
        const r = document.getElementById(`${prefix}-${id}`)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      }), prefix);
      await page.locator('[data-card="fixture-1"]').waitFor();
      cards.push(card(2));
      await page.locator('[data-card="fixture-2"].unread').waitFor();
      await shot(page, `${width}-board-dotted`);
      await tab('notes').click(); await page.locator('#notes-body .notes-summary > .note-sentence').first().waitFor();
      assert.equal(await page.locator(`#${badge}`).isVisible(), false, 'leaving dotted Board does not count old dots');
      await page.waitForTimeout(3200);
      assert.equal(await page.locator(`#${badge}`).isVisible(), false, 'poll does not turn old dots into arrivals');
      const before = await rects();
      await shot(page, `${width}-notes-no-badge`);
      cards.push(card(3), card(4), card(5));
      await page.waitForFunction(id => document.getElementById(id)!.textContent === '+3' && !document.getElementById(id)!.hidden, badge);
      const after = await rects();
      assert.deepEqual(after, before, 'Notes and Plans rectangles unchanged when badge appears');
      measurements[`${width}-badge-rectangles`] = { before, after };
      await shot(page, `${width}-notes-plus3`);
      // Mask just the DOM badge, then switch synchronously in the same JS turn: no polling can help.
      assert.deepEqual(await page.evaluate(({ badge, prefix }) => {
        document.getElementById(badge)!.hidden = true;
        document.getElementById(`${prefix}-plans`)!.click();
        const b = document.getElementById(badge)!; return { hidden: b.hidden, text: b.textContent };
      }, { badge, prefix }), { hidden: false, text: '+3' }, 'every tab switch updates badge synchronously');
      assert.equal(await page.evaluate(({ badge, prefix }) => {
        document.getElementById(`${prefix}-board`)!.click(); return document.getElementById(badge)!.hidden;
      }, { badge, prefix }), true, 'showing Board clears count synchronously');
      await tab('notes').click(); assert.equal(await page.locator(`#${badge}`).isVisible(), false);
      await shot(page, `${width}-notes-cleared`);
      const before22 = await rects();
      cards.push(...Array.from({ length: 22 }, (_, i) => card(6 + i)));
      await page.waitForFunction(id => document.getElementById(id)!.textContent === '+22' && !document.getElementById(id)!.hidden, badge);
      assert.deepEqual(await rects(), before22, 'a two-digit count also leaves tab rectangles unchanged');
      const badgeStyle = await page.locator(`#${badge}`).evaluate(node => {
        const style = getComputedStyle(node); return { top: style.top, right: style.right };
      });
      assert.deepEqual(badgeStyle, width < 900 ? { top: '0px', right: '2px' } : { top: '2px', right: '0px' });
      measurements[`${width}-plus22-badge`] = badgeStyle;
      await shot(page, `${width}-notes-plus22`);
      await tab('board').click(); await tab('notes').click();
      for (const kind of ['notes', 'plans']) {
        await tab(kind).click();
        const option = page.locator(kind === 'notes' ? '#notes-options' : '[data-focus="options"]');
        await option.waitFor();
        const menu = page.locator(`#${kind}-menu`);
        const geometry = await option.evaluate((node, kind) => {
          const r = node.getBoundingClientRect(); const tabs = document.querySelector('.board-pane .tabs')!.getBoundingClientRect();
          const bar = document.querySelector(kind === 'notes' ? '.notes-bar' : '.plans-head')?.getBoundingClientRect() ?? { height: 0 };
          const body = document.querySelector(kind === 'notes' ? '#notes-body' : '.plans-card')!.getBoundingClientRect();
          const panel = document.getElementById(`${kind}-panel`)!.getBoundingClientRect();
          return { inHead: Boolean(node.closest('.board-pane .pane-head')), barHeight: bar.height, contentTop: body.top - panel.top,
            centreDelta: Math.abs(r.y + r.height / 2 - tabs.y - tabs.height / 2), height: r.height };
        }, kind);
        measurements[`${width}-${kind}-tool`] = geometry;
        assert.equal(geometry.inHead, width >= 900);
        assert.ok(geometry.height >= 44);
        if (width >= 900) { assert.ok(geometry.centreDelta <= 2, `${width}-${kind}: ${JSON.stringify(geometry)}`); assert.equal(geometry.barHeight, 0); assert.ok(geometry.contentTop <= 4); }
        await shot(page, `${width}-${kind}-options`);
        // Mouse, keyboard traversal, Escape and focus return; both menu placements share the same behavior.
        await option.click(); assert.equal(await menu.isVisible(), true);
        assert.equal(await option.getAttribute('aria-expanded'), 'true');
        assert.equal(await option.getAttribute('aria-controls'), `${kind}-menu`);
        assert.equal(await menu.locator('[role="menuitem"]').first().evaluate(n => n === document.activeElement), true);
        await page.keyboard.press('ArrowDown');
        assert.equal(await menu.locator('[role="menuitem"]').nth(1).evaluate(n => n === document.activeElement), true);
        await page.keyboard.press('Escape'); assert.equal(await menu.isVisible(), false);
        assert.equal(await option.evaluate(n => n === document.activeElement), true);
        await page.keyboard.press('ArrowUp'); assert.equal(await menu.isVisible(), true);
        assert.equal(await menu.locator('[role="menuitem"]').last().evaluate(n => n === document.activeElement), true);
        await page.keyboard.press('Home'); await page.keyboard.press('End');
        assert.equal(await menu.locator('[role="menuitem"]').last().evaluate(n => n === document.activeElement), true);
        const menuBounds = (await menu.boundingBox())!, optionBounds = (await option.boundingBox())!;
        assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width && menuBounds.y >= optionBounds.y + optionBounds.height, `${width}-${kind}: ${JSON.stringify({ menuBounds, optionBounds })}`);
        await shot(page, `${width}-${kind}-menu`);
        await page.mouse.click(5, 5); assert.equal(await menu.isVisible(), false);
        await option.click(); await page.locator('#meeting-button').focus(); assert.equal(await menu.isVisible(), false);
        assert.equal(await option.getAttribute('aria-expanded'), 'false');
      }
      // Both stale links still open the one relocated menu, including focus return.
      const staleChunk = await app.store.addPcm(meeting.id, 'mic:test', width, 10000 + width, 16000, Buffer.alloc(64000));
      app.store.completeChunk(staleChunk.id, { text: 'The supplier sent an updated quote.', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
      await tab('notes').click(); await page.locator('#notes-stale').waitFor();
      await page.locator('#notes-stale').click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#notes-stale').evaluate(n => n === document.activeElement), true);
      await shot(page, `${width}-notes-stale`);
      await page.goto(`${app.url}/?plans-fixture=stale`); await tab('plans').click(); await page.locator('.plans-stale').waitFor();
      await page.locator('.plans-stale').click(); assert.equal(await page.locator('#plans-menu').isVisible(), true);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.plans-stale').evaluate(n => n === document.activeElement), true);
      await shot(page, `${width}-plans-stale`);
      // Resize with the menu open: only one live Options/menu instance survives the move.
      await page.locator('[data-focus="options"]').click();
      await page.setViewportSize({ width: width === 1280 ? 390 : 1280, height: 900 });
      await page.waitForTimeout(150);
      console.log(`${width}: resized`);
      await page.locator(`#${width === 1280 ? 'ctab' : 'tab'}-plans`).click();
      assert.equal(await page.locator('[data-focus="options"]').count(), 1);
      assert.equal(await page.locator('#plans-menu').count(), 0);
      await page.locator('[data-focus="options"]').click(); assert.equal(await page.locator('#plans-menu').isVisible(), true);
      await page.keyboard.press('Escape');
      if (width === 1280) {
        console.log('Checking 380px pane');
        await call('/api/projects', { name: 'Display labels', repoPath: null, fromMeetingId: meeting.id });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator('#tab-project').waitFor();
        await page.locator('#divider').focus(); await page.keyboard.press('Home');
        // Home is the narrow limit; the project's fourth tab may put tools on a second row.
        for (const kind of ['board', 'notes', 'plans', 'project']) {
          await page.locator(`#tab-${kind}`).click();
          const layout = await page.evaluate(() => {
            const pane = document.getElementById('board-pane')!.getBoundingClientRect();
            const controls = [...document.querySelectorAll('.board-pane .pane-head [role="tab"], .board-pane .pane-head .options-button, .board-pane .pane-head .sort-toggle')]
              .filter(n => n.getClientRects().length).map(n => { const r = n.getBoundingClientRect(); return { id: n.id || n.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
            return { pane: { left: pane.left, right: pane.right, width: pane.width }, controls };
          });
          assert.equal(layout.pane.width, 380);
          assert.equal(await page.locator('#tab-project').isVisible(), true);
          for (const a of layout.controls) {
            assert.ok(a.left >= layout.pane.left && a.right <= layout.pane.right, `${a.id} stays in pane`);
            for (const b of layout.controls) if (a !== b) assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${a.id} and ${b.id} do not overlap`);
          }
          // Project and Board badges are also removed from layout flow.
          const before = await rects();
          await page.evaluate(() => { for (const id of ['board-badge', 'project-badge']) { const n = document.getElementById(id)!; n.textContent = '+22'; n.hidden = false; } });
          assert.deepEqual(await rects(), before);
          measurements[`380-${kind}`] = layout;
          await shot(page, `380-${kind}-project-visible`);
        }
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'pane-head-measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(join(out, 'screenshots.txt'), screenshots.join('\n') + '\n');
  console.log(`PASS pane head: wide/compact badge geometry and arrival counts; synchronous tab updates; tool positions; mouse/keyboard/outside/focus/stale/resize menu behavior; 380px Project-tab wrapping. ${screenshots.length} screenshots.`);
} finally {
  console.log('Closing check browser and server');
  await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
