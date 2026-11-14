// Production headless capture sources with test-only input and a loopback fault proxy. Never creates a HAL tap or accesses TCC.
import './check-env.ts';
import { testBrowser } from './test-browser.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { LiveDrafts } from '../src/drafts.ts';

async function waitFor(check: () => Promise<boolean>, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for app capture.');
}
const out = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'hearalong-app-audio-screenshots-'));
await mkdir(out, { recursive: true });
const screenshots: string[] = [];
const directory = await mkdtemp(join(tmpdir(), 'hearalong-app-audio-check-'));
const data = join(directory, 'data');
await mkdir(data);
const server = await startServer({ directory: data, port: 0, quick: null, heavy: null,
  setup: await dashboardSetup(data, true),
  recognizer: { async transcribe() { return { text: 'Fictional call transcript.', backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} },
  drafts: new LiveDrafts({ modelPath: 'unused', workerScript: new URL('../test/fixtures/fake-stream-worker.ts', import.meta.url) }),
});
// Only the helper uses the proxy. Faults must not interrupt the page's microphone or other local services.
let failUploads = false;
const attempts: { source: string; sequence: number; at: number; startMs: number; wallMs: number; clockStart: number }[] = [];
const ends: { source: string; message?: string }[] = [];
const sockets = new Set<Socket>();
const proxy = createServer((req, res) => {
  const source = String(req.headers['x-audio-source'] ?? '');
  if (req.url?.endsWith('/pcm/end')) {
    let body = '';
    req.on('data', bytes => { body += bytes.toString(); });
    req.on('end', () => { ends.push(JSON.parse(body)); });
  }
  if (req.url?.endsWith('/pcm')) {
    attempts.push({ source, sequence: Number(req.headers['x-sequence']), at: Date.now(), startMs: Number(req.headers['x-start-ms']), wallMs: Number(req.headers['x-capture-wall-ms']), clockStart: Number(req.headers['x-clock-start']) });
    if (failUploads) { req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"Fictional upload outage"}'); return; }
  }
  const upstream = request(new URL(req.url!, server.url), { method: req.method, headers: { ...req.headers, host: new URL(server.url).host, ...(req.headers.origin ? { origin: server.url } : {}) } }, reply => {
    res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
  req.pipe(upstream);
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const disconnect = async () => { for (const socket of sockets) socket.destroy(); if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve())); };
let helper: ChildProcess | undefined;
const browser = await chromium.launch({ executablePath: testBrowser(), headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const binary = join(directory, 'hearalong-capture');
  execFileSync('swiftc', ['-DAPP_AUDIO_TESTING', '-o', binary, 'launcher/capture-main.swift', 'launcher/AudioPipeline.swift', 'launcher/AppAudio.swift', 'launcher/AppCaptureClient.swift', '-framework', 'CoreAudio', '-framework', 'AVFoundation']);
  const control = join(directory, 'fictional-app-control');
  await writeFile(control, 'normal');
  const launchCapture = () => spawn(binary, [`http://127.0.0.1:${proxyPort}`, server.url, String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HEARALONG_FAKE_APP_AUDIO: '1', HEARALONG_FAKE_APP_CONTROL: control } });
  helper = launchCapture();
  let helperErrors = '';
  helper.stderr!.on('data', bytes => { helperErrors += bytes.toString(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url);
  await page.locator('#meeting-button').click(); await page.locator('#new-meeting').click(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !(document.getElementById('start') as HTMLButtonElement).disabled);
  const state = () => page.evaluate(async () => (await (await fetch('/api/live/app-capture')).json()).state as { source: string; ended: boolean; message: string | null; notice: string | null } | null);
  const logCount = (text: string) => page.locator('#log .log-line').filter({ hasText: text }).count();
  const micContinues = async () => {
    assert.equal(await page.locator('#stop').isVisible(), true);
    assert.equal(server.store!.openRecordings().filter(r => r.source.startsWith('mic:')).length, 1);
    assert.equal(server.store!.openRecordings().filter(r => r.source.startsWith('app:')).length, 0);
  };
  const stop = async () => { await page.locator('#stop').click(); await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 }); assert.equal(server.store!.openRecordings().length, 0); };
  const open = async () => { await page.locator('#start').click(); await page.locator('#start-online').click(); };
  const chooseApp = async (adding = false) => {
    const previous = (await state())?.source;
    if (adding) await page.locator('#add-tab').click(); else await open();
    await page.locator('#call-apps button', { hasText: 'Fictional Meet' }).click();
    await waitFor(async () => { const s = await state(); return Boolean(s && s.source !== previous); });
    return (await state())!.source;
  };
  const hasFrames = (source: string) => waitFor(async () => server.store!.lastFrameSequence(server.store!.meetings()[0].id, source) !== null);
  await waitFor(() => page.evaluate(async () => (await (await fetch('/api/live/app-capture')).json()).available));
  await page.waitForTimeout(1200);
  const geometryProblems: string[] = [];
  const headingHeights = new Map<number, number>();
  const screenshot = async (name: string) => {
    const heading = await page.locator('#call-heading').evaluate(node => {
      const h = node.getBoundingClientRect(), back = document.getElementById('call-back')!, b = back.getBoundingClientRect();
      return { height: h.height, back: !back.hidden, width: b.width, hitHeight: b.height, viewport: innerWidth };
    });
    if (heading.height) {
      if (heading.back) {
        headingHeights.set(heading.viewport, heading.height);
        if (heading.width < 44 || heading.hitHeight < 44) geometryProblems.push(`${name}: Back hit area ${heading.width} × ${heading.hitHeight}`);
      } else if (heading.height !== headingHeights.get(heading.viewport)) geometryProblems.push(`${name}: header height changed ${headingHeights.get(heading.viewport)} → ${heading.height}`);
    }
    const bounds = await page.locator('#start-menu').evaluate(node => {
      const box = node.getBoundingClientRect(), button = document.getElementById('start')!;
      return { left: box.left, right: box.right, viewport: innerWidth, startClass: button.className, startLeft: button.getBoundingClientRect().left,
        newHidden: document.getElementById('start-new')!.hidden, menuLeft: getComputedStyle(node).left, menuRight: getComputedStyle(node).right };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, `${name}: menu stays within viewport: ${JSON.stringify(bounds)}`);
    const path = join(out, name); await page.screenshot({ path, fullPage: true }); screenshots.push(path);
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForFunction(compact => document.body.classList.contains('layout-compact') === compact, width < 900);
    await page.locator('#start').click(); await screenshot(`start-${width}.png`);
    await page.locator('#start-online').click();
    await waitFor(async () => await page.locator('#call-apps button').count() === 2);
    await screenshot(`call-apps-${width}.png`);
    await writeFile(control, 'empty'); await page.locator('#call-empty').waitFor();
    assert.equal(await page.locator('#call-apps button').count(), 0);
    await screenshot(`call-empty-${width}.png`);
    await writeFile(control, 'normal');
    await waitFor(async () => await page.locator('#call-apps button').count() === 2);
    await page.keyboard.press('Escape');
    await page.locator('#start').click(); await page.locator('#start-mic').click();
    await page.locator('#add-tab').click();
    await waitFor(async () => await page.locator('#call-apps button').count() === 2);
    assert.equal(await page.locator('#call-back').isHidden(), true);
    await screenshot(`add-call-${width}.png`);
    await page.keyboard.press('Escape'); await stop();
  }
  assert.deepEqual(geometryProblems, [], 'Back hit target and equal-height menu headers');
  await page.setViewportSize({ width: 1280, height: 860 });
  await writeFile(join(out, 'screenshots.json'), JSON.stringify(screenshots, null, 2));
  console.log(`PASS UI screenshots: ${screenshots.join(', ')}`);
  await open(); await page.locator('#call-apps button', { hasText: 'Fictional Meet' }).waitFor();
  assert.equal(await page.locator('#call-tab').evaluate(n => document.activeElement === n), true);
  await page.locator('#call-back').click(); assert.equal(await page.locator('#start-online').evaluate(n => document.activeElement === n), true);
  await page.locator('#start-online').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#start-menu').isHidden(), true);
  await chooseApp();
  await waitFor(() => page.evaluate(async () => {
    const live = (await (await fetch('/api/live')).json()).recording;
    return Boolean(live?.drafts.some((d: { source: string; speaker: string; text: string }) => d.source.startsWith('app:') && d.speaker === 'Them' && d.text));
  }));
  await stop();
  assert.ok(attempts.length > 0 && attempts.every(a => Math.abs(a.wallMs - a.clockStart - a.startMs) < 1), 'capture wall time describes the first sample, on the page timeline');
  assert.ok(server.store!.chunks(server.store!.meetings()[0].id).some(c => c.source.startsWith('app:') && c.seconds % 1 > 0));
  console.log('PASS menu/focus/Back/Escape, Them preview, unpadded tail, clean Stop');

  const meetingsBeforeFresh = server.store!.meetings();
  const previousMeeting = await page.evaluate(() => localStorage.getItem('meeting-id'));
  const previousSource = (await state())?.source;
  await page.locator('#start-new').click(); await page.locator('#start-online').click();
  assert.equal(await page.locator('#start-menu').getAttribute('aria-label'), 'New recording');
  await page.locator('#call-apps button', { hasText: 'Fictional Meet' }).click();
  await waitFor(async () => { const s = await state(); return Boolean(s && s.source !== previousSource); });
  const freshSource = (await state())!.source;
  const freshMeeting = await page.evaluate(() => localStorage.getItem('meeting-id'));
  assert.notEqual(freshMeeting, previousMeeting);
  assert.equal(server.store!.meetings().length, meetingsBeforeFresh.length + 1, 'New app recording creates exactly one meeting');
  assert.deepEqual(server.store!.meetings().filter(m => !meetingsBeforeFresh.some(old => old.id === m.id)).map(m => m.id), [freshMeeting], 'the new meeting is selected');
  await hasFrames(freshSource);
  assert.ok(server.store!.openRecordings().some(r => r.meetingId === freshMeeting && r.source === freshSource), 'the selected meeting owns the app recording');
  assert.ok(server.store!.openRecordings().some(r => r.meetingId === freshMeeting && r.source.startsWith('mic:')), 'the selected meeting also records the microphone');
  await stop();
  assert.equal(server.store!.meetings().length, meetingsBeforeFresh.length + 1);
  assert.ok(server.store!.chunks(freshMeeting!).some(c => c.source === freshSource && c.seconds > 0), 'app audio is saved in the new meeting');
  console.log('PASS New recording → online call → meeting app: exactly one new selected meeting owns mic and saved app audio');

  await page.locator('#start').click(); await page.locator('#start-mic').click();
  const closed = await chooseApp(true); assert.equal(await page.locator('#call-back').isHidden(), true);
  await hasFrames(closed); await writeFile(control, 'quit');
  await waitFor(async () => (await state())?.ended === true); await page.locator('#add-tab').waitFor();
  await micContinues(); assert.equal(await logCount('Fictional Meet closed'), 1); await stop();
  console.log('PASS Add online call without Back, app quits: one message and mic continues');

  await writeFile(control, 'start-error'); await chooseApp();
  await waitFor(async () => (await state())?.ended === true); await page.locator('#add-tab').waitFor();
  await micContinues(); assert.equal(await logCount('Fictional tap creation failed'), 1); await stop();
  console.log('PASS tap-start failure ends only app source, one message');

  await writeFile(control, 'silent'); await chooseApp();
  await waitFor(async () => Boolean((await state())?.notice), 22_000);
  await page.waitForTimeout(2500);
  assert.equal(await logCount('No sound from Fictional Meet yet.'), 1);
  assert.match((await state())!.notice!, /Screen & System Audio Recording/);
  const mini = await browser.newPage(); await mini.goto(`${server.url}/mini.html`);
  await mini.locator('.stop').click(); await mini.locator('.stop-now').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden', timeout: 15_000 });
  assert.equal(server.store!.openRecordings().length, 0); await mini.close();
  console.log('PASS one 15-second permission notice, app-source Stop through mini UI ends both');

  await writeFile(control, 'normal'); failUploads = true;
  const failed = await chooseApp();
  await waitFor(async () => (await state())?.ended === true, 50_000); failUploads = false;
  await page.locator('#add-tab').waitFor(); await micContinues();
  const retries = attempts.filter(a => a.source === failed);
  assert.ok(retries.length >= 4); assert.ok(retries.every(a => a.sequence === 0));
  assert.ok(retries.at(-1)!.at - retries[0].at >= 28_000);
  assert.match((await state())!.message!, /saving fell 30 s behind|audio could not be saved/);
  assert.equal(await logCount((await state())!.message!), 1); await stop();
  console.log('PASS exhausted real upload/backoff budget: no queue advance, app ends, mic continues');

  const disconnected = await chooseApp(); await hasFrames(disconnected);
  const noticesBefore = await logCount("HearAlong's audio capture stopped");
  await disconnect(); await waitFor(async () => (await state())?.ended === true);
  await page.locator('#add-tab').waitFor(); await micContinues();
  await new Promise<void>(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
  await page.waitForTimeout(4500);
  assert.equal(await logCount("HearAlong's audio capture stopped"), noticesBefore + 1);
  assert.equal(server.store!.openRecordings().filter(r => r.source.startsWith('app:')).length, 0, 'late uploads cannot reopen the ended source');
  await stop(); console.log('PASS helper loses server and reconnects: one message, no orphan/reopened source, mic continues');

  await waitFor(() => page.evaluate(async () => (await (await fetch('/api/live/app-capture')).json()).available)); await page.waitForTimeout(1200);
  const crashed = await chooseApp(); await hasFrames(crashed);
  const crashNotices = await logCount("HearAlong's audio capture stopped");
  helper.kill('SIGKILL');
  await new Promise<void>(resolve => helper!.once('exit', () => resolve())); helper = undefined;
  await waitFor(async () => (await state())?.ended === true); await page.locator('#add-tab').waitFor();
  await micContinues(); assert.equal(await logCount("HearAlong's audio capture stopped"), crashNotices + 1); await stop();
  console.log('PASS capture crash: one message, only app ends, mic continues');

  helper = launchCapture();
  helper.stderr!.on('data', bytes => { helperErrors += bytes.toString(); });
  await waitFor(() => page.evaluate(async () => (await (await fetch('/api/live/app-capture')).json()).available));
  await page.waitForTimeout(1200); // Let the page's independent one-second availability poll observe the new process.
  const terminated = await chooseApp(); await hasFrames(terminated);
  const exited = new Promise<number | null>(resolve => helper!.once('exit', code => resolve(code)));
  helper.kill('SIGTERM');
  assert.equal(await exited, 0); helper = undefined;
  assert.ok(ends.some(end => end.source === terminated && end.message === 'HearAlong quit; the microphone keeps recording.'), 'SIGTERM sends pcm/end before exit');
  await waitFor(async () => (await state())?.ended === true);
  await page.locator('#add-tab').waitFor(); await micContinues(); await stop();
  console.log('PASS headless SIGTERM drains fake frames and sends pcm/end before exiting');

  await page.waitForTimeout(4500);
  await page.evaluate(() => {
    const devices = navigator.mediaDevices as MediaDevices & { pickerCalls?: number };
    devices.pickerCalls = 0;
    devices.getDisplayMedia = async () => { devices.pickerCalls!++; throw new DOMException('Cancelled', 'NotAllowedError'); };
  });
  await open(); await page.waitForFunction(() => (navigator.mediaDevices as MediaDevices & { pickerCalls?: number }).pickerCalls === 1);
  assert.equal(await page.locator('#start-menu').isHidden(), true); await stop();
  assert.deepEqual(errors, []); assert.doesNotMatch(helperErrors, /could not run|Fatal error|crash/i);
  console.log('PASS no helper → direct Chrome picker; no page errors');
} finally {
  if (helper) { const child = helper; child.kill('SIGTERM'); await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
  await browser.close(); await disconnect(); await server.close(); await rm(directory, { recursive: true, force: true });
}
