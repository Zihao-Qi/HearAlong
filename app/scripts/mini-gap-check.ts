// Regression check for mini reading anchors and browser scroll clamping (#69).
// Usage: MEETING_TEST_CHROME=<disposable Chromium> node --experimental-strip-types scripts/mini-gap-check.ts [outDir]
import './check-env.ts';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page, type Response } from 'playwright-core';
import { testBrowser } from './test-browser.ts';
import { miniLog, type PendingPreview } from '../public/preview-composition.js';
import { stamp } from '../public/live-shared.js';

type FixtureWindow = Window & typeof globalThis & { miniRefresh: () => Promise<void> };
type Case = { name: string; kind: 'row' | 'viewport' | 'render' | 'anchor' | 'anchor-top' | 'merge' | 'before-render' | 'following' | 'bottom' | 'back' | 'one-pixel'; amount?: number; up?: number };
const out = resolve(process.argv[2] ?? 'artifacts/mini-gap');
await mkdir(out, { recursive: true });
// Serve the unmodified production assets: no private-state getter or recorder is needed.
const assets = new Map<string, string>(await Promise.all(['mini.html', 'mini.css', 'mini.js', 'live-shared.js', 'preview-composition.js'].map(async name =>
  [`/${name}`, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')] as const)));
const paragraphs = Array.from({ length: 16 }, (_, i) => ({ key: `fictional-${i}`, signature: `#fictional-${i}:0`, speaker: 'Me',
  text: `Fictional seed tray ${i} holds marigolds.` }));
const pendingText = 'The fictional seed library volunteers will label twelve envelopes and arrange them in the blue pickup tray.';
// A newer Me final joins Me's open paragraph, whose START precedes the Them pending words.
// Use production composition to establish that a pending row really can be last in the log.
const longText = Array(12).fill(pendingText).join(' ');
const anchorFinals = [...paragraphs.map((p, i) => ({ id: p.key, source: 'fictional-mic', speaker: 'Me', revision: 0,
  startMs: i * 10_000, endMs: i * 10_000 + 50, text: p.text })),
{ id: 'fictional-newer-me', source: 'fictional-mic', speaker: 'Me', revision: 0, startMs: 151_000, endMs: 151_050, text: 'Fictional labels ready.' }];
const anchorPending: PendingPreview = { source: 'fictional-tab', speaker: 'Them', window: 'fictional-window', chunkId: 'tail',
  windowStartMs: 150_100, coveredUntilMs: 150_900, cutMs: 150_900, text: longText, behind: true,
  words: longText.split(' ').map((text, i) => ({ text, startMs: 150_100 + i * 2, endMs: 150_102 + i * 2 })) };
const anchorLog = miniLog(anchorFinals, [], [anchorPending]);
assert.equal(anchorLog.placements.length, 1);
assert.equal(anchorLog.placements[0].beforeKey, null);
const anchorParagraphs = anchorLog.paragraphs.map(p => ({ key: p.key, signature: p.signature, speaker: p.speaker ?? null, text: p.segments.map(s => s.text).join(' ') }));
let final = false, tallPending = false, liveRequests = 0, heldPolls = 0;
let holdNextLive: ((release: () => void) => void) | undefined;
const clockMs = (request: number) => 152_000 + request * 60_000;
const model = () => ({ recording: { meetingId: 'fictional-seeds', session: 1, clockMs: 152_000, stopping: false, labelled: true,
  paragraphs: [...(tallPending ? anchorParagraphs : paragraphs), ...(final ? [{ key: 'tail-final', signature: '#tail:0', speaker: 'Them', text: tallPending ? longText : 'Fictional seed tray ready.' }] : [])],
  paragraphsFrom: 0, paragraphsTag: final ? 'final' : 'pending',
  pending: final ? [] : [{ placements: tallPending ? anchorLog.placements : [{ key: 'pending-tail', chunkId: 'tail', speaker: 'Them', text: pendingText, beforeKey: null }] }],
  drafts: [{ speaker: 'Me', text: 'Fictional marigold preview.' }, { speaker: 'Them', text: 'Fictional aster preview.' }], card: null, notices: [] } });
const server = createServer((req, res) => {
  const path = new URL(req.url!, 'http://127.0.0.1').pathname;
  const reply = path === '/api/live' ? ++liveRequests : 0;
  const value = model();
  value.recording.clockMs = clockMs(reply); // unique visible acknowledgement that this reply finished render()
  const body = reply ? JSON.stringify(value) : assets.get(path);
  res.writeHead(body ? 200 : 404, { 'Content-Type': reply ? 'application/json' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
    ...(reply ? { 'X-Mini-Reply': String(reply) } : {}) });
  if (reply && holdNextLive) {
    const hold = holdNextLive;
    holdNextLive = undefined;
    heldPolls++;
    hold(() => { if (!res.writableEnded) res.end(body); });
    res.flushHeaders(); // refresh() is now busy parsing a deliberately unfinished poll body
  } else res.end(body ?? '');
});

function scrollSnapshot() {
  const s = document.getElementById('m-scroll')!, pane = s.getBoundingClientRect();
  const rows = s.querySelectorAll<HTMLElement>('.ln, .pending-ln'), tail = rows[rows.length - 1];
  return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight, gap: s.scrollHeight - s.scrollTop - s.clientHeight,
    back: !document.getElementById('m-latest')!.hidden, drafts: !document.getElementById('m-drafts')!.hidden,
    pending: s.querySelectorAll('.pending-ln').length, paneTop: pane.top, paneBottom: pane.bottom,
    tail: { key: tail.dataset.key, height: tail.getBoundingClientRect().height, top: tail.getBoundingClientRect().top, bottom: tail.getBoundingClientRect().bottom } };
}
const frameWorlds = new WeakMap<Page, { session: CDPSession; id: number }>();
// Fake-clock rAF callbacks do not wait for Chromium's rendering/scroll-event delivery. Keep the
// original two native frame waits in an isolated world, where the page's clock shim is not installed.
async function frames(page: Page) {
  let world = frameWorlds.get(page);
  if (!world) {
    const session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId: id } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'mini-gap-native-frames' });
    world = { session, id };
    frameWorlds.set(page, world);
  }
  const result = await world.session.send('Runtime.evaluate', { contextId: world.id, awaitPromise: true, returnByValue: true,
    expression: `(() => {
      if (!requestAnimationFrame.toString().includes('[native code]')) throw new Error('Native rAF required');
      return new Promise(resolve => requestAnimationFrame(a => requestAnimationFrame(b => resolve([a, b]))));
    })()` });
  assert.equal(result.exceptionDetails, undefined, 'native frame wait must not throw');
  const times = result.result.value as number[];
  assert.equal(times.length, 2, 'both native animation-frame callbacks must run while app timers are paused');
}
const liveReply = (response: Response) => new URL(response.url()).pathname === '/api/live';
async function rendered(page: Page, reply: Response) {
  await reply.finished();
  // HTTP completion alone is not enough: tick() updates this marker inside render(), whose synchronous
  // completion/finally runs before the locator can observe it. Thus refresh() has also cleared busy.
  await page.getByText(stamp(clockMs(Number(reply.headers()['x-mini-reply']))), { exact: true }).waitFor();
}
async function refresh(page: Page) {
  const before = liveRequests;
  await page.evaluate(() => (window as FixtureWindow).miniRefresh());
  assert.equal(liveRequests, before + 1, 'each explicit refresh must start one /api/live request');
  assert.equal(await page.locator('.clock').textContent(), stamp(clockMs(liveRequests)), 'explicit refresh must finish render');
}
async function intervalPoll(page: Page) {
  const before = liveRequests;
  const reply = page.waitForResponse(liveReply);
  await page.clock.fastForward(1000); // runs the unchanged setInterval(refresh, 1000), not miniRefresh()
  await rendered(page, await reply);
  assert.equal(liveRequests, before + 1, 'one interval tick must complete one /api/live request');
}
async function afterHeldPoll(page: Page, action: () => Promise<void>) {
  let release: (() => void) | undefined;
  holdNextLive = value => { release = value; };
  try {
    const response = page.waitForResponse(liveReply);
    await page.clock.fastForward(1000);
    const reply = await response;
    assert.ok(release, 'the automatic poll body must be held before attempting the action');
    release();
    release = undefined;
    await rendered(page, reply);
    await action(); // the clock is paused, so no other interval can start between draining and acting
  } finally { holdNextLive = undefined; release?.(); }
}
function shrinkRow(amount: number) {
  const row = document.querySelector<HTMLElement>('#m-scroll .pending-ln')!;
  row.style.height = `${row.getBoundingClientRect().height - amount}px`;
  row.style.overflow = 'hidden';
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const summaries: unknown[] = [], failures: unknown[] = [];
try {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object' && ![4318, 11434, 1234].includes(address.port));
  browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
  const cases: Case[] = [
    { name: 'lower row shrinks 8px while reading', kind: 'row', amount: 8 },
    { name: 'lower row shrinks 8px just before render', kind: 'before-render', amount: 8 },
    { name: 'scroll pane grows 8px while reading', kind: 'viewport', amount: 8 },
    { name: 'lower row shrinks 2px from gap 3', kind: 'row', amount: 2 },
    { name: 'scroll pane grows 2px from gap 3', kind: 'viewport', amount: 2 },
    { name: 'pending becomes a shorter final', kind: 'render' },
    { name: 'unchanged pending bottom anchor at gap 3', kind: 'anchor', up: 3 },
    { name: 'unchanged pending bottom anchor at gap 7', kind: 'anchor', up: 7 },
    { name: 'unchanged pending top anchor', kind: 'anchor-top' },
    { name: 'pending bottom anchor becomes final text', kind: 'merge' },
    { name: 'content shrinks while following', kind: 'following', amount: 8 },
    { name: 'keyboard End resumes following', kind: 'bottom', up: 40 },
    { name: 'Back resumes following', kind: 'back', up: 40 },
    { name: '1px scroll up keeps following', kind: 'one-pixel', up: 1 },
  ];
  for (const test of cases) {
    final = false; liveRequests = 0; heldPolls = 0; tallPending = ['anchor', 'anchor-top', 'merge'].includes(test.kind);
    const context: BrowserContext = await browser.newContext({ viewport: { width: 360, height: 268 } });
    context.setDefaultTimeout(5000);
    const page: Page = await context.newPage();
    const errors: string[] = [], observations: { phase: string; state: ReturnType<typeof scrollSnapshot> }[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const observe = async (phase: string) => {
      const state = await page.evaluate(scrollSnapshot);
      observations.push({ phase, state });
      return state;
    };
    try {
      await page.clock.install({ time: new Date('2025-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2025-01-02T00:00:00Z')); // before goto: no app timers exist yet
      const initial = page.waitForResponse(liveReply);
      await page.goto(`http://127.0.0.1:${address.port}/mini.html`);
      await rendered(page, await initial);
      await page.locator('#m-scroll .pending-ln').waitFor();
      await page.waitForFunction(() => { const s = document.getElementById('m-scroll')!; return s.scrollHeight > s.clientHeight + 100; });
      await frames(page);
      if (test.kind !== 'following') {
        await page.evaluate(({ kind, up }) => {
          const s = document.getElementById('m-scroll')!;
          const row = s.querySelector<HTMLElement>('.pending-ln')!;
          s.scrollTop = kind === 'anchor-top' ? s.scrollTop + row.getBoundingClientRect().top - s.getBoundingClientRect().top - 20
            : s.scrollHeight - s.clientHeight - (up ?? 3);
        }, test);
      }
      await frames(page);
      const before = await observe('before action');
      const following = ['following', 'bottom', 'back', 'one-pixel'].includes(test.kind);
      assert.equal(before.back, !['following', 'one-pixel'].includes(test.kind), 'initial follow state');
      if (test.kind === 'anchor' || test.kind === 'merge') {
        assert.ok(before.tail.top < before.paneTop && before.tail.bottom > before.paneBottom, 'pending row must span the pane (bottom anchor)');
      }
      if (test.kind === 'anchor-top') assert.ok(before.tail.top >= before.paneTop && before.tail.top < before.paneBottom, 'pending row starts inside pane (top anchor)');
      if (test.kind === 'row' || test.kind === 'following') {
        await page.evaluate(shrinkRow, test.amount!);
      } else if (test.kind === 'before-render') {
        // Resolve live JSON and force layout in the same microtask chain as render(), before a scroll event can run.
        // This exercises render's pre-update reconciliation separately from the scroll handler.
        await afterHeldPoll(page, async () => {
          const requests = liveRequests;
          const clamp = await page.evaluate(async amount => {
            const fetch = window.fetch;
            let movement: { before: number; after: number } | undefined;
            window.fetch = async (...args) => {
              const response = await fetch(...args), json = response.json.bind(response);
              response.json = async () => {
                const body = await json(), s = document.getElementById('m-scroll')!;
                const row = s.querySelector<HTMLElement>('.pending-ln')!, before = s.scrollTop;
                row.style.height = `${row.getBoundingClientRect().height - amount}px`;
                row.style.overflow = 'hidden';
                movement = { before, after: s.scrollTop }; // force the clamp before render consumes this reply
                return body;
              };
              return response;
            };
            try { await (window as FixtureWindow).miniRefresh(); }
            finally { window.fetch = fetch; }
            return movement;
          }, test.amount!);
          assert.ok(clamp && clamp.after < clamp.before, 'must clamp before render');
          assert.equal(liveRequests, requests + 1, 'before-render refresh must start one /api/live request');
        });
      } else if (test.kind === 'viewport') {
        await page.evaluate(amount => {
          const latest = document.getElementById('m-latest')!;
          latest.style.minHeight = '0'; // force the full 8px reduction past the button's 32px minimum
          latest.style.flexBasis = `${latest.getBoundingClientRect().height - amount}px`;
        }, test.amount!);
      } else if (test.kind === 'render' || test.kind === 'merge') {
        await afterHeldPoll(page, async () => {
          final = true;
          await refresh(page);
        });
      } else if (test.kind === 'bottom') {
        await page.locator('#m-scroll').focus();
        await page.keyboard.press('End'); // genuine keyboard input: top increases to reach bottom
        await frames(page);
        await page.locator('#m-latest').waitFor({ state: 'hidden' });
      } else if (test.kind === 'back') {
        await page.locator('#m-back').click();
      }
      await frames(page);
      await observe('after action');
      // Repeated explicit settles AND two ordinary one-second polls, with no model changes for the anchor cases.
      for (let i = 0; i < 3; i++) {
        if (i === 0 && (test.kind === 'anchor' || test.kind === 'anchor-top')) await afterHeldPoll(page, () => refresh(page));
        else await refresh(page);
        await frames(page);
        await observe(`settle ${i + 1}`);
      }
      if (test.kind === 'anchor' || test.kind === 'anchor-top') {
        for (let i = 0; i < 2; i++) {
          await intervalPoll(page);
          await frames(page);
          await observe(`poll ${i + 1}`);
        }
      }
      const expectedGap = test.kind === 'anchor' || test.kind === 'merge' ? test.up ?? 3
        : test.kind === 'anchor-top' ? before.gap : test.amount === 2 ? 1 : 0;
      const checked = test.kind === 'anchor' || test.kind === 'anchor-top' ? observations : observations.slice(1);
      for (const { phase, state } of checked) {
        const detail = `${test.name}, ${phase}: ${JSON.stringify(state)}`;
        assert.equal(state.back, !following, detail);
        assert.equal(state.drafts, following, detail);
        if (test.kind === 'one-pixel') assert.ok(state.gap >= 0 && state.gap <= 1, detail);
        else assert.equal(state.gap, expectedGap, detail);
        if (test.kind === 'anchor' || test.kind === 'anchor-top') {
          assert.equal(state.height, before.height, 'unchanged scroll height');
          assert.equal(state.client, before.client, 'unchanged client height');
          assert.equal(state.tail.height, before.tail.height, 'unchanged pending row height');
        }
      }
      if (test.kind === 'render' || test.kind === 'merge') assert.equal(observations.at(-1)!.state.pending, 0, 'pending row must be replaced');
      assert.deepEqual(errors, []);
      const anchor = test.kind === 'anchor' || test.kind === 'anchor-top';
      const held = anchor || ['before-render', 'render', 'merge'].includes(test.kind);
      assert.equal(heldPolls, held ? 1 : 0, 'controlled in-flight poll must have been exercised');
      assert.equal(liveRequests, anchor ? 7 : held ? 6 : 4, 'every claimed action/settle/poll must make its own request');
      const gaps = observations.map(o => o.state.gap);
      summaries.push({ name: test.name, passed: true, gaps, observations, liveRequests, heldPolls });
      console.log(`PASS ${test.name} — gaps ${gaps.join(', ')}; requests ${liveRequests}, held polls ${heldPolls}`);
    } catch (error) {
      failures.push(error);
      summaries.push({ name: test.name, passed: false, error: String(error), observations, errors, liveRequests, heldPolls });
      console.error(`FAIL ${test.name} — ${String(error)}`);
    } finally { await context.close(); }
  }
} finally {
  await writeFile(join(out, 'summary.json'), JSON.stringify(summaries, null, 2) + '\n');
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r()));
}
if (failures.length) throw new AggregateError(failures, `${failures.length} mini scroll regression(s)`);
