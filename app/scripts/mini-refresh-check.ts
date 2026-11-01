// Real HTTP hangs (before headers and during JSON), then recovery without reloading the mini page.
// Also called by mini-check. Standalone: node --experimental-strip-types scripts/mini-refresh-check.ts
import './check-env.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { testBrowser } from './test-browser.ts';

type FixtureWindow = Window & typeof globalThis & { miniRefresh: () => Promise<void>; miniErrors: string[]; refreshSignals: AbortSignal[] };
const before = 'The fictional seed library has twelve envelopes.';
const after = 'The fictional seed library now has twenty envelopes.';
const model = (text: string, from = 0) => ({
  recording: { meetingId: 'fictional-seeds', session: 1, clockMs: 1000, stopping: false, labelled: false,
    paragraphs: [{ key: 'seed-line', signature: `#seed-line:${text === before ? 0 : 1}`, speaker: null, text }],
    paragraphsFrom: from, paragraphsTag: 'fictional-tag', drafts: [], pending: [], card: null, notices: [] },
});

export async function checkMiniRefresh() {
  // Only this disposable HTTP fixture rewrites the served source; production has no external timeout setting.
  const assets = new Map<string, string>(await Promise.all(['mini.html', 'mini.css', 'mini.js', 'live-shared.js', 'preview-composition.js'].map(async name => {
    let body = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    if (name === 'mini.js') body = body.replace('AbortSignal.timeout(5000)', 'AbortSignal.timeout(400)');
    return [`/${name}`, body] as const;
  })));
  const browser = await chromium.launch({ executablePath: testBrowser(), headless: true, timeout: 30_000 });
  const failures: unknown[] = [];
  try {
    for (const fallback of [false, true]) for (const phase of ['headers', 'body'] as const) {
      const name = `${fallback ? 'whole-meeting fallback' : 'incremental GET'}: hung ${phase}`;
      const context = await browser.newContext();
      let armed = false, hung = false, hangClosed = false, active = 0, maximumActive = 0;
      const requests: string[] = [];
      let entered!: () => void;
      const hangEntered = new Promise<void>(r => { entered = r; });
      const server = createServer((req, res) => {
        const url = new URL(req.url!, 'http://127.0.0.1');
        if (url.pathname === '/api/live') {
          requests.push(req.url!);
          active++; maximumActive = Math.max(maximumActive, active);
          res.on('close', () => { active--; });
          if (armed && !hung && fallback && url.searchParams.has('have')) {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(model(before, 2)));
          } else if (armed && !hung) {
            hung = true;
            res.on('close', () => { hangClosed = true; });
            // Headers really reach Chromium; JSON parsing then waits forever for the rest of this body.
            if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"recording":'); }
            entered();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(model(armed ? after : before)));
          }
          return;
        }
        const body = assets.get(url.pathname);
        res.writeHead(body ? 200 : 404, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html' });
        res.end(body ?? '');
      });
      try {
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        assert.ok(![4318, 11434, 1234].includes(address.port));
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
          const w = window as FixtureWindow;
          w.refreshSignals = [];
          const original = window.fetch.bind(window);
          window.fetch = (input, options) => {
            if (String(input).startsWith('/api/live')) w.refreshSignals.push(options?.signal as AbortSignal);
            return original(input, options);
          };
        });
        await page.goto(`http://127.0.0.1:${address.port}/mini.html`);
        await page.getByText(before, { exact: true }).waitFor();
        const baselineRequests = requests.length;
        const documentId = await page.evaluate(() => performance.timeOrigin);
        armed = true;
        await page.evaluate(() => { (window as FixtureWindow).miniRefresh().catch(() => {}); });
        // A bounded event wait, not polling: this server will never release the hanging response itself.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([hangEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('hang not reached')), 5000); })]);
        } finally { clearTimeout(timer); }
        const hungRequests = requests.length;
        assert.equal(hungRequests - baselineRequests, fallback ? 2 : 1);
        await page.evaluate(async () => {
          const w = window as FixtureWindow;
          await Promise.all([w.miniRefresh(), w.miniRefresh(), w.miniRefresh()]);
        });
        assert.equal(requests.length, hungRequests, 'concurrent miniRefresh calls must skip the busy refresh');
        assert.equal(await page.getByText(before, { exact: true }).count(), 1, 'keep the previous transcript during the hang');
        // Only the page's unchanged one-second polling interval can request the recovered transcript now.
        await page.getByText(after, { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentId, 'no reload');
        assert.ok(hangClosed, 'timeout must close the hung HTTP request/body');
        assert.equal(maximumActive, 1, 'at most one live request at a time, including body reads');
        const signals = await page.evaluate(({ baselineRequests, fallback }) => {
          const w = window as FixtureWindow;
          const first = w.refreshSignals[baselineRequests];
          return { aborted: first?.aborted, shared: !fallback || first === w.refreshSignals[baselineRequests + 1], errors: w.miniErrors };
        }, { baselineRequests, fallback });
        assert.ok(signals.aborted, 'the failed refresh signal expires');
        assert.ok(signals.shared, 'both GETs share one overall refresh deadline');
        assert.deepEqual([...errors, ...signals.errors], [], 'timeouts cause no uncaught page errors');
        assert.ok(requests.at(-1)?.includes('have=fictional-tag'), 'retry retains the last good transcript tag');
        console.log(`PASS mini refresh recovery — ${name}`);
      } catch (error) {
        console.error(`FAIL mini refresh recovery — ${name}: ${String(error)}`);
        failures.push(error);
      } finally {
        await context.close();
        server.closeAllConnections();
        await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r()));
      }
    }
  } finally { await browser.close(); }
  if (failures.length) throw new AggregateError(failures, 'Mini refresh recovery failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkMiniRefresh();
