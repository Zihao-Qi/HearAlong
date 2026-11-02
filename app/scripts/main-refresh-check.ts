// Real HTTP hangs before headers / during JSON, at startup and while recording. No user data or models.
import './check-env.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { testBrowser } from './test-browser.ts';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const before = 'The fictional seed library has twelve envelopes.';
const after = 'The fictional seed library now has twenty envelopes.';
type Evidence = { signals: AbortSignal[]; uploads: AbortSignal[]; tracks: MediaStreamTrack[]; stopped: number };
type FixtureWindow = Window & typeof globalThis & { evidence: Evidence };

export async function checkMainRefresh() {
  const directory = await mkdtemp(join(tmpdir(), 'main-refresh-'));
  const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true),
    recognizer: { async transcribe() { return { text: '', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1,
      audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }; }, close() {} },
    drafts: null, quick: null, heavy: null, notes: null, actions: null, board: null, plans: null });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // Only this fixture's served asset changes the deadline. No production timeout override or fake fetch/body.
  const fixtureSource = source.replace('AbortSignal.timeout(10000)', 'AbortSignal.timeout(1500)');
  const browser = await chromium.launch({ executablePath: testBrowser(), headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const failures: unknown[] = [];
  try {
    for (const initial of [false, true]) for (const phase of ['headers', 'body'] as const) {
      const name = `${initial ? 'first load (idle)' : 'transcript (recording)'}: hung ${phase}`;
      const meeting = app.store.createMeeting(`Fictional seed library — ${name}`);
      const seed = await app.store.addPcm(meeting.id, 'mic:fixture', 0, 0, 16000, Buffer.alloc(16000 * 4));
      app.store.completeChunk(seed.id, { text: before, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1,
        audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
      const segment = app.store.segments(meeting.id)[0];
      let armed = initial, hung = false, closed = false, active = 0, maximumActive = 0, gets = 0, ends = 0, uploads = 0;
      const paths: string[] = [], pageIds: string[] = [];
      let entered!: () => void;
      const hangEntered = new Promise<void>(r => { entered = r; });
      // A transparent loopback proxy keeps real page-session, routes and PCM uploads; only one segments reply hangs.
      const server = createServer((req, res) => {
        const path = new URL(req.url!, 'http://127.0.0.1').pathname;
        if (path === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fixtureSource); return; }
        if (path.endsWith('/pcm')) uploads++;
        if (path.endsWith('/pcm/end')) ends++;
        if (path.endsWith('/segments')) {
          gets++; paths.push(req.url!); pageIds.push(String(req.headers['x-page'] ?? ''));
          active++; maximumActive = Math.max(maximumActive, active);
          res.on('close', () => { active--; });
          if (armed && !hung) {
            hung = true;
            res.on('close', () => { closed = true; });
            // No end(), and no server-side release: the browser must abort the response itself.
            if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"meetingId":'); }
            entered(); return;
          }
        }
        const upstream = request(new URL(req.url!, app.url), { method: req.method, headers: { ...req.headers,
          host: new URL(app.url).host, ...(req.headers.origin ? { origin: app.url } : {}) } }, reply => {
          res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
        });
        upstream.on('error', () => res.destroy());
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
      });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const address = server.address();
        assert.ok(address && typeof address === 'object' && ![4318, 11434, 1234].includes(address.port));
        await context.addInitScript(id => {
          localStorage.setItem('meeting-id', id);
          const w = window as FixtureWindow;
          w.evidence = { signals: [], uploads: [], tracks: [], stopped: 0 };
          const fetch = window.fetch.bind(window);
          window.fetch = (input, options) => {
            const path = String(input).split('?')[0];
            if (path.endsWith('/segments')) w.evidence.signals.push(options?.signal as AbortSignal);
            if (path.endsWith('/pcm')) w.evidence.uploads.push(options?.signal as AbortSignal);
            return fetch(input, options);
          };
          const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async constraints => {
            const stream = await getUserMedia(constraints);
            w.evidence.tracks.push(...stream.getAudioTracks());
            for (const track of stream.getAudioTracks()) {
              const stop = track.stop.bind(track);
              track.stop = () => { w.evidence.stopped++; stop(); };
            }
            return stream;
          };
        }, meeting.id);
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'domcontentloaded' });
        const documentId = await page.evaluate(() => performance.timeOrigin);
        if (!initial) {
          await page.getByText(before, { exact: true }).waitFor();
          await page.locator('#start').click(); await page.locator('#start-mic').click();
          await page.locator('body.recording #stop').waitFor();
          await page.waitForFunction(() => (window as FixtureWindow).evidence.uploads.length > 0);
          armed = true;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([hangEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('hang not reached')), 6000); })]);
        } finally { clearTimeout(timer); }
        const hungIndex = gets - 1, uploadsBefore = uploads;
        assert.equal(await page.locator('body').evaluate(body => body.classList.contains('recording')), !initial);
        if (!initial) assert.equal(await page.getByText(before, { exact: true }).count(), 1, 'retain the transcript during a hang');
        assert.ok(app.store.applyEdits(segment.id, 0, after, []));
        // Only normal page initialization and the unchanged one-second poll can recover this transcript.
        await page.getByText(after, { exact: true }).waitFor({ timeout: 6000 });
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentId, 'no reload');
        assert.ok(closed, 'timeout closes the actual hung HTTP request/body');
        assert.equal(maximumActive, 1, 'the guard spans the request and JSON body');
        assert.ok(gets > hungIndex + 1, 'a later tick retries');
        assert.ok(!paths[hungIndex + 1].includes('?have='), 'failed refresh resets the transcript delta');
        assert.ok(pageIds.every(id => id && id === pageIds[0]), 'pageRequest retains X-Page identity');
        const evidence = await page.evaluate(index => {
          const e = (window as FixtureWindow).evidence;
          return { aborted: e.signals[index]?.aborted, stopped: e.stopped, live: e.tracks.every(t => t.readyState === 'live'),
            uploadsIndependent: e.uploads.every(s => s && !s.aborted && !e.signals.includes(s)) };
        }, hungIndex);
        assert.ok(evidence.aborted, 'the failed refresh signal expires');
        assert.equal(evidence.stopped, 0, 'no microphone track stopped');
        assert.ok(evidence.live && evidence.uploadsIndependent, 'capture and upload signals are undisturbed');
        assert.equal(ends, 0, 'no source ended');
        assert.equal(await page.locator('body').evaluate(body => body.classList.contains('recording')), !initial);
        assert.equal(await page.locator('#quit-banner').isVisible(), false, 'a timeout is not a server quit');
        assert.deepEqual(errors, [], 'timeouts cause no uncaught page errors');
        if (initial) {
          assert.equal(uploads, 0, 'initial idle state is unchanged');
          // Detail loading and interval installation follow the initially awaited refresh: prove startup continued.
          await page.locator('#start:not([disabled])').waitFor();
          assert.ok(app.store.applyEdits(segment.id, 1, `${after} Startup recovered.`, []));
          await page.getByText(`${after} Startup recovered.`, { exact: true }).waitFor();
        } else {
          await page.waitForFunction(count => (window as FixtureWindow).evidence.uploads.length > count, uploadsBefore);
          assert.ok(uploads > uploadsBefore, 'PCM uploads continue through timeout and recovery');
          assert.match(await page.locator('#live-chip').innerText(), /Recording/);
          assert.doesNotMatch(await page.locator('#log').innerText(), /stopped|Connection lost|audio could not be saved|quitting/);
          await page.locator('#stop').click(); await page.locator('#stop').waitFor({ state: 'hidden' });
          assert.equal(ends, 1, 'only the explicit Stop ends the source');
        }
        console.log(`PASS main refresh recovery — ${name}`);
      } catch (error) {
        console.error(`FAIL main refresh recovery — ${name}: ${String(error)}`); failures.push(error);
      } finally {
        await context.close();
        server.closeAllConnections();
        await new Promise<void>((r, reject) => server.close(error => error ? reject(error) : r()));
      }
    }
  } finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
  if (failures.length) throw new AggregateError(failures, 'Main refresh recovery failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkMainRefresh();
