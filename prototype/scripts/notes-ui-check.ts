// Design D: real Notes interactions and all requested Notes/Plans screenshots. Temporary store, scripted notes, no model calls.
// Usage: MEETING_TEST_CHROME=<headless shell> node --experimental-strip-types scripts/notes-ui-check.ts [outDir]
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import type { Recognition } from '../src/recognizer.ts';

const out = resolve(process.argv[2] ?? 'artifacts/design-D');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'meeting-notes-ui-'));
const lines: [number, string][] = [
  [90000, 'Marta said she can label the new forest clips, but only in November.'],
  [190000, 'Run fourteen had rain and wind noise, that is the baseline now.'],
  [270000, 'The ecology partners keep asking whether we can tell alarm calls from song.'],
  [300000, 'Some labels mention alarm calls in the notes field, but I never counted them.'],
  [330000, 'Book the field van for next week.'],
  [842000, 'The forest site only gets to point eight one, so ninety percent is the training sites.'],
  [1000000, 'Let us just report it per site, one average hides the forest.'],
  [1015000, 'Can you fix that sentence in section four?'],
  [1325000, 'I still do not get why the forest clips are so much worse.'],
  [1420000, 'The forest recorder was at twenty two kilohertz, right?'],
  [1560000, 'The travel office needs our conference dates this week.'],
  [1620000, 'It was raining on the way to the office today.'],
];
const item = (text: string, n: number, extra = {}) => ({ text, cites: [`S${n}`], quote: lines[n - 1][1], ...extra });
const notes = async () => ({ model: 'scripted', text: JSON.stringify({ title: 'Detector check-in',
  summary: [item('Recall at the forest site is 0.81, below the 90% the paper claims.', 6), item('Run 14, with rain and wind noise, is now the baseline.', 2), item('The ecology partners want alarm calls told apart from song.', 3)],
  decisions: [item('Report recall per site in the paper, not one average.', 7)],
  actions: [item('Label 200 forest clips in November.', 1, { owner: 'Marta' }), item('Rewrite the recall sentence in Section 4.', 8, { owner: 'You' }),
    item('Confirm the uncertain assignment.', 8, { quote: 'This quote is deliberately not in the transcript.' })],
  openQuestions: [item('Why do forest clips score lower?', 9), item('Does the forest sample rate hurt the detector?', 10), item('Can the current labels tell alarm calls from song?', 4, { cites: ['S3', 'S4'] })],
  otherMatters: [item('Book the field van for next week.', 5, { kind: 'todo', label: 'admin' })],
  otherTalk: [{ from: 'S11', to: 'S11', label: 'Conference travel', smallTalk: false }, { from: 'S12', to: 'S12', label: 'Weather', smallTalk: true }],
}) });
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, publicRoot: process.env.PROGRESS_PUBLIC_ROOT, recognizer: null, drafts: null, quick: null, heavy: null, notes, actions: null, board: null });
let browser: Browser | undefined;
const errors: string[] = [], shots: string[] = [];
const measurements: Record<string, unknown> = {};
// Compare the actual rendered folds, including their decorative chevrons, across Notes and Plans.
const foldStyle = (node: Element) => {
  const s = getComputedStyle(node), c = getComputedStyle(node, '::before');
  return { font: s.font, color: s.color, height: node.getBoundingClientRect().height,
    chevron: { content: c.content, width: c.width, height: c.height, margin: c.margin, border: c.borderRight, transform: c.transform } };
};
const optionsStyle = (node: Element) => {
  const s = getComputedStyle(node), r = node.getBoundingClientRect();
  return { svg: node.querySelector('svg')!.outerHTML, width: r.width, height: r.height, font: s.font, padding: s.padding };
};
try {
  const empty = app.store.createMeeting('Notes not written yet');
  const meeting = app.store.createMeeting('Detector check-in');
  const addLine = async (n: number, startMs: number, text: string) => {
    const chunk = await app.store.addPcm(meeting.id, 'mic:t', n, startMs, 16000, Buffer.alloc(16000 * 4));
    const recognition: Recognition = { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' };
    app.store.completeChunk(chunk.id, recognition);
  };
  for (const [i, [ms, text]] of lines.entries()) await addLine(i, ms, text);
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${app.url}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text(); assert.ok(response.ok, text); return JSON.parse(text);
  };
  const project = await post('/api/projects', { name: 'Bird-call detector', repoPath: null, fromMeetingId: meeting.id });
  await post(`/api/meetings/${empty.id}/project`, { projectId: project.id });
  await post(`/api/meetings/${meeting.id}/notes`, {});
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const data = await (await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { headers: { Cookie: cookie } })).json();
    if (data.notes) { ready = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'scripted notes finished');
  assert.ok(process.env.MEETING_TEST_CHROME, 'Use an explicit test browser, never the user’s Chrome');
  browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true });
  const shot = async (page: Page, name: string) => {
    const path = join(out, `${name}.png`); await page.screenshot({ path }); shots.push(path);
  };
  const configs = [{ name: '1280-board400', width: 1280, board: 400 }, { name: '1280-board640', width: 1280, board: 640 }, { name: '390', width: 390, board: 400 }];
  for (const phase of ['fresh', 'stale']) {
    if (phase === 'stale') await addLine(lines.length, 1680000, 'We also need labels from the ecology partners.');
    for (const config of configs) {
      const context = await browser.newContext({ viewport: { width: config.width, height: 1180 } });
      try {
        await context.addInitScript(({ id, board }) => {
          try { if (!sessionStorage.getItem('design-D')) {
            localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); localStorage.setItem('compact-tab', 'notes');
            localStorage.setItem('board-width', String(board)); sessionStorage.setItem('design-D', '1');
          } } catch {}
        }, { id: meeting.id, board: config.board });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(app.url);
        await page.locator('#notes-body .note').first().waitFor();
        assert.equal(await page.locator('#plans').isVisible(), false, 'Plans does not live in Notes');
        assert.equal(await page.locator('#notes-stale').isVisible(), phase === 'stale');
        assert.equal(await page.locator('#notes-status').isVisible(), false, 'no all-is-well status');
        assert.equal(await page.locator('#notes-body .notes-title').count(), 0);
        assert.deepEqual(await page.locator('#notes-body .notes-section').allTextContents(), ['Summary', 'Decided', 'To do', 'Open questions']);
        assert.equal(await page.locator('#notes-body > .notes-fold > summary').first().innerText(), 'Not about the project (3)');
        assert.equal(await page.locator('#notes-body > .notes-fold > summary').last().innerText(), 'Needs review (1)');
        const geometry = await page.evaluate(() => {
          const bar = document.querySelector('.notes-bar')!.getBoundingClientRect();
          const body = document.getElementById('notes-body')!.getBoundingClientRect();
          const tabs = [...document.querySelectorAll('.compact-tabs button')].filter(n => (n as HTMLElement).offsetParent);
          return { barHeight: bar.height, gap: body.top - (bar.height ? bar.bottom : document.getElementById('notes-panel')!.getBoundingClientRect().top), pageScroll: document.documentElement.scrollWidth > innerWidth,
            tabsLeft: tabs[0]?.getBoundingClientRect().left ?? null, tabsRight: tabs.at(-1)?.getBoundingClientRect().right ?? null,
            tabs: tabs.map(n => ({ label: n.textContent, height: n.getBoundingClientRect().height, clipped: n.scrollWidth > n.clientWidth + 1 })) };
        });
        measurements[`${phase}-${config.name}`] = geometry;
        assert.equal(geometry.pageScroll, false); assert.equal(geometry.gap, 0);
        assert.ok(geometry.tabs.every(t => t.height >= 44 && !t.clipped));
        if (config.width === 390) {
          assert.equal(geometry.tabs.length, 5);
          assert.equal(Math.round(geometry.tabsLeft!), 8); assert.equal(Math.round(geometry.tabsRight!), 382);
        }
        await shot(page, `notes-${phase}-${config.name}`);
        const notesOptions = await page.locator('#notes-options').evaluate(optionsStyle);
        const notesFold = await page.locator('#notes-body > .notes-fold > summary').first().evaluate(foldStyle);
        if (phase === 'stale') {
          assert.equal(await page.locator('#notes-stale').evaluate(n => n.tagName), 'BUTTON');
          assert.equal(await page.locator('#notes-stale').getAttribute('type'), 'button');
          assert.equal(await page.locator('#notes-stale').getAttribute('aria-haspopup'), 'menu');
          assert.equal(await page.locator('#notes-stale').getAttribute('aria-controls'), 'notes-menu');
          assert.ok(await page.locator('#notes-stale').evaluate(n => {
            const s = getComputedStyle(n);
            return s.borderTopWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)'
              && s.textDecorationLine === 'underline' && n.getBoundingClientRect().height >= 44;
          }), 'stale menu trigger is a 44px text-styled button');
          for (const key of ['Enter', 'Space']) {
            await page.locator('#notes-stale').focus(); await page.keyboard.press(key);
            assert.equal(await page.locator('#notes-menu').isVisible(), true, `${key} opens stale notes options`);
            assert.equal(await page.locator('#rewrite-notes').evaluate(n => n === document.activeElement), true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#notes-stale').evaluate(n => n === document.activeElement), true);
          }
        }
        await page.locator('#notes-options').focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('#rewrite-notes').evaluate(e => e === document.activeElement), true);
        await page.keyboard.press('ArrowDown'); assert.equal(await page.locator('#export-notes').evaluate(e => e === document.activeElement), true);
        await page.keyboard.press('ArrowDown'); assert.equal(await page.locator('#copy-notes').evaluate(e => e === document.activeElement), true);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('#notes-options').evaluate(e => e === document.activeElement), true);
        for (const opener of phase === 'stale' ? ['notes-options', 'notes-stale'] : ['notes-options']) {
          await page.locator(`#${opener}`).click();
          assert.equal(await page.locator('#rewrite-notes').evaluate(e => e === document.activeElement), true);
          assert.equal(await page.locator('#notes-menu h3').count(), 0, 'metadata starts below the divider without a heading');
          const about = await page.locator('#notes-warnings').innerText();
          assert.match(about, /Version 1, written .* from the transcript up to/);
          assert.match(about, /AI notes: check a quote before relying on it\./);
          if (phase === 'stale') assert.match(about, /Write the notes again for an up-to-date version/);
          await shot(page, `notes-${phase}-menu-${opener}-${config.name}`);
          assert.ok(await page.locator('#notes-menu').evaluate(menu => {
            const r = menu.getBoundingClientRect(), panel = document.getElementById('notes-panel')!.getBoundingClientRect();
            const options = document.getElementById('notes-options')!, style = getComputedStyle(options);
            return r.left >= panel.left && r.right <= panel.right && r.bottom <= innerHeight
              && [...menu.querySelectorAll('[role="menuitem"]')].every(n => n.getBoundingClientRect().height >= 44)
              && style.backgroundColor === 'rgb(238, 242, 253)'
              && (options.closest('.pane-head') ? style.borderTopWidth === '0px' && style.boxShadow === 'none' : style.boxShadow !== 'none');
          }), 'menu fits and has a visible expanded state');
          await page.keyboard.press('Escape'); assert.equal(await page.locator(`#${opener}`).evaluate(e => e === document.activeElement), true);
          await page.locator(`#${opener}`).click(); await page.mouse.click(5, 5);
          assert.equal(await page.locator('#notes-menu').isVisible(), false);
          assert.equal(await page.locator(`#${opener}`).evaluate(n => n === document.activeElement), true);
        }
        if (phase === 'fresh') {
          assert.equal(await page.locator('#notes-body .notes-summary').count(), 1, 'one summary paragraph');
          assert.equal(await page.locator('.notes-summary > a[href^="#transcript-"]').count(), 3, 'each sentence is its own transcript link');
          assert.equal(await page.locator('.notes-group > .notes-list').count(), 3, 'Decided, To do and Open questions are lists');
          assert.equal(await page.locator('#notes-body .note-time, #notes-body .note-details, #notes-body .cite').count(), 0, 'no times, detail toggles or citation markers');
          const sentence = page.locator('.notes-summary > a').first();
          await sentence.hover();
          assert.equal(await sentence.evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(238, 242, 253)');
          assert.equal(await sentence.evaluate(n => getComputedStyle(n).color), 'rgb(31, 62, 153)');
          await shot(page, `notes-hover-${config.name}`);
          await sentence.focus(); await page.keyboard.press('Tab');
          assert.equal(await page.locator('.notes-summary > a').nth(1).evaluate(n => n === document.activeElement), true);
          await shot(page, `notes-focus-${config.name}`);
          await page.keyboard.press('Enter'); await page.locator('#transcript .cited').waitFor();
          if (config.width === 390) { assert.equal(await page.locator('#ctab-live').getAttribute('aria-selected'), 'true'); await page.locator('#ctab-notes').click(); }
          const multi = page.locator('.notes-group').last().locator('.note-sentence').last();
          await multi.click();
          assert.equal(await page.locator('#transcript .cited').count(), 2, 'every cited line highlights');
          await page.waitForTimeout(2600);
          assert.ok(await page.locator('#transcript .cited').evaluateAll(nodes => nodes.every(n => getComputedStyle(n).backgroundColor === 'rgb(255, 243, 196)')), 'the cited lines stay highlighted after the flash');
          assert.ok(await page.locator('#transcript .cited').first().evaluate(n => {
            const r = n.getBoundingClientRect(), pane = document.getElementById('transcript')!.getBoundingClientRect();
            return r.bottom > pane.top && r.top < pane.bottom;
          }), 'the first cited line scrolls into view');
          await shot(page, `notes-transcript-${config.name}`);
          if (config.width === 390) await page.locator('#ctab-notes').click();
          assert.equal(await multi.evaluate(n => n.classList.contains('lit')), true);
          await shot(page, `notes-cited-${config.name}`);
          await page.locator('#notes-body > .notes-fold > summary').first().click();
          await page.locator('#notes-body .notes-fold .notes-fold > summary').click();
          await page.locator('#notes-body > .notes-fold > summary').last().click();
          await page.locator('#notes-body .notes-fold .look-into').waitFor();
          await page.locator('#notes-body > .notes-fold').last().scrollIntoViewIfNeeded();
          await shot(page, `notes-folds-${config.name}`);
          const look = page.locator('#notes-body .look-into > button').first();
          assert.equal(await look.evaluate(n => getComputedStyle(n).borderTopWidth), '0px', 'Look into it is a secondary text action');
          await look.locator('..').locator('..').hover();
          assert.equal(await look.locator('..').evaluate(n => getComputedStyle(n).opacity), '1', 'Look into it shows on item hover');
          await shot(page, `notes-look-hover-${config.name}`);
          await page.mouse.move(0, 0); await look.focus();
          assert.equal(await look.locator('..').evaluate(n => getComputedStyle(n).opacity), '1', 'Look into it shows on keyboard focus');
          await shot(page, `notes-look-focus-${config.name}`);
          await look.click();
          await page.locator('#notes-body .look-into textarea').waitFor();
          assert.ok(await page.locator('#notes-body').evaluate(body => [...body.querySelectorAll('summary, textarea')]
            .filter(n => (n as HTMLElement).offsetParent).every(n => n.getBoundingClientRect().height >= 44)), 'folds and request input retain 44 px targets; sentences are inline text');
          assert.match(await page.locator('#notes-body .note-review').innerText(), /quote not found/);
          await shot(page, `notes-look-into-form-${config.name}`);
          await page.locator('#meeting-button').click();
          await page.locator('#meeting-list [role="menuitemradio"]').filter({ hasText: empty.title }).click();
          await page.locator('#notes-body .board-empty').waitFor();
          await page.locator('#meeting-button').click();
          await page.locator('#meeting-list [role="menuitemradio"]').filter({ hasText: meeting.title }).click();
          await page.locator('#notes-body .notes-summary > a').first().waitFor();
          assert.equal(await page.locator('#notes-body .notes-summary > a').count(), 3, 'returning to the same notes version restores its body');
        }
        // Plans screenshots at the same widths, independently of Notes.
        if (phase === 'fresh') for (const state of ['no-notes', 'idle', 'running', 'planned', 'menu', 'stale', 'off-cloud', 'more', 'not-planned', 'review']) {
          const fixture = ({ idle: 'idle', running: 'running', planned: 'plans', menu: 'plans', stale: 'stale', more: 'plans', 'not-planned': 'plans', review: 'mixed' } as Record<string, string>)[state];
          await page.evaluate(({ id }) => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'plans'); localStorage.setItem('compact-tab', 'plans'); }, { id: state === 'no-notes' ? empty.id : meeting.id });
          await page.goto(`${app.url}/${fixture ? `?plans-fixture=${fixture}` : ''}`);
          await page.locator('#plans:not([hidden]) .plans-content > *').first().waitFor();
          await page.waitForTimeout(150);
          if (state === 'no-notes') {
            assert.equal(await page.locator('#plans').innerText(), 'Plans are made from the notes. Write the notes first.');
            assert.equal(await page.locator('#plans button').count(), 0);
          } else if (state === 'idle') {
            assert.match(await page.locator('#plans .plans-idle').innerText(), /3 open questions and 2 actions/);
            assert.equal(await page.locator('#plans .primary').innerText(), 'Plan');
          } else if (state === 'off-cloud') {
            assert.match(await page.locator('#plans').innerText(), /cloud models, which are off/);
            assert.equal(await page.locator('#plans button').count(), 0);
          } else if (state === 'running') {
            assert.match(await page.locator('#plans .job-progress').innerText(), /Making plans · .*Cancel/s);
            assert.deepEqual(await page.locator('#plans .progress-label').allTextContents(), ['Read the notes', 'Read your materials', 'Write the plans', 'Check every source']);
            assert.match(await page.locator('#plans .progress-detail').allTextContents().then(a => a.join(' ')), /3\u00a0web\u00a0pages · 1\u00a0check\u00a0run/);
          }
          else {
            await page.locator('#plans .plan-row').first().waitFor();
            assert.equal(await page.locator('#plans .plans-stale').isVisible(), state === 'stale');
            assert.deepEqual(await page.locator(':is(#plans, #plans-options-slot) .options-button').evaluate(optionsStyle), notesOptions, 'Options buttons have identical SVGs and dimensions');
            for (const toggle of await page.locator('#plans .plans-more button, #plans .plans-aside-toggle').all()) {
              assert.doesNotMatch(await toggle.innerText(), /[▸▾]/);
              assert.deepEqual(await toggle.evaluate(foldStyle), notesFold, 'Plans folds match Notes typography, chevrons and 44px targets');
            }
            assert.ok(await page.locator('#plans .plans-card').evaluate(card => {
              const list = card.querySelector('.plans-list');
              return Boolean(list) && [...card.querySelectorAll('.plans-aside')].every(aside => {
                const s = getComputedStyle(aside), previous = aside.previousElementSibling!;
                return aside.parentElement === card && s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.borderRadius === '0px'
                  && Math.abs(aside.getBoundingClientRect().top - previous.getBoundingClientRect().bottom) < 0.5;
              });
            }), 'Plans folds are flush with the rows inside one surface');
            if (['more', 'not-planned', 'review'].includes(state)) {
              const key = state === 'more' ? 'more' : state === 'review' ? 'review' : 'aside';
              const toggle = page.locator(`#plans [data-focus="${key}"]`);
              await toggle.click();
              assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
              const open = await toggle.evaluate(foldStyle);
              assert.notEqual(open.chevron.transform, notesFold.chevron.transform, 'open fold turns its chevron');
              if (state === 'more') assert.equal(await toggle.innerText(), 'Show fewer');
              await toggle.scrollIntoViewIfNeeded();
            }
            if (state === 'menu') {
              await page.locator(':is(#plans, #plans-options-slot) [data-focus="options"]').click();
              assert.equal(await page.locator('#plans-menu [data-focus="plan-again"]').evaluate(e => e === document.activeElement), true);
              assert.match(await page.locator('#plans-menu').innerText(), /Made at/);
              assert.equal(await page.locator('#plans-menu h3').count(), 0);
            }
          }
          await shot(page, `plans-${state}-${config.name}`);
        }
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await writeFile(join(out, 'index.md'), shots.map(path => `- [${path.split('/').at(-1)}](${path.split('/').at(-1)})`).join('\n'));
  console.log(`Notes and Plans UI checks passed; ${shots.length} screenshots in ${out}`);
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
