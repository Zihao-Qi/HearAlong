// UI review regressions: real notes jobs and DOM geometry, with local scripted models only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
const out = resolve(process.argv[2] ?? 'artifacts/progress-fix2'); await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'progress-fix2-'));
const lines = ['Keep the painted lanterns on the lower rack until the parade.', 'Book the field van for next week.', 'Send the travel office the conference dates this week.', 'It was raining on the way to the office today.'];
const note = (text: string) => ({ text, cites: ['S1'], quote: lines[0] });
let held = true;
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null, plans: null, board: null, actions: null,
  notes: async ({ signal }) => {
    if (held) await new Promise<void>((_, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    return { text: JSON.stringify({ summary: [note('The painted lanterns stay on the rack.')], decisions: [],
      actions: [{ ...note('Rewrite the recall sentence in Section 4.'), owner: 'You' }], openQuestions: [],
      otherMatters: [{ text: lines[1], cites: ['S2'], quote: lines[1], kind: 'todo', label: 'admin' }],
      otherTalk: [{ from: 'S3', to: 'S3', label: 'Conference travel', smallTalk: false }, { from: 'S4', to: 'S4', label: 'Weather', smallTalk: true }] }) };
  } });
assert.ok(process.env.MEETING_TEST_CHROME);
const browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
const failures: string[] = [], shots: string[] = [], measurements: unknown[] = [], errors: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); if (!ok) failures.push(name); };
const cancelStyles: unknown[] = [];
try {
  for (const width of [1280, 390]) {
    held = true;
    const meeting = app.store.createMeeting('Lantern workshop');
    for (const [i, text] of lines.entries()) {
      const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', i, i * 30_000, 16000, Buffer.alloc(64000));
      app.store.completeChunk(chunk.id, { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    }
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    try {
      await context.addInitScript(id => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); localStorage.setItem('compact-tab', 'notes'); localStorage.setItem('board-width', '400'); }, meeting.id);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(app.url);
      const shot = async (name: string) => { const file = `${width}-${name}.png`; await page.screenshot({ path: join(out, file) }); shots.push(file); };
      await page.locator('#write-notes').click(); await page.locator('#notes-progress .job-progress').waitFor();
      check(`${width}: first notes progress hides idle help`, !(await page.locator('#notes-body .board-empty').isVisible()));
      const style = await page.locator('#notes-progress .progress-cancel').evaluate(n => { const s = getComputedStyle(n); return { decoration: s.textDecorationLine, offset: s.textUnderlineOffset, color: s.color, font: s.font, background: s.backgroundColor, border: s.borderTopWidth, height: n.getBoundingClientRect().height }; });
      check(`${width}: Cancel is a 44px underlined text action`, style.decoration === 'underline' && style.offset === '3px' && style.border === '0px' && style.height >= 44, style);
      cancelStyles.push(style); await shot('first-notes');
      await page.locator('#notes-progress .progress-cancel').click();
      await page.locator('#notes-progress').waitFor({ state: 'hidden' });
      check(`${width}: Cancel restores idle help`, await page.locator('#notes-body .board-empty').isVisible());
      held = false; await page.locator('#write-notes').click(); await page.locator('#notes-body .owner').waitFor();
      const owner = await page.locator('#notes-body .owner').evaluate(chip => {
        const link = chip.closest('li')!.querySelector('.note-sentence')!;
        const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT); const nodes: Text[] = []; let n: Node | null;
        while ((n = walker.nextNode())) if (n.textContent?.trim() && !(n.parentElement?.closest('.owner'))) nodes.push(n as Text);
        const last = nodes.at(-1)!, start = last.textContent!.search(/\S+\s*$/); const range = document.createRange(); range.setStart(last, start); range.setEnd(last, last.length);
        const word = range.getBoundingClientRect(), tag = chip.getBoundingClientRect();
        return { word: word.toJSON(), chip: tag.toJSON(), grouped: Boolean(chip.closest('.note-owner-tail')), nowrap: chip.closest('.note-owner-tail') ? getComputedStyle(chip.closest('.note-owner-tail')!).whiteSpace : null };
      });
      check(`${width}: last word and You? owner stay on one line`, Math.abs((owner.word.top + owner.word.bottom - owner.chip.top - owner.chip.bottom) / 2) <= 3 && owner.grouped && owner.nowrap === 'nowrap', owner);
      measurements.push({ width, owner }); await shot('owner-tail');
      await page.locator('#notes-body > .notes-fold > summary').first().click();
      await page.locator('#notes-body .notes-fold .notes-fold > summary').click();
      const rangeRows = await page.locator('.offtopic-row').evaluateAll(rows => rows.map(n => ({ text: n.textContent, tag: n.tagName, parent: n.parentElement?.tagName, display: getComputedStyle(n).display, marker: getComputedStyle(n).listStyleType })));
      check(`${width}: travel and small-talk ranges have real bullets`, rangeRows.length === 2 && rangeRows.every(n => n.tag === 'LI' && n.parent === 'UL' && n.display === 'list-item' && n.marker === 'disc'), rangeRows);
      for (const label of ['Conference travel', 'Weather']) {
        const link = page.locator('.offtopic-row a').filter({ hasText: label });
        await link.hover(); check(`${width}: ${label} hover style`, await link.evaluate(n => getComputedStyle(n).backgroundColor === 'rgb(238, 242, 253)'));
        await link.focus(); await page.keyboard.press('Enter'); await page.locator('#transcript .cited').waitFor();
        const cited = await page.locator('#transcript .cited').getAttribute('data-id');
        const target = await link.getAttribute('data-cite');
        check(`${width}: ${label} native link jumps to range start`, cited === target);
        if (width === 390) await page.locator('#ctab-notes').click();
      }
      await shot('bulleted-ranges');
      await page.mouse.move(0, 0); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      const look = page.locator('#notes-body .look-into').first(), item = look.locator('..');
      const before = (await item.boundingBox())!;
      await item.hover(); const after = (await item.boundingBox())!;
      check(`${width}: Look into it hover reserves identical bounds`, Object.keys(before).every(k => Math.abs(before[k as keyof typeof before] - after[k as keyof typeof after]) <= 0.5), { before, after });
      check(`${width}: Look into it appears on hover`, await look.evaluate(n => getComputedStyle(n).opacity === '1')); await shot('look-hover');
      await page.mouse.move(0, 0); await look.locator('button').first().focus(); const focused = (await item.boundingBox())!;
      check(`${width}: Look into it focus reserves identical bounds`, Object.keys(before).every(k => Math.abs(before[k as keyof typeof before] - focused[k as keyof typeof focused]) <= 0.5));
      check(`${width}: Look into it appears on focus`, await look.evaluate(n => getComputedStyle(n).opacity === '1')); await shot('look-focus');
      await page.locator(width === 390 ? '#ctab-plans' : '#tab-plans').click();
      await page.locator('#plans .plans-content').waitFor();
      const phrases = await page.evaluate(async () => {
        const module = '/plans.js'; const { progressCard } = await import(module);
        const host = document.querySelector('#plans .plans-content')!;
        host.replaceChildren(progressCard('plans', { phase: 'materials', startedAt: Date.now(), questions: 2, pages: 1, checks: 2, materials: ['a-long-results-file.csv', 'another-results-file.csv', 'guide.md', 'draft.md'] }, () => {}));
        const details = [...host.querySelectorAll('.progress-detail')];
        return ['1\u00a0web\u00a0page', '2\u00a0checks\u00a0run', '+1\u00a0more', '2\u00a0open\u00a0questions'].map(phrase => {
          const node = details.find(n => n.textContent?.includes(phrase))?.firstChild;
          if (!node) return { phrase, present: false, lines: 0 };
          const start = node.textContent!.indexOf(phrase), range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + phrase.length);
          return { phrase, present: true, lines: range.getClientRects().length };
        });
      });
      check(`${width}: count phrases use nonbreaking spaces and stay on one line`, phrases.every(p => p.present && p.lines === 1), phrases);
      measurements.push({ width, look: { before, after, focused }, phrases, cancel: style });
      await page.locator('#plans .job-progress').scrollIntoViewIfNeeded(); await shot('unbroken-counts');
    } finally { await context.close(); }
  }
  check('Cancel computed styles match across widths', JSON.stringify(cancelStyles[0]) === JSON.stringify(cancelStyles[1]), cancelStyles);
  check('no page errors', errors.length === 0, errors);
  await writeFile(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(join(out, 'index.md'), shots.map(s => `- [${s}](${s})`).join('\n'));
  assert.deepEqual(failures, []);
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
