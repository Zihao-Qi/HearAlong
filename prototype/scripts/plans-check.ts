// Click-through of the Plans section (M7b, layout D1) against its fixtures (public/plans-fixtures.js, whose data the real plan
// domain and projection made: scripts/plans-fixtures-build.ts), in the real app page.
// A temporary store gets one meeting with a short transcript, scripted notes (no cloud call) and a project; each fixture state is
// then loaded with ?plans-fixture=<state> at 1280 px (board 640 px, so the rows are wide), 1280 px with the default 400 px board,
// and 390 px (compact). Checked: the Add buttons share one edge, rows keep their height after Add, no text is clipped or past the
// edge, every control is at least 44×44 px, the focus stays in the section when a control is replaced, every control responds,
// no console errors.
// Usage: node --experimental-strip-types scripts/plans-check.ts [outDir] (PLANS_CHECK_STATES=plans,refused for a focused rerun)
// The browser is Playwright's own Chromium (MEETING_TEST_CHROME, else the newest headless shell in the Playwright cache).
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { MeetingStore } from '../src/store.ts';
import type { Recognition } from '../src/recognizer.ts';
import { plansLifecycleCheck } from './plans-lifecycle-check.ts';

const outDir = resolve(process.argv[2] ?? 'artifacts/plans-check');
await mkdir(outDir, { recursive: true });

async function bundledChromium() {
  if (process.env.MEETING_TEST_CHROME) return process.env.MEETING_TEST_CHROME;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const shells = (await readdir(cache).catch(() => [] as string[])).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse();
  for (const d of shells) {
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const path = join(cache, d, arch, 'chrome-headless-shell');
      if (await readFile(path).then(() => true, () => false)) return path;
    }
  }
  return chromium.executablePath();
}

// ---------- A meeting with a transcript, notes and a project ----------

