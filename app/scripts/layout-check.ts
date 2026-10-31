// Layout validation on a real meeting: wide and compact at every width, the divider at and past its limits, compact tabs.
// Usage: node --experimental-strip-types scripts/layout-check.ts <storeDir> [outDir]
// The store is copied first, so the source is never modified. Cloud models are off.
import { testBrowser } from './test-browser.ts';
import { chromium, type Page } from 'playwright-core';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// The narrowest board pane (public/app.js BOARD_MIN): tabs and the order toggle share one line down to it.
const BOARD_MIN = 380;
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const [source, out = 'artifacts/layouts'] = process.argv.slice(2);
if (!source) throw new Error('Usage: layout-check.ts <storeDir> [outDir]');
const chrome = testBrowser();
const directory = await mkdtemp(join(tmpdir(), 'meeting-layout-'));
await cp(resolve(source), directory, { recursive: true });
await rm(join(directory, 'server.lock'), { force: true });
const outDir = resolve(out);
await mkdir(outDir, { recursive: true });
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, quick: null, heavy: null, notes: null, recognizer: null, drafts: null });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
const SIZES: [number, number][] = [[375, 667], [390, 844], [480, 800], [700, 800], [899, 800], [900, 800], [1024, 800], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];

/** Everything measurable about the current layout, from inside the page. */
const measure = (page: Page) => page.evaluate(() => {
  const rect = (sel: string) => { const n = document.querySelector(sel) as HTMLElement | null; if (!n || !n.offsetParent && getComputedStyle(n).position !== 'fixed') return null; const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
  const doc = document.documentElement;
  // Controls in the bars: none may overflow its own box or leave the viewport.
  // Bar controls and pills: none may overflow its own box, wrap its label onto more lines, or stick out of its pane or the window.
  const controls = '.topbar button, .topbar .chip, .compact-tabs button, #pinned-card, #pinned-card span, .pane-head button, .board-bar button, .board-filter select, .segmented button';
  const overflowing = [...document.querySelectorAll(controls)]
    .filter(n => (n as HTMLElement).offsetParent)
    .filter(n => {
      const e = n as HTMLElement; const r = e.getBoundingClientRect();
      const pane = e.closest('.board-pane, .transcript-pane, .topbar, .compact-tabs') as HTMLElement | null;
      const bounds = pane ? pane.getBoundingClientRect() : { left: 0, right: innerWidth };
      const ellipsis = getComputedStyle(e).textOverflow === 'ellipsis' || e.tagName === 'SELECT';
      const lines = e.matches('button') && !e.matches('#pinned-card') ? r.height > parseFloat(getComputedStyle(e).lineHeight || '20') * 1.9 + parseFloat(getComputedStyle(e).paddingTop) * 2 + 4 : false;
      return (e.scrollWidth > e.clientWidth + 1 && !ellipsis) || lines || r.right > Math.min(innerWidth, bounds.right) + 0.5 || r.left < Math.max(0, bounds.left) - 0.5;
    })
    .map(n => `${(n as HTMLElement).id || (n as HTMLElement).className || n.tagName}${n.textContent ? ` "${n.textContent.trim().slice(0, 20)}"` : ''}`);
  const tabs = [...document.querySelectorAll('.compact-tabs button')].filter(n => (n as HTMLElement).offsetParent).map(n => ({ id: n.id, clipped: (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1 }));
  const para = document.querySelector('.para p') as HTMLElement | null;
  const longLine = para ? para.getBoundingClientRect().width > parseFloat(getComputedStyle(para).maxWidth) + 1 : false;
  return {
    compact: document.body.classList.contains('layout-compact'), tab: document.body.dataset.tab,
    pageScroll: { x: doc.scrollWidth > innerWidth, y: doc.scrollHeight > innerHeight },
    transcript: rect('#transcript-pane'), board: rect('#board-pane'), divider: rect('#divider'), select: rect('#meeting-button'),
    overflowing, tabs, longLine,
  };
});

try {
  // The layout follows the window width (M7 removed the Wide/Compact switch): compact below 900 px.
  for (const choice of ['auto'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(value => { try { localStorage.setItem('layout', value); localStorage.removeItem('board-width'); } catch {} }, choice);
    const page = await context.newPage();
    await page.goto(app.url);
    await page.locator('.para').first().waitFor();
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      const m = await measure(page);
      const where = `${choice} @ ${width}×${height}`;
      const compactExpected = width < 900;
      check(m.compact === compactExpected, `${where}: compact=${m.compact}, expected ${compactExpected}`);
      check(!m.pageScroll.x && !m.pageScroll.y, `${where}: the page itself scrolls (${JSON.stringify(m.pageScroll)})`);
      check(!m.overflowing.length, `${where}: controls overflow: ${m.overflowing.join(', ')}`);
      check(!m.tabs.some(t => t.clipped), `${where}: compact tab text clipped`);
      check(!m.longLine, `${where}: transcript lines longer than 80ch`);
      if (m.compact) {
        check((m.select?.width ?? 0) >= 120, `${where}: meeting name only ${Math.round(m.select?.width ?? 0)} px wide`);
        check(!m.divider, `${where}: divider shown in compact`);
      } else {
        const board = m.board!.width, transcript = m.transcript!.width;
        check(board >= BOARD_MIN - 0.5 && board <= width * 0.5 + 0.5, `${where}: board ${board} px outside ${BOARD_MIN}…50%`);
        check(transcript >= 480 - 0.5, `${where}: transcript only ${transcript} px`);
        check(Math.abs(board - Math.min(400, width * 0.5, width - 488)) <= 1 || board === BOARD_MIN, `${where}: board ${board} px, default 400 expected (clamped)`);
      }
      await page.screenshot({ path: join(outDir, `${choice}-${width}x${height}.png`) });
      // The meeting menu and both side panels, opened at this size: inside the window, nothing else pushed out.
      for (const [opener, target] of [['#meeting-button', '#meeting-menu'], ['#open-meeting', '#settings'], ['#open-system', '#settings']] as const) {
        // On a phone the materials chip is hidden on purpose: Materials is reached through Settings there.
        if (!(await page.locator(opener).isVisible())) { check(opener === '#open-meeting' && width <= 600, `${where} ${opener} is not visible`); continue; }
        await page.locator(opener).click();
        await page.waitForTimeout(100);
        const o = await page.evaluate(sel => {
          const n = document.querySelector(sel) as HTMLElement; const r = n.getBoundingClientRect();
          const close = n.querySelector('[data-close-panel]') as HTMLElement | null; const c = close?.getBoundingClientRect();
          const doc = document.documentElement;
          return { visible: n instanceof HTMLDialogElement ? n.open : !n.hidden, left: r.left, right: r.right, top: r.top, bottom: r.bottom, closeIn: !c || (c.right <= innerWidth && c.left >= 0 && c.bottom <= innerHeight),
            pageScroll: doc.scrollWidth > innerWidth || doc.scrollHeight > innerHeight };
        }, target);
        check(o.visible && o.left >= -0.5 && o.right <= width + 0.5 && o.closeIn && !o.pageScroll, `${where} ${target}: ${JSON.stringify(o)}`);
        if (width === 1280 || width === 390) await page.screenshot({ path: join(outDir, `${choice}-${width}x${height}-${opener.slice(1)}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        check(await page.evaluate(sel => { const n = document.querySelector(sel) as HTMLElement; return n instanceof HTMLDialogElement ? !n.open : n.hidden; }, target), `${where} ${target}: Escape did not close it`);
      }
      if (m.compact) for (const tab of ['board', 'notes', 'plans', 'live'] as const) {
        await page.locator(`#ctab-${tab}`).click();
        await page.waitForTimeout(100);
        const t = await measure(page);
        check(!t.pageScroll.x && !t.pageScroll.y && !t.overflowing.length, `${where} ${tab} tab: ${JSON.stringify({ scroll: t.pageScroll, overflowing: t.overflowing })}`);
        if (tab !== 'live') await page.screenshot({ path: join(outDir, `${choice}-${width}x${height}-${tab}.png`) });
      }
    }
    await context.close();
  }

  // The divider: dragging past both ends, keys, reset, persistence, and clamping on a narrower window that is undone when it widens.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('layout', 'wide'); localStorage.removeItem('board-width'); sessionStorage.setItem('seeded', '1'); } } catch {} });
    const page = await context.newPage();
    await page.goto(app.url);
    await page.locator('.para').first().waitFor();
    const boardWidth = async () => (await measure(page)).board!.width;
    const handle = page.locator('#divider');
    const box = (await handle.boundingBox())!;
    const drag = async (dx: number) => {
      const b = (await handle.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + dx, b.y + b.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    check(Math.round(box.height) > 300, 'divider is not full height');
    await drag(-10_000);
    check(Math.abs(await boardWidth() - 720) <= 1, `drag far left: board ${await boardWidth()} px, expected 720 (50% of 1440)`);
    const afterLeft = await measure(page);
    check(afterLeft.transcript!.width >= 480 && !afterLeft.pageScroll.x, 'drag far left broke the transcript');
    await drag(10_000);
    check(Math.abs(await boardWidth() - BOARD_MIN) <= 1, `drag far right: board ${await boardWidth()} px, expected ${BOARD_MIN}`);
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    check(Math.abs(await boardWidth() - (BOARD_MIN + 16)) <= 1, `ArrowLeft: board ${await boardWidth()} px, expected ${BOARD_MIN + 16}`);
    await page.keyboard.press('End');
    check(Math.abs(await boardWidth() - 720) <= 1, `End: board ${await boardWidth()} px, expected 720`);
    await page.keyboard.press('Home');
    check(Math.abs(await boardWidth() - BOARD_MIN) <= 1, `Home: board ${await boardWidth()} px`);
    await handle.dblclick();
    check(Math.abs(await boardWidth() - 400) <= 1, `double-click reset: board ${await boardWidth()} px`);
    await drag(-300); // 700 px
    const chosen = await boardWidth();
    check(chosen > 650 && chosen <= 720, `drag to ~700: board ${chosen} px`);
    await page.reload(); await page.locator('.para').first().waitFor();
    check(Math.abs(await boardWidth() - chosen) <= 1, `reload kept ${chosen}? got ${await boardWidth()}`);
    check((await page.locator('#divider').getAttribute('aria-valuenow')) === String(Math.round(chosen)), 'aria-valuenow does not match');
    await page.setViewportSize({ width: 1000, height: 900 }); await page.waitForTimeout(150);
    check(Math.abs(await boardWidth() - 500) <= 1, `narrower window: board ${await boardWidth()} px, expected 500 (50%)`);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(150);
    check(Math.abs(await boardWidth() - chosen) <= 1, `widened again: board ${await boardWidth()} px, expected the chosen ${chosen}`);
    // A selection menu must not float detached while the panes move.
    await page.locator('.para p').first().evaluate(p => { const r = document.createRange(); r.selectNodeContents(p.firstElementChild ?? p); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    await page.waitForTimeout(300);
    const menuOpen = await page.locator('#selection-menu').isVisible();
    await drag(-40);
    check(!menuOpen || !(await page.locator('#selection-menu').isVisible()), 'selection menu stayed open while dragging the divider');
    await page.screenshot({ path: join(outDir, 'divider-chosen-1440.png') });
    await context.close();
  }

  // Compact tabs on a phone-sized window: switching keeps the transcript position; the pinned card and card links cross tabs.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(app.url);
    await page.locator('.para').first().waitFor();
    check(await page.locator('#compact-tabs').isVisible(), 'compact tabs not shown at 390 px');
    const transcript = page.locator('#transcript');
    await transcript.evaluate(n => { n.scrollTop = Math.floor(n.scrollHeight / 3); n.dispatchEvent(new Event('scroll')); });
    const before = await transcript.evaluate(n => n.scrollTop);
    await page.locator('#ctab-board').click();
    check(await page.locator('#board-panel').isVisible() && !(await transcript.isVisible()), 'Board tab did not show the board alone');
    await page.locator('#ctab-notes').click();
    check(await page.locator('#notes-panel').isVisible(), 'Notes tab did not show notes');
    await page.locator('#ctab-plans').click();
    check(await page.locator('#plans-panel').isVisible() && !(await page.locator('#notes-panel').isVisible()), 'Plans tab did not show its own panel');
    check((await page.locator('#ctab-plans').boundingBox())!.height >= 44, 'Plans tab is below 44 px');
    await page.locator('#ctab-live').click();
    await page.waitForTimeout(100);
    const after = await transcript.evaluate(n => n.scrollTop);
    check(Math.abs(after - before) <= 2, `transcript position lost on tab switch: ${before} → ${after}`);
    if (await page.locator('.board-card').count() || app.store.meetings().length) {
      const pinned = page.locator('#pinned-card');
      if (await pinned.isVisible()) {
        const text = await pinned.locator('.pinned-text').textContent();
        const pinnedBox = (await pinned.boundingBox())!;
        check(pinnedBox.height <= 60, `pinned card is ${pinnedBox.height} px tall (should be one line)`);
        await pinned.click();
        await page.waitForTimeout(400);
        check(await page.locator('#board-panel').isVisible(), 'pinned card did not open the Board tab');
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement)?.closest('.board-card')?.textContent ?? '');
        check(Boolean(text) && focused.includes(text!.slice(0, 30)), 'pinned card did not reveal its card');
        await page.waitForTimeout(600); // smooth scroll settles; a stale scroll restore would have run by now
        check(await page.evaluate(() => { const card = (document.activeElement as HTMLElement).closest('.board-card')!; const r = card.getBoundingClientRect(), p = document.getElementById('board-panel')!.getBoundingClientRect(); return r.bottom > p.top && r.top < p.bottom; }), 'revealed card is not on screen');
        // A card's link to the transcript opens Live at that line.
        const chip = page.locator('.board-card .quote-chip, .board-card button.chip, .board-card .cite').first();
        if (await chip.count()) {
          await chip.click();
          await page.waitForTimeout(500);
          check(await transcript.isVisible(), 'card link did not open the Live tab');
          check(await page.locator('#transcript .cited').count() > 0, 'card link did not mark the cited line');
          await page.waitForTimeout(600);
          check(await page.evaluate(() => { const n = document.querySelector('#transcript .cited')!; const r = n.getBoundingClientRect(), p = document.getElementById('transcript')!.getBoundingClientRect(); return r.bottom > p.top && r.top < p.bottom; }), 'the cited line is not on screen after the jump');
        } else failures.push('no card link found to test card → transcript');
      } else failures.push('no pinned card shown although the meeting has cards');
    }
    await page.screenshot({ path: join(outDir, 'compact-390-tabs.png') });
    await context.close();
  }
} finally {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ sizes: SIZES.length, failures, screenshots: outDir }, null, 2));
if (failures.length) process.exitCode = 1;
