// Headless, fictional capture checks: no physical microphone, models, cloud, or external browser requests.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

assert.ok(process.env.MEETING_TEST_CHROME, 'Set MEETING_TEST_CHROME to a disposable test Chrome executable');
process.env.MEETING_CLOUD = '0';
const out = resolve(process.argv[2] ?? 'artifacts/capture-resilience');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'capture-resilience-'));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!fn()) { assert.ok(Date.now() < end, 'timed out waiting for capture evidence'); await sleep(50); }
};
const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true),
  recognizer: { async transcribe() { return { text: 'The fictional workshop will review the lantern inventory.', backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} },
  drafts: null, quick: null, heavy: null, actions: null, notes: null, board: null, plans: null });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cleanup: Promise<void> | undefined;
const close = () => cleanup ??= (async () => {
  try { await browser?.close(); } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
})();
const terminate = () => { void close().finally(() => process.exit(124)); };
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
const results: object[] = [], index = ['# Capture resilience screenshots', '', 'Each pair shows the same live state at 1280 and 390 px.'];
const specs = [
  { name: 'a', hold: 15000 }, { name: 'b', hold: 25000 }, { name: 'c', hold: 45000 },
  { name: 'd', segment: true }, { name: 'e', outage: 15000 }, { name: 'f', conflict: true },
  { name: 'g', hold: 60000, stop: true }, { name: 'h', hold: 25000, stop: true, perFrame: true },
];
const screenshots = async (page: Page, label: string) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const file = `${label}-${width}.png`;
    await page.screenshot({ path: join(out, file), fullPage: true });
    index.push(`- [${label}, ${width} px](${file})`);
  }
};
const deadline = setTimeout(terminate, 600000);
try {
  browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  for (const spec of specs) {
    if (process.env.CAPTURE_CASES && !process.env.CAPTURE_CASES.includes(spec.name)) continue;
    const meeting = app.store.createMeeting(`Fictional resilience ${spec.name}`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = [], requests: { at: number; source: string; sequence: number; pending: number }[] = [], ends: { at: number; source: string }[] = [];
    let first = 0, armed = false, segmentAt = 0, stopAt = 0;
    const firstByFrame = new Map<string, number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const hold = (ms: number) => new Promise<void>(r => { const timer = setTimeout(() => { timers.delete(timer); r(); }, Math.max(0, ms)); timers.add(timer); });
    await page.addInitScript(() => {
      const evidence = (window as any).__captureEvidence = { frames: 0, frozen: [] as number[] };
      const watch = (stream: MediaStream) => {
        for (const track of stream.getAudioTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { evidence.frozen.push(Date.now()); stop(); };
        }
        return stream;
      };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => watch(await original(constraints));
      // A synthetic browser tab exercises Stop with two independent upload queues, without screen access.
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext(), oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const canvas = document.createElement('canvas'); canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
        const video = canvas.captureStream(1).getVideoTracks()[0];
        Object.defineProperty(video, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
        return watch(new MediaStream([video, ...destination.stream.getAudioTracks()]));
      };
      const Worklet = AudioWorkletNode;
      (window as any).AudioWorkletNode = class extends Worklet {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          this.port.addEventListener('message', event => { if (event.data.kind === 'pcm') evidence.frames++; });
        }
      };
    });
    page.on('pageerror', e => errors.push(e.message));
    await context.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.origin !== app.url) return route.abort();
      if (req.method() === 'POST' && u.pathname.endsWith('/pcm/end')) ends.push({ at: Date.now(), source: req.postDataJSON().source });
      const pcm = req.method() === 'POST' && u.pathname.endsWith('/pcm');
      if (pcm) {
        first ||= Date.now();
        requests.push({ at: Date.now(), source: req.headers()['x-audio-source'], sequence: Number(req.headers()['x-sequence']), pending: Number(req.headers()['x-pending']) });
        const frame = `${req.headers()['x-audio-source']}:${req.headers()['x-sequence']}`;
        if (!firstByFrame.has(frame)) firstByFrame.set(frame, Date.now());
        if (spec.conflict && requests.length === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Fictional frame conflict' }) });
      }
      if (spec.outage && first && Date.now() < first + spec.outage) return route.abort('failed');
      if (armed && spec.segment && !segmentAt && u.pathname.endsWith('/segments')) { segmentAt = Date.now(); return route.abort('failed'); }
      if (pcm && spec.hold) {
        try {
          // Persist immediately, then lose/delay the acknowledgement: retries must not duplicate stored audio.
          const response = await route.fetch({ timeout: 10000 });
          const frame = `${req.headers()['x-audio-source']}:${req.headers()['x-sequence']}`;
          await hold((spec.perFrame ? firstByFrame.get(frame)! : first) + spec.hold - Date.now());
          await route.fulfill({ response });
        } catch { /* a timed-out browser request or closing context no longer needs its reply */ }
        return;
      }
      return route.continue();
    });
    let failure: string | null = null;
    try {
      await page.goto(app.url);
      await page.locator('#start').click();
      await page.locator(spec.stop ? '#start-online' : '#start-mic').click();
      await page.locator('#live-chip').getByText(/Recording/).waitFor();
      await until(() => first > 0);
      if (spec.segment) {
        await until(() => requests.length >= 3); armed = true;
        await until(() => segmentAt > 0); await sleep(3000);
      } else if (spec.outage) {
        await sleep(Math.max(0, first + 8000 - Date.now()));
        await screenshots(page, 'e-outage-saving-behind');
        assert.match(await page.locator('#live-chip').innerText(), /Recording · saving behind/);
        assert.equal((await page.evaluate(() => (window as any).__captureEvidence)).frozen.length, 0);
        await sleep(Math.max(0, first + spec.outage + 8500 - Date.now()));
      } else if (spec.stop) {
        await sleep(Math.max(0, first + 5000 - Date.now()));
        stopAt = Date.now(); await page.locator('#stop').click();
        const bound = spec.perFrame ? 43000 : 35000;
        await page.locator('#stop').waitFor({ state: 'hidden', timeout: bound });
        assert.ok(Date.now() - stopAt < bound, 'Stop must settle within retry bound plus end timeout');
        assert.ok(ends.every(e => e.at - stopAt < bound), 'every source sends /pcm/end within the shared Stop bound');
        assert.equal(new Set(requests.map(r => r.source)).size, 2, 'Stop exercises both sources');
        const frozen = (await page.evaluate(() => (window as any).__captureEvidence)).frozen;
        assert.equal(frozen.length, 2, 'Stop freezes every source');
        assert.ok(frozen.every((at: number) => at - stopAt < 1500), 'Stop freezes both physical inputs at once');
        // Let a held reply arrive after end: racing the drain without cancelling uploads must not pass.
        if (spec.perFrame) await sleep(26000);
      } else {
        await sleep(Math.max(0, first + (spec.conflict ? 2500 : spec.name === 'c' ? 34000 : spec.hold! + 4000) - Date.now()));
      }
      const evidence = await page.evaluate(() => (window as any).__captureEvidence);
      const log = await page.locator('#log').innerText();
      if (['a', 'b', 'd', 'e'].includes(spec.name)) {
        assert.equal(evidence.frozen.length, 0, 'the microphone must keep recording');
        assert.match(await page.locator('#live-chip').innerText(), /Recording/);
        if (spec.outage) assert.doesNotMatch(await page.locator('#live-chip').innerText(), /saving behind/);
        assert.doesNotMatch(log, /this source stopped|Connection lost|audio could not be saved/);
      }
      if (spec.name === 'c') {
        assert.equal(evidence.frozen.length, 1);
        assert.ok(evidence.frozen[0] - first >= 29000 && evidence.frozen[0] - first < 33000, 'persistent hold stops around thirty seconds');
        assert.match(log, /audio could not be saved|saving fell 30 s behind/);
      }
      if (spec.conflict) {
        assert.equal(requests.length, 1, '409 must not be retried');
        assert.equal(evidence.frozen.length, 1);
        assert.ok(evidence.frozen[0] - first < 1500, '409 stops at once');
        assert.match(log, /Fictional frame conflict/);
      }
      await screenshots(page, `${spec.name}-settled`);
    } catch (error) {
      failure = String(error); console.error(`FAIL ${spec.name}: ${failure}`);
      await screenshots(page, `${spec.name}-failed`).catch(() => {});
    } finally {
      if (await page.locator('#stop').isVisible() && await page.locator('#stop').isEnabled()) await page.locator('#stop').click();
      await page.locator('#stop').waitFor({ state: 'hidden', timeout: failure && spec.perFrame ? 1000 : 45000 }).catch(error => { failure ??= String(error); });
      await app.jobs!.wait();
      const evidence = await page.evaluate(() => (window as any).__captureEvidence);
      const frames = app.store.db.prepare('SELECT source, sequence, samples FROM frames WHERE meetingId=? ORDER BY source, sequence').all(meeting.id) as { source: string; sequence: number; samples: number }[];
      try {
        assert.ok(ends.length > 0, '/pcm/end must be sent');
        if (spec.hold) assert.ok(frames.length > 0, 'held acknowledgements still persisted audio');
        for (const source of new Set(requests.map(r => r.source))) {
          assert.equal(ends.filter(e => e.source === source).length, 1, 'every source ends exactly once');
          const rows = frames.filter(f => f.source === source), sent = requests.filter(r => r.source === source);
          const end = ends.find(e => e.source === source)!;
          assert.ok(sent.every(r => r.at <= end.at), 'no PCM request starts after that source ends');
          if (spec.stop) assert.ok(end.at - stopAt < (spec.perFrame ? 43000 : 35000), 'every source ends within the Stop bound');
          assert.deepEqual(rows.map(f => f.sequence), rows.map((_, i) => i), 'stored frames are unique and contiguous');
          assert.ok(sent.every((r, i) => !i || r.sequence >= sent[i - 1].sequence), 'a source never advances past an unacknowledged frame');
          if (spec.name === 'b') {
            const retries = sent.filter(r => r.sequence === 0);
            assert.ok(retries.length >= 3, 'the 25 s hold needs more than the old two attempts');
            assert.ok(retries[2].pending > retries[1].pending && retries[1].pending > retries[0].pending, 'X-Pending is recomputed for each attempt');
          }
        }
        if (['a', 'b', 'd', 'e'].includes(spec.name)) assert.equal(frames.length, evidence.frames, 'every captured frame including the partial tail was stored once');
        assert.deepEqual(errors, [], 'no page errors');
      } catch (error) { failure ??= String(error); }
      results.push({ case: spec.name, failure, first, segmentAt, stopAt, evidence, requests, ends, frames, errors, log: await page.locator('#log').innerText() });
      console.log(`${failure ? 'FAIL' : 'PASS'} ${spec.name}: ${frames.length} frames, ${requests.length} uploads, ${ends.length} ends${failure ? ` — ${failure}` : ''}`);
      await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
      await writeFile(join(out, 'INDEX.md'), index.join('\n') + '\n');
      await context.close();
      for (const timer of timers) clearTimeout(timer);
    }
  }
} finally {
  clearTimeout(deadline);
  process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
  await close();
}
if (results.some((r: any) => r.failure)) process.exitCode = 1;