const LINES = [
  'Let us start with the forest site, the recall there looked lower than on the training sites.',
  'The paper still says we keep ninety percent recall everywhere, and I do not think that is true any more.',
  'Could the drop come from the forest recorders? I think they record at a lower sample rate.',
  'Marta said she can label the new forest clips, but only in November.',
  'We need about two hundred labelled clips for a fair test on that site.',
  'Did we already try noise augmentation? I remember rain and wind in one of the runs.',
  'Yes, run fourteen had rain and wind noise, that is the baseline now.',
  'How many GPU hours do we have left before the December deadline?',
  'Nobody knows, the allocation changed in November.',
  'The ecology partners keep asking whether we can tell alarm calls from song.',
  'Some labels mention alarm calls in the notes field, but I never counted them.',
  'Also, who is booking the field van for next week?',
];
const recognition = (text: string): Recognition => ({ text, words: [], backend: 't', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none', retries: 0 });
const directory = await mkdtemp(join(tmpdir(), 'meeting-plans-'));
{
  const store = new MeetingStore(directory);
  const meeting = store.createMeeting('Detector check-in');
  for (const [i, line] of LINES.entries()) {
    const chunk = await store.addPcm(meeting.id, 'mic:t', i, i * 30_000, 16000, Buffer.alloc(16000 * 4, i + 1));
    store.completeChunk(chunk.id, recognition(line));
  }
  store.close();
}
const item = (text: string, n: number, words: number) => ({ text, cites: [`S${n}`], quote: LINES[n - 1].split(' ').slice(0, words).join(' ') });
const notes = async () => ({ model: 'scripted', text: JSON.stringify({
  title: 'Detector check-in',
  summary: [item('Recall at the new forest site is lower than at the training sites.', 1, 12)],
  decisions: [item('Run 14 with rain and wind noise stays the baseline.', 7, 9)],
  actions: [item('Find out how many GPU hours are left before the December deadline.', 8, 10)],
  openQuestions: [item('Is the drop caused by the forest recorders’ lower sample rate?', 3, 9), item('Should the detector tell alarm calls from song?', 10, 12)],
  otherMatters: [{ ...item('Book the field van for next week.', 12, 8), kind: 'todo', label: 'admin' }], otherTalk: [],
}) });
await dashboardSetup(directory);
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null, notes: notes as never, actions: null, board: null });
let browser: Browser | undefined;
const results: string[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`); return ok; };
const shots: string[] = [];

try {
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${app.url}${path}`, { method, headers: { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
    return data;
  };
  const [meeting] = app.store.meetings();
  await call('/api/projects', 'POST', { name: 'Bird-call detector', repoPath: null, fromMeetingId: meeting.id });
  await call(`/api/meetings/${meeting.id}/notes`, 'POST', {});
  for (let i = 0; i < 100 && !(await call(`/api/meetings/${meeting.id}/notes`)).notes; i++) await new Promise(r => setTimeout(r, 100));
  if (!(await call(`/api/meetings/${meeting.id}/notes`)).notes) throw new Error('The scripted notes were not written.');

  browser = await chromium.launch({ executablePath: await bundledChromium(), headless: true });
  const CONFIGS = [
    { name: '1280', width: 1280, height: 900, board: 640 },
    { name: '1280-board400', width: 1280, height: 900, board: 400 },
    { name: '390', width: 390, height: 844, board: 400 },
  ];
  const STATES = ['idle', 'running', 'waiting-recording', 'waiting-notes', 'waiting-quota', 'plans', 'replanning', 'mixed', 'nothing', 'all-failed',
    'stopped', 'closed', 'failed', 'stale', 'stale-materials', 'explored', 'explore-stopped', 'newer', 'refused', 'moved', 'no-project'];

  const selected = process.env.PLANS_CHECK_STATES ? STATES.filter(s => process.env.PLANS_CHECK_STATES!.split(',').includes(s)) : STATES;
  for (const config of CONFIGS) for (const state of selected) {
    const t = `${state} @${config.name}`;
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, acceptDownloads: true });
    await context.addInitScript(([id, board]) => {
      try {
        if (!sessionStorage.getItem('plans-check')) {
          localStorage.clear();
          localStorage.setItem('meeting-id', id as string); localStorage.setItem('right-tab', 'plans'); localStorage.setItem('compact-tab', 'plans');
          localStorage.setItem('board-width', String(board));
          sessionStorage.setItem('plans-check', '1');
        }
      } catch { /* storage unavailable */ }
    }, [meeting.id, config.board]);
    await context.route('https://example.org/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    let downloads = 0, popups = 0;
    let markdown = '';
    page.on('download', async d => { downloads++; const p = await d.path().catch(() => null); if (p) markdown = await readFile(p, 'utf8'); });
    context.on('page', p => { if (p !== page) { popups++; void p.close(); } });
    try {
      await page.goto(`${app.url}/?plans-fixture=${state}`);
      await page.locator('#plans:not([hidden]) .plans-content > *').first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await geometry(page, t);
      await shoot(page, `${state}-${config.name}`);
      if (state === 'plans') {
        check(`${t}: Plans has its own selected tab and panel`, await page.evaluate(() => {
          return !document.getElementById('plans-panel')!.hidden && document.getElementById('notes-panel')!.hidden
            && document.getElementById(document.body.classList.contains('layout-compact') ? 'ctab-plans' : 'tab-plans')!.getAttribute('aria-selected') === 'true';
        }));
        await page.evaluate(() => { document.getElementById('plans-panel')!.scrollTop = 0; });
        await page.waitForTimeout(300);
        const path = join(outDir, `context-${config.name}.png`);
        await page.screenshot({ path }); shots.push(path);
      }
      await stateChecks(page, state, config.name, t);
      if (['plans', 'refused', 'mixed'].includes(state)) await openFirst(page, `${state}-${config.name}-details`);
      if (['plans', 'mixed', 'explored'].includes(state)) await openAll(page, t, `${state}-${config.name}-all-open`);
      await clickEverything(page, t, () => ({ downloads, popups }));
      if (state === 'plans') check(`${t}: Download gives the plans as Markdown`, markdown.startsWith('# Plans — Detector check-in') && markdown.includes('Can Section 4 say the detector keeps 90% recall') && markdown.includes('## Not planned'), markdown.slice(0, 120));
      check(`${t}: no console errors`, errors.length === 0, errors.join(' | '));
    } catch (error) {
      check(`${t}: ran to the end`, false, (error as Error).message.split('\n')[0]);
      await page.screenshot({ path: join(outDir, `${state}-${config.name}-error.png`) }).catch(() => {});
    } finally { await context.close(); }
  }
  await lifecycleChecks(browser);
  await settingsCheck(browser, meeting.id);
} finally {
  await browser?.close().catch(() => {});
  await app.close();
  await rm(directory, { recursive: true, force: true });
}

// ---------- Checks ----------

