// Hands-on check of the mini view (M7 step 1; since the native window, docs/design/M7-native-mini.md, Chrome's window holds the
// mini page /mini.html in a frame): records from a spoken file as the microphone, opens the mini view, and clicks and measures
// everything in it, as the user would. Without the helper (as here), the Mini view button opens Chrome's window. No cloud model is called: the board uses a scripted quick model.
// Usage: node --experimental-strip-types scripts/mini-check.ts <speech.wav> <them.wav> [outDir=artifacts/mini-view]
// speech.wav is the microphone ("Me"); them.wav plays in a stand-in meeting tab ("Them") for the online part.
// The speech file must be 16 kHz mono (for example: say -o s.aiff "…" && afconvert -f WAVE -d LEI16@16000 -c 1 s.aiff s.wav).
import './check-env.ts';
import { testBrowser } from './test-browser.ts';
import { chromium, type Frame, type Page, type Response, type Route } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { LiveDrafts } from '../src/drafts.ts';

const [speech, them, out = 'artifacts/mini-view'] = process.argv.slice(2);
if (!speech || !them) throw new Error('Usage: mini-check.ts <speech.wav> <them.wav> [outDir]');
const outDir = resolve(out);
// A scripted quick model for the board: one question card citing the first new line.
const board = async (message: string) => {
  const line = message.split('\n').find(l => /^S\d+ \[[^\]]+\] NEW /.test(l))!;
  const ref = line.split(' ')[0];
  const quote = line.replace(/^S\d+ \[[^\]]+\] NEW /, '').split(' ').slice(0, 6).join(' ');
  return { text: JSON.stringify({ items: [{ type: 'action', text: 'Pack twelve seed-library envelopes with marigold seeds, stamp the sowing month on each flap, and place them in the blue pickup tray.', cites: [ref], quote, confidence: 'high', materials: false, nonProject: false }] }),
    ms: 1, attempts: 1, stopReason: 'stop', aborted: false, usages: [] };
};
const results: string[] = [], errors: string[] = [];
let currentStep = 'startup', finishing = false, deadlineExpired = false, timer: ReturnType<typeof setTimeout>;
let rejectDeadline!: (error: Error) => void;
const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
// Playwright timeouts do not cover evaluate(), response bodies, route removal or browser/server close.
// This independent deadline also covers preparatory work between assertions, even if a local catch swallows a timeout.
function step(name: string, ms = 60_000) {
  if (finishing) throw new Error('mini-check has entered cleanup');
  clearTimeout(timer); currentStep = name;
  console.log(`STEP ${name} (${ms} ms limit)`);
  timer = setTimeout(() => { deadlineExpired = true; rejectDeadline(new Error(`mini-check step "${name}" timed out after ${ms} ms`)); }, ms);
}
const check = (name: string, ok: boolean, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`;
  results.push(line); console.log(line); step(`after ${name}`);
};
async function bounded<T>(name: string, work: () => Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`mini-check step "${name}" timed out after ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
let closeBrowser = async () => {}, closeServer = async () => {}, removeDirectory = async () => {};
async function run() {
  step('create isolated fixture');
  await mkdir(outDir, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'meeting-mini-'));
  removeDirectory = () => rm(directory, { recursive: true, force: true });
  const app = await startServer({ directory, port: 0, quick: null, heavy: null, board, setup: await dashboardSetup(directory, true),
    recognizer: { async transcribe() { return { text: 'The fictional seed library will pack twelve marigold envelopes for the spring workshop. Volunteers will label each envelope and place it in the blue pickup tray.',
      backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 20, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} },
    drafts: new LiveDrafts({ modelPath: 'unused', workerScript: new URL('../test/fixtures/fake-stream-worker.ts', import.meta.url) }),
  });
  closeServer = () => app.close();
  step('launch test browser and start recording');
  const browser = await chromium.launch({
    executablePath: testBrowser(), headless: true, timeout: 30_000,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(speech)}`],
  });
  closeBrowser = () => browser.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);
  // Keeps the page's answer to Chrome's offer to open the window by itself (automatic Picture-in-Picture), to offer it by hand.
  await context.addInitScript(() => {
    const session = navigator.mediaSession;
    const set = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => { if (action as string === 'enterpictureinpicture') (window as unknown as { autoPip: unknown }).autoPip = handler; set(action, handler); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#meeting-button').click();
  await page.locator('#new-meeting').click();
  await page.locator('#meeting-name').waitFor();
  await page.keyboard.press('Enter');
  await page.locator('#start').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  check('no Mini view button before recording', await page.locator('#mini-view').isHidden());
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#mini-view').waitFor({ state: 'visible', timeout: 15_000 });
  const header = await page.locator('.topbar-right > :visible').evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
  check('header: Mini view on the same row as Stop', Math.max(...header) - Math.min(...header) <= 1, header.join(','));

  // By default the mini window opens only from the Mini view button, not when the user leaves the app. The helper's window is
  // faked here: the page asks about it as the helper does, so the app's page tells the server when it is left.
  const leave = async () => {
    const asked = page.waitForResponse(r => r.url().endsWith('/api/live/mini') && r.request().postDataJSON()?.action === 'away', { timeout: 5000 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete (document as { hidden?: boolean }).hidden;
    });
    return (await (await asked).json()).state as string;
  };
  const shown = () => page.evaluate(async () => (await (await fetch('/api/live/window')).json()).show as boolean);
  const miniSetting = async (on: boolean) => {
    await page.locator('#open-system').click();
    await page.locator('#settings .settings-nav button[data-section="mini"]').click();
    const saved = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
    if (await page.locator('#mini-by-itself').isChecked() !== on) await page.locator('#mini-by-itself').click();
    const reply = await (await saved).json();
    await page.locator('#settings').screenshot({ path: join(outDir, `settings-mini-${on ? 'on' : 'off'}.png`) });
    await page.locator('#close-settings').click();
    return reply.miniOpensItself === on && await page.locator('#mini-by-itself').isChecked() === on;
  };
  step('check helper visibility and mini opening settings');
  await page.evaluate(() => { (window as unknown as { helper: unknown }).helper = setInterval(() => void fetch('/api/live/window'), 500); });
  await page.waitForTimeout(2500); // the app's page hears of the helper with its next transcript poll
  check('setting off by default: leaving the app does not open the mini window', await leave() === 'auto' && !await shown() && await page.locator('#mini-view').isVisible());
  check('Settings: turning on "Open the mini window by itself" is saved', await miniSetting(true));
  check('setting on: leaving the app opens it', await leave() === 'open' && await shown());
  await page.locator('#mini-view').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  check('setting on: the Mini view button hides while it is open', await page.locator('#mini-view').isHidden());
  const helperSession = await page.evaluate(async () => (await (await fetch('/api/live')).json()).recording.session as number);
  await page.evaluate(session => fetch('/api/live/mini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, action: 'closed' }) }), helperSession);
  check('closed by hand, it stays closed when the user leaves again', await leave() === 'closed' && !await shown());
  check('Settings: turning it off again is saved', await miniSetting(false));
  await page.evaluate(() => clearInterval((window as unknown as { helper: ReturnType<typeof setInterval> }).helper));
  await page.waitForTimeout(4500); // the helper counts as gone after 3 s; then the button opens Chrome's window again
  await page.locator('#mini-view').waitFor({ state: 'visible', timeout: 5000 });
  const pages = context.pages().length;
  await page.evaluate(() => (window as unknown as { autoPip?: () => void }).autoPip?.());
  await page.waitForTimeout(1500);
  check('setting off: Chrome\'s offer to open the window by itself is not taken', await page.evaluate(() => typeof (window as unknown as { autoPip?: unknown }).autoPip === 'function') && context.pages().length === pages);

  // Chrome's window (pip) holds the mini page in a frame (mf); sizes, keys and screenshots are the window's.
  let mf!: Frame;
  // The window's first /api/live reply: the paragraphs said before it opened (all but the last three stay out of its log).
  let firstLive!: Promise<{ recording: { paragraphs: unknown[] } | null }>;
  const fromMini = (r: Response) => { try { return new URL(r.url()).pathname === '/api/live' && r.frame().url().endsWith('/mini.html'); } catch { return false; } };
  const openMini = async (): Promise<Page> => {
    step('open mini window and read its first response');
    const opened = context.waitForEvent('page');
    firstLive = context.waitForEvent('response', { predicate: fromMini, timeout: 15_000 }).then(r => r.json(), () => ({ recording: null }));
    await page.locator('#mini-view').click();
    const win = await opened;
    await win.waitForSelector('iframe');
    await win.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('.status button'), null, { timeout: 10_000 });
    mf = win.frames().find(f => f.url().endsWith('/mini.html'))!;
    return win;
  };
  /** Whether a mini page shows the whole meeting as the server has it now: the same paragraphs, in order, with the same text. */
  const wholeMeeting = async (frame: Frame | Page) => {
    let last = '';
    for (let i = 0; i < 6; i++) {
      const seen = await frame.evaluate(async () => {
        const server = (await (await fetch('/api/live')).json()).recording?.paragraphs as { key: string; text: string }[] ?? [];
        const rows = ([...document.querySelectorAll('#m-scroll .ln')] as HTMLElement[]).map(r => ({ key: r.dataset.key, text: r.querySelector('.final')!.textContent }));
        return { same: JSON.stringify(rows) === JSON.stringify(server.map(p => ({ key: p.key, text: p.text }))), rows: rows.length, server: server.length };
      });
      last = `${seen.rows} rows, the server ${seen.server}`;
      if (seen.same && seen.server > 0) return { ok: true, detail: last };
      await new Promise(r => setTimeout(r, 700)); // a line may have come between the two
    }
    return { ok: false, detail: last };
  };
  /** The window's rows above its log and in it, and the split its first reply asks for. */
  const split = async () => {
    const first = (await firstLive).recording?.paragraphs.length ?? 0;
    const shown = await mf.evaluate(() => ({ earlier: document.querySelectorAll('#m-earlier .ln').length, log: document.querySelectorAll('#m-finals .ln').length }));
    return { ...shown, first, ok: shown.earlier === Math.max(0, first - 3) };
  };
  let pip = await openMini();
  check('the button hides while the mini view is open', await page.locator('#mini-view').isHidden());
  check('on opening, the focus is in the window, not on Stop', await mf.evaluate(() => document.activeElement?.id) === 'm-status');
  await mf.locator('.ln:not(:has(.empty))').first().waitFor({ timeout: 40_000 });
  check('lines arrive in the mini view', (await mf.locator('.ln').count()) >= 1);
  check('in-person recording: no speaker column', await mf.locator('.lines.plain').count() === 1);
  step('wait for the first scripted board card', 100_000);
  await mf.locator('.card:not([hidden])').waitFor({ timeout: 90_000 });
  check('the newest card shows as the pinned card', /ACTION · \d\d:\d\d/i.test(await mf.locator('.card .tag').innerText()), await mf.locator('.card .tag').innerText());

  // Layout at the narrowest, default and widest sizes: one-row status, nothing outside the window, no jumping between updates.
  const measure = (p: Page | Frame) => p.evaluate(() => {
    const win = document.documentElement.getBoundingClientRect();
    const outside = [...document.querySelectorAll('.status *, .card, .notice, .scroll, .latest *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > win.right + 0.5 || r.left < -0.5); }).map(e => e.className);
    const status = document.querySelector('.status')!.getBoundingClientRect();
    const mids = [...document.querySelectorAll('.status > *')].map(e => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
    const card = document.querySelector('.card')!.getBoundingClientRect();
    return { outside, statusH: status.height, oneRow: Math.max(...mids) - Math.min(...mids) <= 1, cardTop: Math.round(card.top), cardH: card.height, bottomGap: Math.round(innerHeight - card.bottom) };
  });
  // A quiet microphone, faked on the wire: the server's notices gain it, for the mini page (/api/live) and the app's chip (/segments).
  const quiet = { short: 'no sound from the mic for 1 min', text: 'No sound from the microphone for 1 min. Is it muted?' };
  const addQuiet = (list: { text: string }[] = []) => list.some(n => n.text === quiet.text) ? list : [...list, quiet];
  const liveApi = (url: URL) => url.pathname === '/api/live'; // with or without the paragraphs the page holds
  // Keep one owner for each response for the page's lifetime. Removing interception while fetch() is in flight can let
  // Chromium continue the request before this callback fulfills it ("Route is already handled"). Toggle fixture data instead.
  let quietEnabled = false;
  let heldSegments: { entered: () => void; released: Promise<void> } | undefined;
  await context.route(liveApi, async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (quietEnabled && body.recording) body.recording.notices = addQuiet(body.recording.notices);
    await route.fulfill({ response, json: body });
  });
  await page.route('**/segments*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const hold = new URL(route.request().url()).searchParams.has('mini-route-hold') ? heldSegments : undefined;
    if (hold) { hold.entered(); await hold.released; }
    if (quietEnabled) body.notices = addQuiet(body.notices);
    await route.fulfill({ response, json: body, headers: { ...response.headers(), ...(hold ? { 'x-mini-route-owner': 'fixture' } : {}) } });
  });
  const fakeQuiet = async () => { quietEnabled = true; };
  const unfakeQuiet = async () => { quietEnabled = false; };
  for (const [w, h] of [[260, 240], [360, 268], [640, 320]]) {
    await pip.setViewportSize({ width: w, height: h });
    const samples = [];
    for (let i = 0; i < 4; i++) { samples.push(await measure(mf)); await pip.waitForTimeout(1100); }
    const m = samples[0];
    check(`${w} px: status is one row, 40 px`, m.oneRow && Math.round(m.statusH) === 40, `${m.statusH}`);
    check(`${w} px: nothing sticks out`, m.outside.length === 0, m.outside.join(','));
    check(`${w} px: the card is 52 px at the bottom and never moves between updates`, new Set(samples.map(s => `${s.cardTop}/${s.cardH}/${s.bottomGap}`)).size === 1 && m.cardH === 52 && m.bottomGap === 8, samples.map(s => `${s.cardTop}/${s.cardH}/${s.bottomGap}`).join(' '));
    await pip.screenshot({ path: join(outDir, `mini-${w}.png`) });
  }
  await pip.setViewportSize({ width: 360, height: 268 });

  // A problem notice (a quiet source, faked on the wire): shown in the window and the chip, gone when the sound is back.
  await fakeQuiet();
  await mf.locator('.notice').waitFor({ timeout: 5000 });
  const withNotice = await measure(mf);
  check('quiet microphone: notice in the window', /No sound from the microphone for 1 min/.test(await mf.locator('.notice').innerText()));
  await page.locator('#live-chip').getByText(/no sound from the mic/).waitFor({ timeout: 3000 }).catch(() => {});
  check('quiet microphone: the chip says so', /no sound from the mic/.test(await page.locator('#live-chip').innerText()), await page.locator('#live-chip').innerText());
  check('the notice does not move the card', withNotice.cardTop === (await measure(mf)).cardTop && withNotice.bottomGap === 8);
  await pip.screenshot({ path: join(outDir, 'mini-notice.png') });
  await unfakeQuiet();
  await mf.locator('.notice').waitFor({ state: 'detached', timeout: 5000 });
  await page.waitForFunction(() => !/no sound/.test(document.getElementById('live-chip')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => {});
  check('the notice goes when the sound is back', await mf.locator('.notice').count() === 0 && !/no sound/.test(await page.locator('#live-chip').innerText()));

  // Two problems at once in the smallest window (quiet microphone, and saving held back by slow replies): one notice box of at
  // most two lines; the card stays whole at the bottom and the lines keep some room.
  await pip.setViewportSize({ width: 260, height: 200 });
  await fakeQuiet();
  const slowPcm = async (route: Route) => { await new Promise(r => setTimeout(r, 6500)); await route.continue().catch(() => {}); }; // the upload may already be cancelled
  await page.route('**/pcm', slowPcm);
  // Several problems: their short forms, so all of them fit (the full texts are the box's title).
  await mf.waitForFunction(() => /^Saving behind · no sound from the mic/.test(document.querySelector('.notice')?.textContent ?? '') && /falling behind/.test((document.querySelector('.notice') as HTMLElement | null)?.title ?? ''), null, { timeout: 15_000 });
  const crowded = await measure(mf);
  const noticeH = await mf.locator('.notice').evaluate(e => e.getBoundingClientRect().height);
  const linesH = await mf.locator('#m-lines').evaluate(e => e.getBoundingClientRect().height);
  const clipped = await mf.locator('.notice span').evaluate(e => { const box = e.parentElement!.getBoundingClientRect(), r = e.getBoundingClientRect(); return r.bottom <= box.bottom - 5; });
  const allShown = await mf.locator('.notice span').evaluate(e => e.scrollHeight <= e.clientHeight + 1);
  check('two problems, 260 × 200: both fit, nothing cut', allShown);
  check('two problems, 260 × 200: one notice of at most two lines, nothing showing in its padding', await mf.locator('.notice').count() === 1 && noticeH <= 46 && clipped, `${noticeH}`);
  check('two problems, 260 × 200: the card stays whole at the bottom, the lines keep room', crowded.cardH === 52 && crowded.bottomGap === 8 && linesH >= 36, `card ${crowded.cardH}/${crowded.bottomGap}, lines ${linesH}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  // In one step: the chip's text is replaced at each poll.
  const chipText = await page.evaluate(() => { const e = document.querySelector('#live-chip .chip-text')!; return { cut: e.scrollWidth > e.clientWidth, ellipsis: getComputedStyle(e).textOverflow }; });
  check('390 px: a chip too narrow for its problems ends in an ellipsis', chipText.ellipsis === 'ellipsis', JSON.stringify(chipText));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForFunction(() => /^Recording · saving behind · no sound from the mic/.test(document.getElementById('live-chip')?.innerText ?? ''), null, { timeout: 5000 }).catch(() => {});
  const chip = await page.evaluate(() => { const e = document.getElementById('live-chip')!; return { text: e.innerText, title: e.title }; }); // in one step: it is redrawn at each poll
  check('two problems: the chip leads with them', /^Recording · saving behind · no sound from the mic/.test(chip.text) && /falling behind/.test(chip.title), `${chip.text} | ${chip.title}`);
  await pip.screenshot({ path: join(outDir, 'mini-two-problems.png') });
  step('detach slow PCM routes', 30_000);
  // Hold one segments response across upload-fixture removal. It must still be answered by its original owner, not
  // silently continued by removing all page interception. This deterministically exercises the former fulfill race.
  let entered!: () => void, release!: () => void;
  const heldReplyArrived = new Promise<void>(r => { entered = r; });
  heldSegments = { entered, released: new Promise<void>(r => { release = r; }) };
  try {
    await page.evaluate(() => {
      (window as any).miniRouteOwner = null;
      void fetch(`/api/meetings/${localStorage.getItem('meeting-id')}/segments?mini-route-hold=1`)
        .then(r => { (window as any).miniRouteOwner = r.headers.get('x-mini-route-owner') ?? 'server'; });
    });
    await heldReplyArrived;
    // Detach only this upload fixture. Keep the segments route registered until its replies have finished.
    await page.unroute('**/pcm', slowPcm);
    release();
    await page.waitForFunction(() => (window as any).miniRouteOwner !== null);
    check('removing slow uploads preserves ownership of an in-flight segments reply', await page.evaluate(() => (window as any).miniRouteOwner === 'fixture'));
  } finally { release(); heldSegments = undefined; }
  step('remove quiet fixtures', 30_000);
  await unfakeQuiet();
  step('wait for saving-behind and quiet notices to clear', 30_000);
  await mf.locator('.notice').waitFor({ state: 'detached', timeout: 20_000 });
  await pip.setViewportSize({ width: 360, height: 268 });

  // While the preview grows, the paragraphs above it stay put and are not re-added to the log (only a growing last one may change).
  await mf.locator('#m-scroll .ln').evaluateAll(rows => rows.forEach(r => { (r as HTMLElement).dataset.mark = '1'; }));
  const marked = await mf.locator('#m-scroll .ln').count();
  const draftHeights = new Set<number>();
  for (let i = 0; i < 6; i++) { draftHeights.add(await mf.locator('#m-drafts').evaluate(e => Math.round(e.getBoundingClientRect().height))); await pip.waitForTimeout(700); }
  const kept = await mf.locator('#m-scroll .ln[data-mark="1"]').count();
  check('the preview keeps one line per source while it changes', draftHeights.size === 1 && [...draftHeights][0] <= 20, [...draftHeights].join(','));
  check('unchanged paragraphs are kept, not re-added', kept >= marked - 1, `${kept} of ${marked} kept`);

  // Scrolling back through the meeting. Following, the newest line stays at the bottom with the previews below; scrolled up, it
  // stops following and "Back to latest" takes the previews' place; what the user reads never moves while lines arrive.
  const scrollState = () => mf.evaluate(() => {
    const s = document.getElementById('m-scroll')!;
    return { gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), back: !document.getElementById('m-latest')!.hidden, drafts: !document.getElementById('m-drafts')!.hidden };
  });
  const transcript = () => mf.evaluate(() => [...document.querySelectorAll('#m-scroll .ln')].map(e => `${(e as HTMLElement).dataset.signature}`).join('|'));
  const newLines = async (timeout = 40_000) => { const was = await transcript(); return mf.waitForFunction(w => [...document.querySelectorAll('#m-scroll .ln')].map(e => `${(e as HTMLElement).dataset.signature}`).join('|') !== w, was, { timeout }).then(() => true, () => false); };
  // The line at the top of the view, where it is, and whether any line is above it.
  const topRow = () => mf.evaluate(() => {
    const top = document.getElementById('m-scroll')!.getBoundingClientRect().top;
    const rows = [...document.querySelectorAll('#m-scroll .ln')] as HTMLElement[];
    const index = rows.findIndex(r => r.getBoundingClientRect().bottom > top);
    return { key: rows[index]?.dataset.key, y: rows[index]?.getBoundingClientRect().top ?? NaN, index };
  });
  const rowY = (key: string) => mf.evaluate(k => document.querySelector(`#m-scroll .ln[data-key="${k}"]`)?.getBoundingClientRect().top ?? NaN, key);
  step('wait for three scrollable transcript paragraphs', 130_000);
  await mf.waitForFunction(() => { const s = document.getElementById('m-scroll')!; return s.querySelectorAll('.ln').length >= 3 && s.scrollHeight > s.clientHeight + 200; }, null, { timeout: 120_000 });
  let state = await scrollState();
  check('following: the newest line at the bottom, the previews below it, no Back to latest', state.gap < 2 && !state.back && state.drafts, JSON.stringify(state));
  const followed = await newLines();
  await pip.waitForTimeout(100);
  state = await scrollState();
  check('following: a new line stays in view at the bottom', followed && state.gap < 2, JSON.stringify(state));
  await mf.locator('#m-scroll').hover();
  await pip.mouse.wheel(0, -160);
  await mf.waitForFunction(() => !document.getElementById('m-latest')!.hidden, null, { timeout: 3000 }).catch(() => {});
  state = await scrollState();
  check('scrolled up: it stops following, Back to latest in the previews\' place', state.gap > 100 && state.back && !state.drafts, JSON.stringify(state));
  const back = await mf.evaluate(() => {
    const b = document.getElementById('m-back')!.getBoundingClientRect(), s = document.getElementById('m-scroll')!.getBoundingClientRect(), c = document.getElementById('m-card')!.getBoundingClientRect();
    const text = document.querySelector('#m-scroll .final')!.getBoundingClientRect();
    return { h: b.height, clear: b.top >= s.bottom && b.bottom <= c.top, right: Math.round(innerWidth - b.right), textRight: Math.round(innerWidth - text.right), style: getComputedStyle(document.getElementById('m-back')!).textDecorationLine };
  });
  check('Back to latest: a 32 px text button between the lines and the card, covering no text', back.h === 32 && back.clear && back.style === 'underline', JSON.stringify(back));
  await pip.screenshot({ path: join(outDir, 'mini-scrolled.png') });
  let anchor = await topRow();
  const arrived = await newLines();
  await pip.waitForTimeout(100);
  const moved = await rowY(anchor.key!) - anchor.y;
  state = await scrollState();
  check('scrolled up: new lines arrive below without moving what the user reads', arrived && Math.abs(moved) < 0.5 && state.back, `${moved.toFixed(2)} px; ${JSON.stringify(state)}`);
  // A paragraph above the view changes (faked on the wire: a correction that makes it longer, then the real one again): the
  // lines in view still do not move.
  const grow = async (route: Route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('have'); // the whole meeting, to change its first paragraph
    const response = await route.fetch({ url: url.href });
    const body = await response.json();
    const first = body.recording?.paragraphs[0];
    if (first) { first.text += ' (corrected: a longer paragraph, as a correction can make it, so the lines below it would move down)'.repeat(3); first.signature += '+'; body.recording.paragraphsTag = 'fake'; }
    await route.fulfill({ response, json: body });
  };
  // The first paragraph above the view: the second one starts just above its top (as a user's scroll).
  await mf.evaluate(() => {
    const s = document.getElementById('m-scroll')!;
    const second = s.querySelectorAll('.ln')[1];
    if (second) s.scrollTop += second.getBoundingClientRect().top - s.getBoundingClientRect().top + 10;
  });
  await pip.waitForTimeout(300);
  anchor = await topRow();
  await context.route(liveApi, grow);
  await mf.waitForFunction(() => /corrected: a longer paragraph/.test(document.querySelector('#m-scroll .ln')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  const grown = await mf.evaluate(() => /corrected: a longer paragraph/.test(document.querySelector('#m-scroll .ln')?.textContent ?? ''));
  const movedGrow = await rowY(anchor.key!) - anchor.y;
  await context.unroute(liveApi, grow);
  await mf.waitForFunction(() => !/corrected: a longer paragraph/.test(document.querySelector('#m-scroll .ln')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  const movedBack = await rowY(anchor.key!) - anchor.y;
  check('scrolled up: a paragraph above the view growing and shrinking back does not move the lines in view',
    grown && anchor.index > 0 && (await scrollState()).back && Math.abs(movedGrow) < 0.5 && Math.abs(movedBack) < 0.5, `top line #${anchor.index}; ${movedGrow.toFixed(2)} / ${movedBack.toFixed(2)} px`);
  // Scrolled up, the window made narrower (the lines rewrap) and wider again, and a notice coming above the lines and going: the
  // line read stays where it is on screen.
  anchor = await topRow();
  await pip.setViewportSize({ width: 290, height: 268 });
  await pip.waitForTimeout(400);
  const movedNarrow = await rowY(anchor.key!) - anchor.y;
  await pip.setViewportSize({ width: 360, height: 268 });
  await pip.waitForTimeout(400);
  const movedWide = await rowY(anchor.key!) - anchor.y;
  anchor = await topRow();
  await fakeQuiet();
  await mf.locator('.notice').waitFor({ timeout: 5000 });
  await pip.waitForTimeout(200);
  const movedNotice = await rowY(anchor.key!) - anchor.y;
  await unfakeQuiet();
  await mf.locator('.notice').waitFor({ state: 'detached', timeout: 5000 });
  await pip.waitForTimeout(200);
  const movedGone = await rowY(anchor.key!) - anchor.y;
  state = await scrollState();
  const layoutMoves = [movedNarrow, movedWide, movedNotice, movedGone];
  check('scrolled up: narrower, wider, a notice coming and going: the line read does not move', layoutMoves.every(m => Math.abs(m) < 1) && state.back,
    `${layoutMoves.map(m => m.toFixed(2)).join(' / ')} px`);
  // A selection in the lines is kept while new lines arrive, and the selected text stays where it is.
  // Selects a few words near the middle of the view, as a drag would (lower down if the point there is at the end of a line).
  const select = () => mf.evaluate(() => {
    const box = document.getElementById('m-scroll')!.getBoundingClientRect();
    for (let y = box.top + box.height / 2; y < box.bottom - 4; y += 9) {
      const at = document.caretRangeFromPoint(box.left + 30, y);
      if (!at || at.startContainer.nodeType !== Node.TEXT_NODE || at.startOffset + 8 > at.startContainer.textContent!.length) continue;
      const range = document.createRange();
      range.setStart(at.startContainer, at.startOffset);
      range.setEnd(at.startContainer, Math.min(at.startOffset + 24, at.startContainer.textContent!.length));
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      const row = at.startContainer.parentElement!.closest('.ln') as HTMLElement;
      return { key: row.dataset.key!, text: getSelection()!.toString(), y: row.getBoundingClientRect().top };
    }
    return { key: '', text: '', y: NaN };
  });
  const selected = await select();
  const selectionArrived = await newLines();
  await pip.waitForTimeout(1200);
  const keptText = await mf.evaluate(() => getSelection()!.toString());
  check('scrolled up: a selection is kept while new lines arrive', selected.text.length > 0 && keptText === selected.text && selectionArrived && Math.abs(await rowY(selected.key) - selected.y) < 0.5, `"${keptText}" of "${selected.text}", lines arrived: ${selectionArrived}, moved ${(await rowY(selected.key) - selected.y).toFixed(2)} px`);
  await pip.screenshot({ path: join(outDir, 'mini-selection.png') });
  // The server regroups the selected paragraph (faked on the wire: a late line from the other side splits it in two). While the
  // selection holds it, nothing shows twice; once the selection is gone, the two parts show, each once.
  let tail = '';
  const regroup = async (route: Route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('have');
    const response = await route.fetch({ url: url.href });
    const body = await response.json();
    const list = (body.recording?.paragraphs ?? []) as { key: string; signature: string; speaker: string | null; text: string }[];
    const at = list.findIndex(p => p.key === selected.key);
    const [speaker, lines] = at < 0 ? ['', []] : [list[at].signature.split('#')[0], list[at].signature.split('#')[1].split('|')];
    if (lines.length >= 2) {
      const words = list[at].text.split(' ');
      const half = Math.ceil(words.length / 2);
      tail = words.slice(half, half + 6).join(' ');
      list.splice(at, 1, { ...list[at], signature: `${speaker}#${lines[0]}`, text: words.slice(0, half).join(' ') },
        { key: 'split-off', signature: `${speaker}#${lines.slice(1).join('|')}`, speaker: list[at].speaker, text: words.slice(half).join(' ') });
      body.recording.paragraphsTag = 'fake';
    }
    await route.fulfill({ response, json: body });
  };
  // How often the words after the cut show in the paragraph and its split-off part (the speech repeats, so maybe more than once).
  const times = (probe: string) => mf.evaluate(([p, key]) => ({
    shown: ([...document.querySelectorAll(`#m-scroll .ln[data-key="${key}"] .final, #m-scroll .ln[data-key="split-off"] .final`)] as HTMLElement[])
      .reduce((n, e) => n + (e.textContent!.split(p).length - 1), 0),
    split: Boolean(document.querySelector('#m-scroll .ln[data-key="split-off"]')),
  }), [probe, selected.key]);
  await context.route(liveApi, regroup);
  await pip.waitForTimeout(2500);
  const heldSplit = await times(tail);
  const heldSelection = await mf.evaluate(() => getSelection()!.toString());
  await mf.evaluate(() => getSelection()!.removeAllRanges());
  await mf.waitForFunction(() => Boolean(document.querySelector('#m-scroll .ln[data-key="split-off"]')), null, { timeout: 5000 }).catch(() => {});
  const freedSplit = await times(tail);
  await context.unroute(liveApi, regroup);
  await mf.waitForFunction(() => !document.querySelector('#m-scroll .ln[data-key="split-off"]'), null, { timeout: 5000 }).catch(() => {});
  check('a selected paragraph regrouped: nothing twice while selected, the two parts once it is gone', Boolean(tail) && heldSelection === selected.text
    && heldSplit.shown > 0 && !heldSplit.split && freedSplit.split && freedSplit.shown === heldSplit.shown, `"${tail}": ${JSON.stringify(heldSplit)} then ${JSON.stringify(freedSplit)}`);
  // Select All: the selection's ends are outside the lines, but it takes them in: they are not redrawn under it.
  await mf.locator('#m-scroll .ln').evaluateAll(rows => rows.forEach(r => { (r as HTMLElement).dataset.mark = 'all'; }));
  const allRows = await mf.locator('#m-scroll .ln').count();
  await mf.evaluate(() => getSelection()!.selectAllChildren(document.body));
  // Until the server's paragraphs change (a window of audio is transcribed about every 24 s), and two polls more.
  const changedMeanwhile = await mf.evaluate(async () => {
    const now = async () => (await (await fetch('/api/live')).json()).recording.paragraphs.map((p: { signature: string }) => p.signature).join('|');
    const before = await now();
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await now() !== before) { await new Promise(r => setTimeout(r, 2000)); return true; }
    }
    return false;
  });
  const keptAll = await mf.evaluate(() => ({ marked: document.querySelectorAll('#m-scroll .ln[data-mark="all"]').length, selected: !getSelection()!.isCollapsed }));
  check('Select All: the lines are not redrawn under it while the meeting goes on', keptAll.selected && keptAll.marked === allRows && changedMeanwhile, `${keptAll.marked} of ${allRows} kept`);
  await mf.evaluate(() => getSelection()!.removeAllRanges());
  // Back to latest: following again, with the previews; the next line still at the bottom.
  await mf.locator('#m-back').click();
  state = await scrollState();
  check('Back to latest: at the newest line again, the previews back, the keyboard on the lines', state.gap < 2 && !state.back && state.drafts && await mf.evaluate(() => document.activeElement?.id) === 'm-scroll', JSON.stringify(state));
  await newLines();
  await pip.waitForTimeout(100);
  check('Back to latest: it follows the new lines again', (await scrollState()).gap < 2);
  // Following, a selection holds the view too (nothing moves under it); once it is gone, the view goes on following.
  const atLatest = await select();
  // A natural final can join the selected paragraph: its DOM is correctly frozen, so newLines() sees no change.
  // Deliver both growth there and a distinct final below it, independent of the audio's 45-second paragraph boundaries.
  const arrivalKey = 'following-selection-arrival';
  const followingArrival = async (route: Route) => {
    const url = new URL(route.request().url()); url.searchParams.delete('have');
    const response = await route.fetch({ url: url.href });
    const body = await response.json();
    if (body.recording) {
      const held = body.recording.paragraphs.find((p: { key: string }) => p.key === atLatest.key);
      if (!held) throw new Error('The selected paragraph is missing from the following fixture.');
      held.text += ' Volunteers finish another sentence in this paragraph.';
      held.signature += '|following-selection-growth:0';
      body.recording.paragraphs.push({ key: arrivalKey, signature: `#${arrivalKey}:0`, speaker: null,
        text: 'A new final line arrives below the selected seed-library instructions.' });
      body.recording.paragraphsFrom = 0; body.recording.paragraphsTag = arrivalKey;
    }
    await route.fulfill({ response, json: body });
  };
  await context.route(liveApi, followingArrival);
  const whileSelected = await mf.waitForFunction(key => Boolean(document.querySelector(`#m-scroll .ln[data-key="${key}"]`)), arrivalKey,
    { timeout: 40_000 }).then(() => true, () => false);
  check('following: a selection is kept and does not move while new lines arrive', whileSelected && await mf.evaluate(() => getSelection()!.toString()) === atLatest.text && Math.abs(await rowY(atLatest.key) - atLatest.y) < 0.5 && !(await scrollState()).back,
    JSON.stringify({ whileSelected, before: atLatest, text: await mf.evaluate(() => getSelection()!.toString()), moved: await rowY(atLatest.key) - atLatest.y, state: await scrollState() }));
  await mf.evaluate(() => getSelection()!.removeAllRanges());
  await mf.waitForFunction(() => { const s = document.getElementById('m-scroll')!; return s.scrollHeight - s.scrollTop - s.clientHeight < 2; }, null, { timeout: 3000 }).catch(() => {});
  check('following: once the selection is gone, the view is at the newest line again', (await scrollState()).gap < 2);
  await context.unroute(liveApi, followingArrival);
  await mf.locator(`[data-key="${arrivalKey}"]`).waitFor({ state: 'detached', timeout: 5000 });
  // Scrolling back down to the end resumes following, as Back to latest does.
  await mf.locator('#m-scroll').hover();
  await pip.mouse.wheel(0, -160);
  await mf.waitForFunction(() => !document.getElementById('m-latest')!.hidden, null, { timeout: 3000 }).catch(() => {});
  await pip.mouse.wheel(0, 5000);
  await mf.waitForFunction(() => document.getElementById('m-latest')!.hidden, null, { timeout: 3000 }).catch(() => {});
  state = await scrollState();
  check('scrolling back to the end resumes following', state.gap < 2 && !state.back && state.drafts, JSON.stringify(state));
  // Scrolled up at the narrowest and widest windows: nothing sticks out, the status and the card keep their heights.
  for (const [w, h] of [[260, 240], [640, 320]]) {
    await pip.setViewportSize({ width: w, height: h });
    await pip.waitForTimeout(300);
    await mf.locator('#m-scroll').hover();
    await pip.mouse.wheel(0, -160);
    await mf.waitForFunction(() => !document.getElementById('m-latest')!.hidden, null, { timeout: 3000 }).catch(() => {});
    const m = await measure(mf);
    const shownBack = await mf.evaluate(() => { const b = document.getElementById('m-back')!.getBoundingClientRect(); return !document.getElementById('m-latest')!.hidden && b.right <= innerWidth && b.height === 32; });
    check(`${w} px scrolled up: Back to latest inside, nothing sticks out, status 40 px, card 52 px at the bottom`, shownBack && m.outside.length === 0 && Math.round(m.statusH) === 40 && m.cardH === 52 && m.bottomGap === 8, `${m.outside.join(',')} ${m.statusH}/${m.cardH}/${m.bottomGap}`);
    await pip.screenshot({ path: join(outDir, `mini-scrolled-${w}.png`) });
    await mf.locator('#m-back').click();
  }
  await pip.setViewportSize({ width: 360, height: 268 });
  // What /api/live sends once a second: the whole meeting once, then only what changed at its end.
  const payload = await mf.evaluate(async () => {
    const whole = await (await fetch('/api/live')).text();
    const next = await (await fetch(`/api/live?have=${encodeURIComponent(JSON.parse(whole).recording.paragraphsTag)}`)).text();
    return { whole: whole.length, next: next.length, paragraphs: JSON.parse(whole).recording.paragraphs.length };
  });
  check('/api/live: after the first reply only the end of the meeting is sent again', payload.next < payload.whole || payload.paragraphs <= 1, `${payload.paragraphs} paragraphs: ${payload.whole} B whole, ${payload.next} B next`);

  // Keyboard: Tab reaches Stop, then the lines (they scroll by keyboard), then the card.
  await mf.locator('body').click({ position: { x: 3, y: 3 } }); // the focus search starts at the top left of the page
  await pip.keyboard.press('Tab');
  const first = await mf.evaluate(() => document.activeElement?.className);
  await pip.keyboard.press('Tab');
  const second = await mf.evaluate(() => document.activeElement?.id);
  await pip.keyboard.press('Tab');
  const third = await mf.evaluate(() => document.activeElement?.className);
  check('Tab order: Stop, the lines, then the card', first === 'stop' && second === 'm-scroll' && third === 'card', `${first}, ${second}, ${third}`);

  // The card opens on the Board in the app.
  await page.evaluate(() => { const w = window as unknown as { __focused: number }; w.__focused = 0; const focus = window.focus.bind(window); window.focus = () => { w.__focused++; focus(); }; });
  await mf.locator('.card').click();
  check('a card click asks the app to come forward, from the click', await page.evaluate(() => (window as unknown as { __focused: number }).__focused) === 1);
  check('a card click opens it on the Board', await page.waitForFunction(() => Boolean(document.activeElement?.closest('[data-card]')), null, { timeout: 3000 }).then(() => true, () => false));

  // Closing by hand: recording goes on; the button returns (with the focus, when the app had none) and opens it again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pip.close();
  await page.locator('#mini-view').waitFor({ state: 'visible', timeout: 3000 });
  check('closing the window keeps recording', /^Recording/.test(await page.locator('#live-chip').innerText()));
  check('after closing, the focus is on Mini view', await page.evaluate(() => document.activeElement?.id) === 'mini-view');
  pip = await openMini();
  check('it opens again', await mf.locator('.status .stop').count() === 1);
  // Opened during the meeting, it shows the meeting so far, but its log holds (and announces) only the last lines and new ones.
  await mf.locator('#m-scroll .ln').first().waitFor({ timeout: 5000 });
  const opened = await split();
  check('opened during the meeting: all but the last three paragraphs of its first reply above the log', opened.ok && opened.earlier > 0, JSON.stringify(opened));
  const whole = await wholeMeeting(mf);
  check('opened during the meeting: the whole meeting, in order, as the server has it', whole.ok, whole.detail);
  const atOpen = await mf.evaluate(() => { const s = document.getElementById('m-scroll')!; return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); });
  check('opened during the meeting: at the newest line', atOpen < 2, `${atOpen}`);
  // Opened when the server had no lines yet (faked: its first replies empty), then many arrive at once: all are new to this
  // window, so all go to the log (announced), none above it.
  await pip.close();
  await page.locator('#mini-view').waitFor({ state: 'visible' });
  const empty = async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.recording) Object.assign(body.recording, { paragraphs: [], paragraphsFrom: 0, paragraphsTag: '' });
    await route.fulfill({ response, json: body });
  };
  await context.route(liveApi, empty);
  pip = await openMini();
  await pip.waitForTimeout(1500);
  await context.unroute(liveApi, empty);
  await mf.locator('#m-scroll .ln').first().waitFor({ timeout: 5000 });
  const late = await split();
  check('opened before any lines, then several at once: all in the log, none above it', late.first === 0 && late.earlier === 0 && late.log > 3, JSON.stringify(late));

  // The recording header at narrow windows (compact layout): Mini view and Stop stay on one row and inside the window.
  await pip.close();
  await page.locator('#mini-view').waitFor({ state: 'visible' });
  for (const [w, h] of [[390, 844], [700, 800], [1024, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const box = (id: string) => page.locator(id).evaluate(e => { const r = e.getBoundingClientRect(); return { mid: Math.round(r.top + r.height / 2), right: r.right, left: r.left }; });
    const [mv, st] = [await box('#mini-view'), await box('#stop')];
    check(`${w} px header: Mini view and Stop on one row, inside the window`, mv.mid === st.mid && st.right <= w && mv.left >= 0, `${mv.mid}/${st.mid}, right ${Math.round(st.right)}`);
    const heights = await page.locator('#mini-view, #stop').evaluateAll(es => es.map(e => Math.round(e.getBoundingClientRect().height)));
    check(`${w} px header: Mini view as high as Stop`, heights[0] === heights[1], heights.join('/'));
    const settingsRight = await page.locator('#open-system').evaluate(e => e.getBoundingClientRect().right);
    check(`${w} px header: the controls end at the right edge`, w - settingsRight <= 24, `${Math.round(w - settingsRight)} px from the edge`);
    const name = await page.locator('#meeting-button').evaluate(e => e.getBoundingClientRect());
    const covered = await page.locator('.topbar-right > :visible').evaluateAll((es, n) => es.some(e => { const r = e.getBoundingClientRect(); return r.left < n.right && r.right > n.left && r.top < n.bottom && r.bottom > n.top; }), { left: name.left, right: name.right, top: name.top, bottom: name.bottom });
    check(`${w} px header: nothing covers the meeting name`, !covered);
    await page.screenshot({ path: join(outDir, `header-${w}.png`), clip: { x: 0, y: 0, width: w, height: 140 } });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  pip = await openMini();

  // Stop asks once: Keep recording returns; Stop recording ends the recording and closes the window.
  await mf.locator('.stop').click();
  const confirm = await mf.locator('.status button').evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); return `${Math.round(r.top)}:${Math.round(r.height)}`; }));
  check('Stop asks once: two buttons, one row, equal heights', confirm.length === 2 && confirm[0] === confirm[1], confirm.join(' '));
  await pip.setViewportSize({ width: 260, height: 240 });
  const clearance = await mf.locator('.keep').evaluate(e => innerWidth - e.getBoundingClientRect().right);
  check('260 px: Keep recording keeps 8 px or more from the edge', clearance >= 8, `${clearance}`);
  await pip.setViewportSize({ width: 360, height: 268 });
  check('the red dot stays while asking', await mf.locator('.status .dot').count() === 1);
  check('focus moves to Stop recording', await mf.evaluate(() => document.activeElement?.className) === 'stop-now');
  await pip.screenshot({ path: join(outDir, 'mini-confirm.png') });
  await mf.locator('.keep').click();
  check('Keep recording returns, recording continues', await mf.locator('.status .stop').count() === 1 && /^Recording/.test(await page.locator('#live-chip').innerText()));
  await mf.locator('.stop').click();
  await pip.keyboard.press('Escape');
  check('Escape is Keep recording', await mf.locator('.status .stop').count() === 1 && await mf.evaluate(() => document.activeElement?.className) === 'stop');
  // A mini page that stays open across two recordings of this meeting, as the helper's does, and misses the gap between them (its
  // requests fail meanwhile, as a hidden page's may be held back): it must still show the whole meeting in the second one.
  const retained = await context.newPage();
  await retained.goto(`${app.url}/mini.html`);
  await retained.locator('#m-scroll .ln').first().waitFor({ timeout: 10_000 });
  await page.bringToFront();
  let missing = false;
  await retained.route(liveApi, route => missing ? route.abort() : route.fallback());
  // Stop from the app's header while the mini view is asking (the end replies slowed down): the mini view only says it is
  // stopping; nothing in it can cancel or stop again.
  await mf.locator('.stop').click();
  missing = true;
  const delayedEnd = async (route: Route) => { await new Promise(r => setTimeout(r, 3000)); await route.continue(); };
  await page.route('**/pcm/end', delayedEnd);
  const closed = pip.waitForEvent('close');
  await page.locator('#stop').click();
  await mf.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('Stopping'), null, { timeout: 2500 }).catch(() => {});
  check('Stop from the app while asking: the mini view shows Stopping… with no buttons', (await mf.locator('.status').innerText()).includes('Stopping') && await mf.locator('.status button').count() === 0, await mf.locator('.status').innerText());
  await pip.screenshot({ path: join(outDir, 'mini-stopping.png') });
  await closed;
  await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });
  step('detach delayed end routes', 30_000);
  await page.unroute('**/pcm/end', delayedEnd);
  check('stopped: the window closed and the focus is on Start', await page.locator('#start').isVisible() && await page.locator('#mini-view').isHidden() && await page.evaluate(() => document.activeElement?.id) === 'start');
  // The same meeting recorded again: the kept page hears of it only now, with the tag of the first recording.
  const firstKeys = await retained.evaluate(() => ([...document.querySelectorAll('#m-scroll .ln')] as HTMLElement[]).map(r => r.dataset.key));
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor({ timeout: 15_000 });
  await page.waitForFunction(async () => Boolean((await (await fetch('/api/live')).json()).recording), null, { timeout: 15_000 });
  missing = false;
  await retained.waitForTimeout(2500);
  const resumed = await wholeMeeting(retained);
  const keptKeys = await retained.evaluate(keys => keys.every(k => document.querySelector(`#m-scroll .ln[data-key="${k}"]`)), firstKeys);
  check('a kept mini page across two recordings of a meeting (the gap missed): the whole meeting, the first recording\'s lines too', resumed.ok && keptKeys && firstKeys.length > 0, resumed.detail);
  await retained.close();
  await page.locator('#stop').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });

  // Online: the microphone is "Me" and a meeting tab is "Them". Chrome's tab picker needs a person, so getDisplayMedia is replaced
  // by a stand-in that plays them.wav as a tab's audio; everything after the call is the app's code.
  const themBytes = await readFile(resolve(them));
  await page.route('**/__them.wav', route => route.fulfill({ body: themBytes, contentType: 'audio/wav' }));
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await (await fetch('/__them.wav')).arrayBuffer());
      const player = ctx.createBufferSource(); player.buffer = buffer; player.loop = true;
      const dest = ctx.createMediaStreamDestination(); player.connect(dest); player.start();
      const canvas = document.createElement('canvas'); canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
      const video = canvas.captureStream(1).getVideoTracks()[0];
      Object.defineProperty(video, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      return new MediaStream([video, dest.stream.getAudioTracks()[0]]);
    };
  });
  await page.locator('#meeting-button').click();
  await page.locator('#new-meeting').click();
  await page.locator('#meeting-name').waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled, null, { timeout: 30_000 });
  await page.locator('#start').click();
  await page.locator('#start-online').click();
  await page.locator('#live-chip').getByText('mic + tab').waitFor({ timeout: 15_000 });
  await page.unroute('**/__them.wav'); // Playwright's interception, if left on, also catches the mini view's stylesheet
  pip = await openMini();
  check('online: the mini view is styled', await mf.locator('.status').evaluate(e => Math.round(e.getBoundingClientRect().height)) === 40);
  step('wait for scripted Me and Them paragraphs', 100_000);
  await mf.waitForFunction(() => { const labels = [...document.querySelectorAll('.lines:not(.plain) .who')].map(e => e.textContent); return labels.includes('Me') && labels.includes('Them'); }, null, { timeout: 90_000 });
  const rows = await mf.locator('.ln').evaluateAll(es => es.map(e => ({ who: e.querySelector('.who')!.textContent, them: e.querySelector('.who')!.classList.contains('them') })));
  check('online: lines labelled Me and Them, the first line named', rows[0].who !== '' && rows.some(r => r.who === 'Me') && rows.some(r => r.who === 'Them'), rows.map(r => r.who || '·').join(' '));
  check('online: Them labels in the Them colour', rows.filter(r => r.who === 'Them').every(r => r.them));
  await pip.setViewportSize({ width: 360, height: 268 });
  await pip.waitForTimeout(1200);
  await pip.screenshot({ path: join(outDir, 'mini-online.png') });
  // Two preview lines (Me and Them) are higher than Back to latest: scrolling up only a few pixels must not snap back to following.
  step('wait for scrollable online transcript', 100_000);
  await mf.waitForFunction(() => { const s = document.getElementById('m-scroll')!; return s.scrollHeight > s.clientHeight + 40; }, null, { timeout: 90_000 });
  const previews = await mf.evaluate(() => document.getElementById('m-drafts')!.getBoundingClientRect().height);
  for (const px of [3, 7]) {
    await mf.evaluate(by => { const s = document.getElementById('m-scroll')!; s.scrollTop = s.scrollHeight - s.clientHeight - by; }, px);
    await pip.waitForTimeout(1500);
    const s = await scrollState();
    check(`online, two previews (${Math.round(previews)} px): scrolled up ${px} px, it stays scrolled up with Back to latest`, s.back && !s.drafts && s.gap >= px - 1, JSON.stringify(s));
    await mf.locator('#m-back').click();
  }
  await mf.locator('.stop').click();
  const stopAt = Date.now();
  await mf.locator('.stop-now').click();
  check('Stop in the mini view: it says Stopping… at once', (await mf.locator('.status').innerText()).includes('Stopping'));
  await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });
  check('Stop in the mini view stops the app\'s recording through the server', true, `${((Date.now() - stopAt) / 1000).toFixed(1)} s to stopped`);
  // A quit (faked on the wire): the banner shows, nothing behind it can be reached, and Start cannot run.
  await page.route('**/api/status', async route => { const response = await route.fetch(); const body = await response.json(); await route.fulfill({ response, json: { ...body, shuttingDown: true } }); });
  await page.locator('#quit-banner').waitFor({ state: 'visible', timeout: 10_000 });
  const inert = await page.evaluate(() => [...document.body.children].filter(n => n.id !== 'quit-banner').every(n => (n as HTMLElement).inert));
  check('a quit: banner shown, the page behind it inert, Start disabled', inert && await page.locator('#start').isDisabled() && /quitting/.test(await page.locator('#quit-text').innerText()));
  step('detach quit fixture routes', 30_000);
  await page.unrouteAll({ behavior: 'wait' });
  check('no page errors', errors.length === 0, errors.join(' | '));
}
let cleanupFailed = false;
try {
  await Promise.race([run(), deadline]);
} catch (error) {
  const line = `FAIL ${currentStep}: ${(error as Error).message}`;
  results.push(line); console.error(line); console.error(error);
} finally {
  finishing = true;
  clearTimeout(timer!);
  for (const [name, close] of [['close test browser', closeBrowser], ['close fixture server', closeServer]] as const) {
    try { console.log(`STEP ${name} (10000 ms limit)`); await bounded(name, close); }
    catch (error) { cleanupFailed = true; results.push(`FAIL ${name}: ${(error as Error).message}`); console.error(error); }
  }
  // Timed-out startup/work may still own files even if its close hook was not installed yet.
  if (!cleanupFailed && !deadlineExpired) {
    try { await bounded('remove fixture directory', removeDirectory); }
    catch (error) { cleanupFailed = true; results.push(`FAIL remove fixture directory: ${(error as Error).message}`); console.error(error); }
  }
}
console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed; screenshots in ${outDir}`);
// A timed-out operation or cleanup must not keep Node alive on a connection until the suite's outer timeout.
if (cleanupFailed || deadlineExpired) process.exit(1);
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