/** The Add buttons share one edge, nothing is clipped or past the section's edge, every button is at least 44 px. */
async function geometry(page: Page, t: string) {
  const g = await page.evaluate(() => {
    const plans = document.getElementById('plans')!;
    const box = plans.getBoundingClientRect();
    const wide = box.width >= 520;
    const adds = [...plans.querySelectorAll('.plan-row > .plan-slot .plan-add')].map(b => b.getBoundingClientRect()).map(r => ({ left: Math.round(r.left), right: Math.round(r.right) }));
    const slots = [...plans.querySelectorAll('.plan-row > .plan-slot')].map(s => Math.round(s.getBoundingClientRect().right));
    const outside = [...plans.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map(e => e.className || e.tagName);
    // The screen reader's live region is hidden on purpose; everything else must show all of its text.
    const clipped = [...plans.querySelectorAll('*:not(.visually-hidden)')].filter(e => {
      const s = getComputedStyle(e);
      const hides = s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none';
      return hides && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1);
    }).map(e => e.className || e.tagName);
    const small = [...plans.querySelectorAll('button, a[href]')].filter(b => (b as HTMLElement).offsetParent).filter(b => { const r = b.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; })
      .map(b => `${b.textContent!.trim().slice(0, 24)} (${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)})`);
    const pageScroll = document.documentElement.scrollWidth > innerWidth;
    const foldErrors = [...plans.querySelectorAll('.plans-toggle, .plans-aside-toggle')].filter(n => {
      const s = getComputedStyle(n), c = getComputedStyle(n, '::before');
      return /[▸▾]/.test(n.textContent ?? '') || s.fontSize !== '13px' || s.fontWeight !== '600'
        || s.color !== 'rgb(90, 101, 119)' || c.content === 'none' || c.width !== '5px';
    }).map(n => n.textContent);
    return { wide, adds, slots, outside, clipped, small, pageScroll, foldErrors };
  });
  if (g.adds.length > 1) check(`${t}: the Add buttons share one ${g.wide ? 'right' : 'left'} edge`, new Set(g.adds.map(a => g.wide ? a.right : a.left)).size === 1, JSON.stringify(g.adds));
  if (g.wide && g.slots.length > 1) check(`${t}: the slots share one right edge`, new Set(g.slots).size === 1, g.slots.join(','));
  check(`${t}: nothing past the section's edge`, g.outside.length === 0 && !g.pageScroll, g.outside.slice(0, 5).join(', '));
  check(`${t}: no text clipped`, g.clipped.length === 0, g.clipped.slice(0, 5).join(', '));
  check(`${t}: controls at least 44×44 px`, g.small.length === 0, g.small.join(', '));
  check(`${t}: folds use Notes typography and visual chevrons`, g.foldErrors.length === 0, g.foldErrors.join(', '));
}

function rowHeights(page: Page) {
  // Query and measure in one browser turn. $$eval first obtains handles: a poll's replaceChildren between that and measuring
  // leaves detached rows with height 0 (the intermittent "Add on a step undone earlier" failure, especially at 390 px).
  return page.evaluate(() => [...document.querySelectorAll('#plans .plan-row')].map(r => Math.round(r.getBoundingClientRect().height * 2) / 2));
}
function text(page: Page, sel: string) { return page.locator(sel).allInnerTexts(); }

async function stateChecks(page: Page, state: string, config: string, t: string) {
  const status = (await text(page, '#plans .plans-status > span'))[0] ?? '';
  const banners = (await text(page, '#plans .plans-banner')).join(' | ');
  const stale = (await text(page, '#plans .plans-stale'))[0] ?? '';
  switch (state) {
    case 'idle': {
      check(`${t}: idle card with primary Plan and real counts`, await page.locator('#plans .plans-idle button.primary', { hasText: /^Plan$/ }).count() === 1
        && (await page.locator('#plans .plans-idle').innerText()).includes('2 open questions and 1 action in the notes. About 2 minutes.'));
      if (config === '1280') {
        await page.locator('#plans .plans-idle button').click();
        await page.locator('#plans .plans-status').waitFor();
        check(`${t}: Plan starts a run with Cancel`, await page.locator('#plans .plans-status button', { hasText: 'Cancel' }).count() === 1);
        await page.locator('#plans .plan-row').first().waitFor({ timeout: 12_000 });
        check(`${t}: the run ends in plans, three shown`, (await rowHeights(page)).length === 3);
        await shoot(page, `idle-${config}-after-run`);
      }
      break;
    }
    case 'running': {
      const labels = await page.locator('#plans .progress-label').allTextContents();
      check(`${t}: four-step progress card with pages, checks and Cancel`, JSON.stringify(labels) === JSON.stringify(['Read the notes', 'Read your materials', 'Write the plans', 'Check every source'])
        && (await page.locator('#plans .progress-detail').allTextContents()).join(' ').includes('3\u00a0web\u00a0pages · 1\u00a0check\u00a0run')
        && await page.locator('#plans .progress-cancel', { hasText: 'Cancel' }).count() === 1);
      break;
    }
    case 'waiting-recording': {
      check(`${t}: an automatic run waiting for the recording`, status === 'Planning after the notes: waiting for the recording to end.', status);
      // The user's Plan replaces a waiting automatic run (§2b).
      await page.locator(':is(#plans, #plans-options-slot) [data-focus="options"]').click();
      await page.locator('#plans-menu [data-focus="plan-again"]').click();
      await page.locator('#plans .plans-status > span', { hasText: /^Waiting for the memory update\.$/ }).waitFor();
      check(`${t}: Plan replaces the waiting automatic run`, true);
      break;
    }
    case 'waiting-notes': check(`${t}: waiting for the notes`, status === 'Waiting for the notes.', status); break;
    case 'waiting-quota': check(`${t}: waiting for the quota`, /^Waiting for the model’s quota, until about /.test(status), status); break;
    case 'replanning': check(`${t}: progress above the three kept plans`, await page.locator('#plans .job-progress').count() === 1
      && (await page.locator('#plans .progress-detail').allTextContents()).join(' ').includes('1\u00a0check\u00a0run') && (await rowHeights(page)).length === 3); break;
    case 'plans': {
      check(`${t}: three rows and “3 more”`, (await rowHeights(page)).length === 3 && await page.locator('#plans .plans-more button', { hasText: /^3 more$/ }).count() === 1);
      check(`${t}: complete answer and step: “Answer:” and “Next:”`, /^Answer: No: the forest site/.test((await text(page, '#plans .plan-answer'))[0]) && /^Next: Rewrite/.test((await text(page, '#plans .plan-step'))[0]));
      check(`${t}: partial answer: “So far:”`, (await text(page, '#plans .plan-answer'))[1]?.startsWith('So far:'));
      check(`${t}: step only, with “Next:”, for Marta`, (await text(page, '#plans .plan-step'))[2]?.startsWith('Next: Send Marta') && await page.locator('#plans .plan-for', { hasText: 'for Marta' }).count() === 1);
      check(`${t}: In to-dos and Already in to-dos (T-1)`, await page.locator('#plans .plan-done', { hasText: /^In to-dos$/ }).count() === 1 && await page.locator('#plans .plan-done', { hasText: 'Already in to-dos (T-1)' }).count() === 1);
      await page.locator('#plans .plans-more button').click();
      check(`${t}: 3 more shows all six`, (await rowHeights(page)).length === 6);
      await geometry(page, `${t} (all six)`);
      check(`${t}: an answer only has no Add`, await page.locator('#plans .plan:nth-child(4) .plan-add').count() === 0 && await page.locator('#plans .plan:nth-child(4) .plan-step').count() === 0);
      const long = await page.locator('#plans .plan:nth-child(5) .plan-step').innerText();
      check(`${t}: over-long row text shown in full`, long.endsWith('nobody at the meeting knew the new number.'), long);
      await shoot(page, `plans-${config}-all`);
      // Add, from the keyboard: In to-dos in the same slot, the focus on its Undo; no row changes height (also after the next load).
      const before = await rowHeights(page);
      await page.locator('#plans .plan:nth-child(2) .plan-row .plan-add').focus();
      await page.keyboard.press('Enter');
      await page.locator('#plans .plan:nth-child(2) .plan-row .plan-done', { hasText: 'In to-dos' }).waitFor();
      await page.locator('#plans .plan:nth-child(2) .plan-row button', { hasText: 'Undo' }).waitFor();
      check(`${t}: the focus moves to Undo`, await page.evaluate(() => document.activeElement?.textContent === 'Undo'));
      const undoBox = await page.evaluate(() => {
        const b = document.querySelector('#plans .plan:nth-child(2) .plan-row button.plan-undo');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      check(`${t}: Undo is at least 44×44 px`, Boolean(undoBox && undoBox.width >= 43.5 && undoBox.height >= 43.5), JSON.stringify(undoBox));
      const after = await rowHeights(page);
      await page.waitForTimeout(800);
      const later = await rowHeights(page);
      check(`${t}: Add keeps every row's height`, JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(before) === JSON.stringify(later), `${before} → ${after} → ${later}`);
      await shoot(page, `plans-${config}-added`);
      // Undo, then Add again: a new generation.
      await page.locator('#plans .plan:nth-child(2) .plan-row button', { hasText: 'Undo' }).click();
      await page.locator('#plans .plan:nth-child(2) .plan-row .plan-add').waitFor();
      check(`${t}: Undo gives Add again, same height`, JSON.stringify(await rowHeights(page)) === JSON.stringify(before));
      await page.locator('#plans .plan:nth-child(2) .plan-row .plan-add').click();
      await page.locator('#plans .plan:nth-child(2) .plan-row .plan-done', { hasText: 'In to-dos' }).waitFor();
      check(`${t}: Add again after Undo`, true);
      // The step that was undone before this page opened: Add again.
      await page.locator('#plans .plan:nth-child(5) .plan-row .plan-add').click();
      await page.locator('#plans .plan:nth-child(5) .plan-row .plan-done').waitFor();
      check(`${t}: Add on a step undone earlier`, JSON.stringify(await rowHeights(page)) === JSON.stringify(before));
      // A follow-on keeps its condition.
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      check(`${t}: chevron has aria-expanded`, await page.locator('#plans .plan:nth-child(2) .plan-chev').getAttribute('aria-expanded') === 'true');
      check(`${t}: follow-ons with their condition`, (await text(page, '#plans .plan:nth-child(2) .plan-follow > span')).join('|').startsWith('If recall rises to the training sites’ level: resample all forest files'));
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      await page.locator('#plans .plans-more button').click();
      break;
    }
    case 'mixed': {
      const downloaded = page.waitForEvent('download');
      await page.locator(':is(#plans, #plans-options-slot) [data-focus="options"]').click();
      const menuWarnings = await page.locator('#plans-menu').innerText();
      await page.locator('#plans-menu [data-focus="download"]').click();
      const markdown = await readFile((await (await downloaded).path())!, 'utf8');
      const notesWarnings = ['Missing speech: 12:40–13:10.', '2 audio chunk(s) were still being transcribed when the notes were written.',
        '3 line(s) had not been checked for misheard terms.', 'The transcript changed after the notes were written.'];
      const plansWarnings = ['The materials changed during this run', 'Quick checks were off for this run', '1 older project-memory item was left out'];
      check(`${t}: only plans warnings in Options; all warnings kept in Markdown`,
        notesWarnings.every(w => !menuWarnings.includes(w) && markdown.includes(`> ${w}`))
        && plansWarnings.every(w => menuWarnings.includes(w) && !banners.includes(w) && markdown.includes(w)), menuWarnings);
      await page.locator('#plans .plans-aside-toggle', { hasText: 'Needs review (2)' }).click();
      const review = (await text(page, '#plans .plans-aside-list'))[0] ?? '';
      check(`${t}: Needs review: the plan left out, and the answer's own diagnostics`, review.includes('“Who books the field van for next week?” — left out because no valid N or S reference in "from".')
        && review.includes('A deferred item names no note of the input ("N12").')
        && !review.includes('Project-memory items outside this meeting'), review);
      await page.locator('#plans .plans-aside-toggle', { hasText: 'Needs review (2)' }).click();
      check(`${t}: an unchecked step has no Add`, await page.locator('#plans .plan:nth-child(2) .plan-flag', { hasText: 'Unchecked' }).count() === 1 && await page.locator('#plans .plan:nth-child(2) .plan-add').count() === 0);
      check(`${t}: an unchecked answer is not an answer`, (await text(page, '#plans .plan:nth-child(3) .plan-answer'))[0]?.startsWith('Unchecked:'));
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      const failed = (await text(page, '#plans .plan:nth-child(2) .plan-review'))[0] ?? '';
      check(`${t}: the failed source and why, and a reference left out`, failed.includes('quote not found within 5 lines of line 88 in what was read') && failed.includes('References: unknown references S99 left out.'), failed);
      await shoot(page, `mixed-${config}-review`);
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      await page.locator('#plans .plan:nth-child(3) .plan-chev').click();
      const over = (await text(page, '#plans .plan:nth-child(3) .plan-details'))[0] ?? '';
      check(`${t}: an estimate over 20 min has no Explore further, and says why`, over.includes('estimated at 30 min, more than the 20-minute limit')
        && await page.locator('#plans .plan:nth-child(3) button', { hasText: 'Explore further' }).count() === 0, over.slice(0, 200));
      await page.locator('#plans .plan:nth-child(3) .plan-chev').click();
      break;
    }
    case 'nothing': check(`${t}: nothing to plan`, (await text(page, '#plans .plans-panel'))[0]?.startsWith('The notes leave no open decision')); break;
    case 'all-failed': check(`${t}: all plans failed checks`, (await text(page, '#plans .plans-panel'))[0]?.startsWith('No plan passed the source checks') && await page.locator('#plans .plans-aside-toggle', { hasText: 'Needs review (3)' }).count() === 1); break;
    case 'stopped': check(`${t}: stopped before the end`, banners.startsWith('Stopped before the end, at the 5-minute limit, before the plans were written.'), banners); break;
    case 'closed': check(`${t}: stopped when the app closed`, banners.startsWith('Stopped before the end, when HearAlong closed'), banners); break;
    case 'failed': check(`${t}: failed, the last good plans shown`, /^Planning again did not finish: The model's answer could not be read as plans\. The plans below are the ones from /.test(banners) && (await rowHeights(page)).length === 3, banners); break;
    case 'stale':
    case 'stale-materials': {
      check(`${t}: quiet stale bar link`, stale === 'Made before the notes changed', stale);
      await page.locator('#plans .plans-stale').click();
      const menu = await page.locator('#plans-menu').innerText();
      check(`${t}: stale detail and Plan again in Options`, menu.includes(state === 'stale' ? 'Made before the notes changed.' : 'Made before the materials changed.')
        && await page.locator('#plans-menu [data-focus="plan-again"]').count() === 1, menu);
      await shoot(page, `${state}-${config}-menu`);
      await page.keyboard.press('Escape');
      break;
    }
    case 'explored': {
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      const details = (await text(page, '#plans .plan-details'))[0] ?? '';
      check(`${t}: revised by Explore further, with the earlier version`, /Revised by Explore further, .* \(14 min\)\./.test(details) && await page.locator('#plans .plan-details button', { hasText: /^Earlier version$/ }).count() === 1, details.slice(0, 80));
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      break;
    }
    case 'explore-stopped': check(`${t}: Explore further stopped at 20 min`, banners.includes('Explore further on “Alarm calls apart from song” stopped at the 20-minute limit; the plan is unchanged'), banners); break;
    case 'newer': {
      check(`${t}: a newer version exists`, banners.startsWith('Planning again finished after a newer version appeared (Explore further, '), banners);
      await page.locator('#plans button', { hasText: 'Show the kept plans' }).click();
      check(`${t}: the kept plans, without Add`, await page.locator('#plans .plan-add').count() === 0 && (await rowHeights(page)).length === 3);
      await shoot(page, `newer-${config}-kept`);
      await page.locator('#plans button', { hasText: 'Back to the current plans' }).click();
      break;
    }
    case 'refused': {
      check(`${t}: a step over 600 characters: no Add, flagged`, await page.locator('#plans .plan:nth-child(2) .plan-flag', { hasText: 'Too long to add' }).count() === 1
        && await page.locator('#plans .plan:nth-child(2) .plan-add').count() === 0);
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      check(`${t}: the reason in the details`, ((await text(page, '#plans .plan:nth-child(2) .plan-details .plan-warn'))[0] ?? '').startsWith('Not added: This step is too long for a to-do (607 characters; at most 600).'));
      await shoot(page, `refused-${config}-too-long`);
      await page.locator('#plans .plan:nth-child(2) .plan-chev').click();
      // From the keyboard: Add on the last plan, refused because the meeting moved; the focus stays on that plan.
      await page.locator('#plans .plans-more button').click();
      await page.locator('#plans .plan:nth-child(6) .plan-row .plan-add').focus();
      await page.keyboard.press('Enter');
      await page.locator('#plans .plans-banner', { hasText: 'the meeting is now in “Field acoustics”' }).waitFor();
      check(`${t}: refused after a move: no Add left, and why`, await page.locator('#plans .plan-add').count() === 0);
      check(`${t}: the authoritative refusal is said once`, await page.locator('#plans .plans-banner').count() === 1);
      check(`${t}: the focus stays on the plan`, await page.evaluate(() => document.activeElement?.getAttribute('data-focus') === 'chev:p6'));
      await shoot(page, `refused-${config}-moved`);
      await page.locator('#plans .plans-more button').click();
      break;
    }
    case 'moved': check(`${t}: made in another project: no Add, and why`, await page.locator('#plans .plan-add').count() === 0 && banners.includes('These plans were made in “Bird-call detector”; the meeting is now in “Field acoustics”.'), banners); break;
    case 'no-project': check(`${t}: no project: no Add, and the hint`, await page.locator('#plans .plan-add').count() === 0 && banners.includes('Put this meeting in a project (meeting menu) to add steps to its to-dos.'), banners); break;
  }
}

async function openFirst(page: Page, name: string) {
  await page.locator('#plans .plan-chev').first().click();
  await page.locator('#plans .plan-cite').first().click();
  await shoot(page, name);
  await page.locator('#plans .plan-cite').first().click();
  await page.locator('#plans .plan-chev').first().click();
}

/** Every row and every source open at once: still nothing clipped or past the edge. */
async function openAll(page: Page, t: string, name: string) {
  if (await page.locator('#plans .plans-more button[aria-expanded="false"]').count()) await page.locator('#plans .plans-more button').click();
  for (let i = 0; i < 20 && await page.locator('#plans .plan-chev[aria-expanded="false"]').count(); i++) await page.locator('#plans .plan-chev[aria-expanded="false"]').first().click();
  for (let i = 0; i < 60; i++) {
    const closed = page.locator('#plans .plan-details button[aria-expanded="false"]');
    if (!await closed.count()) break;
    await closed.first().click();
  }
  await geometry(page, `${t} (all open)`);
  await shoot(page, name);
  await page.goto(page.url());
  await page.locator('#plans:not([hidden]) .plans-content > *').first().waitFor();
}

/** Clicks every control in the section once (opening rows reveals more), and checks that each one does something. */
async function clickEverything(page: Page, t: string, counts: () => { downloads: number; popups: number }) {
  // Exercise Download before the walk can start a new run and close its menu.
  if (await page.locator(':is(#plans, #plans-options-slot) [data-focus="options"]').count()) {
    await page.locator(':is(#plans, #plans-options-slot) [data-focus="options"]').click();
    if (await page.locator('#plans-menu [data-focus="download"]').count()) {
      const downloaded = page.waitForEvent('download');
      await page.locator('#plans-menu [data-focus="download"]').click();
      await downloaded;
    } else await page.keyboard.press('Escape');
  }
  const done = new Set<string>();
  const silent: string[] = [];
  let clicked = 0;
  const signature = async () => JSON.stringify([await page.evaluate(() => [document.getElementById('plans')!.innerHTML, document.getElementById('plans-options-slot')!.innerHTML,
    document.querySelector('#plans [role="status"][aria-live]')?.textContent,
    document.querySelector('#transcript .cited')?.getAttribute('data-id') ?? null, document.body.dataset.tab]), counts()]);
  let guard = 0;
  for (; guard < 600; guard++) {
    const next = await page.evaluate(seen => {
      const key = (b: HTMLElement) => `${b.dataset.focus}|${b.textContent}|${b.getAttribute('aria-expanded')}`;
      const all = ([...document.querySelectorAll(':is(#plans, #plans-options-slot) button[data-focus], :is(#plans, #plans-options-slot) a[data-focus]')] as HTMLElement[])
        .filter(b => b.offsetParent && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true' && !seen.includes(key(b)));
      // Finish a head menu before trying rows behind it; then visit opened details before their closing controls.
      const c = all.find(b => b.closest('[role="menu"]')) ?? all.find(b => b.closest('.plan-details')) ?? all.find(b => b.getAttribute('aria-expanded') !== 'true') ?? all[0];
      return c ? { key: key(c), focus: c.dataset.focus!, label: c.textContent!.trim() || c.getAttribute('aria-label') || '' } : null;
    }, [...done]);
    if (!next) break;
    done.add(next.key);
    const before = await signature();
    const target = page.locator(`:is(#plans, #plans-options-slot) [data-focus="${next.focus.replace(/"/g, '\\"')}"]`).filter({ hasText: next.label.slice(0, 40) }).first();
    // A run that publishes while the walk goes on replaces the rows (their keys name the version): a control gone is skipped.
    try { await clickSettled(page, await target.count() ? target : page.locator(`:is(#plans, #plans-options-slot) [data-focus="${next.focus.replace(/"/g, '\\"')}"]`).first()); }
    catch { if (await page.locator(`:is(#plans, #plans-options-slot) [data-focus="${next.focus.replace(/"/g, '\\"')}"]`).count()) silent.push(`${next.label} (could not be clicked)`); continue; }
    clicked++;
    let changed = await signature() !== before;
    for (let i = 0; i < 15 && !changed; i++) { await page.waitForTimeout(100); changed = await signature() !== before; }
    if (!changed) silent.push(next.label);
    // "Show in the transcript" opens the transcript (compact: its tab); come back to the notes.
    if (!(await page.locator('#plans').isVisible())) await page.locator(await page.locator('#ctab-plans').isVisible() ? '#ctab-plans' : '#tab-plans').click();
  }
  check(`${t}: every control responds (${clicked} clicked)`, silent.length === 0 && guard < 600, guard >= 600 ? 'the walk did not finish' : silent.join(', '));
}

/** An action's busy flag stays on its original control even when closing the menu detaches it. */
async function clickSettled(page: Page, target: Locator) {
  const action = await page.evaluateHandle(() => {
    const state = { control: null as Element | null };
    const clicked = (event: Event) => { state.control = (event.target as Element).closest('[data-focus]'); };
    document.addEventListener('click', clicked, { capture: true, once: true });
    return { state, clicked };
  });
  try {
    await target.click({ timeout: 3000 });
    await page.waitForFunction(({ state }) => state.control?.getAttribute('aria-busy') !== 'true', action);
    // Add replaces its control immediately; its replacement carries the busy flag until the reply.
    await page.waitForFunction(() => !document.querySelector(':is(#plans, #plans-options-slot) [aria-busy="true"]'));
  } finally {
    await action.evaluate(({ clicked }) => document.removeEventListener('click', clicked, true));
    await action.dispose();
  }
}

async function shoot(page: Page, name: string) {
  // The pane scrolls inside itself; a tall enough window shows the whole section in one picture.
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => { const p = document.getElementById('plans')!; p.scrollIntoView({ block: 'start' }); return Math.ceil(p.getBoundingClientRect().height + 200); });
  if (height > size.height) await page.setViewportSize({ width: size.width, height: Math.min(height + 120, 6000) });
  await page.waitForTimeout(150);
  const path = join(outDir, `${name}.png`);
  await page.locator('#plans').screenshot({ path });
  shots.push(path);
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function lifecycleChecks(b: Browser) {
  const context = await b.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${app.url}/?plans-fixture=idle`);
    await page.locator('#tab-plans').click();
    await page.locator('#plans .plans-idle').waitFor();
    for (const [name, ok] of await plansLifecycleCheck(page)) check(name, ok);
  } catch (error) { check('lifecycle probes completed', false, (error as Error).message); }
  finally { await context.close(); }
}

/** Settings → Project: "Plan after the notes", off by default; it turns on and off. */
async function settingsCheck(b: Browser, meetingId: string) {
  for (const width of [1280, 390]) {
    const context = await b.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(id => { try { localStorage.setItem('meeting-id', id); } catch {} }, meetingId);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${app.url}/?plans-fixture=plans`);
      await page.locator('#meeting-project:not([hidden])').waitFor();
      await page.locator('#open-system').click();
      await page.locator('.settings-nav button[data-section="project"]').click();
      const box = page.locator('#plan-after-notes');
      await box.waitFor();
      check(`settings @${width}: Plan after the notes is off by default`, !(await box.isChecked()));
      await page.locator('label[for="plan-after-notes"]').click();
      await page.waitForTimeout(300);
      check(`settings @${width}: it turns on`, await box.isChecked());
      const path = join(outDir, `settings-${width}.png`);
      await page.locator('#settings').screenshot({ path }); shots.push(path);
      await page.locator('label[for="plan-after-notes"]').click();
      await page.waitForTimeout(300);
      check(`settings @${width}: and off`, !(await box.isChecked()) && await page.locator('#settings .inline-error').count() === 0);
      check(`settings @${width}: no page errors`, errors.length === 0, errors.join(' | '));
    } finally { await context.close(); }
  }
}

const failed = results.filter(r => r.startsWith('FAIL'));
console.log((process.env.ALL ? results : failed).join("\n"));
console.log(`${results.length - failed.length}/${results.length} passed · screenshots in ${outDir} (${shots.length})`);
process.exitCode = failed.length ? 1 : 0;
