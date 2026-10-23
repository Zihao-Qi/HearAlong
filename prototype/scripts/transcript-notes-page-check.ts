// Option A: real durable capture metadata, main-page selection, desktop/390 px screenshots. No user data or models.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import type { Board } from '../src/board.ts';
import { CaptureSuspension } from '../public/capture-clock.js';
import { checkGapFixesPage } from './transcript-notes-fix1-page-cases.ts';
import { assertUniqueTranscriptKeys, watchTranscriptKeys, finishTranscriptKeyCheck } from './transcript-key-check.ts';

const out = resolve(process.argv[2] ?? 'artifacts/transcript-notes');
await mkdir(out, { recursive: true });
// Retained as the isolated fixture for layout-check; never reads or writes the user's store.
const directory = await mkdtemp(join(tmpdir(), 'transcript-notes-page-'));
const setup = await dashboardSetup(directory, true);
const recognizer = { async transcribe() { return { text: '', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1,
  audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }; }, close() {} };
const serve = () => startServer({ directory, port: 0, setup, quick: null, heavy: null, recognizer, drafts: null, notes: null, actions: null, board: null });
let app = await serve();
let cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
const meeting = app.store.createMeeting('Pottery workshop — synthetic gap fixture');
const from = new Date(2031, 3, 9, 9, 23, 18).getTime(), to = new Date(2031, 3, 9, 9, 29, 40).getTime();
const pcm = Buffer.alloc(16000 * 4);
const mic = 'mic:11111111-1111-4111-8111-111111111111', tab = 'tab:22222222-2222-4222-8222-222222222222';
const upload = async (audioSource: string, sequence: number, captureWallMs?: number, sleep = false) => {
  const response = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: pcm, headers: {
    Cookie: cookie, Origin: app.url, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': audioSource, 'X-Sequence': String(sequence),
    'X-Sample-Rate': '16000', 'X-Start-Ms': String(513000 + sequence * 1000),
    ...(captureWallMs ? { 'X-Capture-Wall-Ms': String(captureWallMs) } : {}),
    ...(sleep ? { 'X-Suspension-From': String(from - 500), 'X-Suspension-To': String(to) } : {}),
  } });
  assert.equal(response.status, 201, await response.text());
};
const errors: string[] = [], results: string[] = [], screenshots: string[] = [];
// Set MEETING_TEST_CHROME to a local Chrome/Chromium executable; otherwise use the standard macOS Chrome installation.
const browser = await chromium.launch({ headless: true, executablePath: process.env.MEETING_TEST_CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  await upload(mic, 0, from - 1000);
  await upload(mic, 1, to, true);
  await upload(tab, 0, from - 800);
  await upload(tab, 1, to + 200, true);
  assert.equal(app.store.captureGaps(meeting.id).length, 1);
  const old = 'mic:33333333-3333-4333-8333-333333333333';
  await upload(old, 0); await upload(old, 1);
  assert.equal(app.store.captureGaps(meeting.id).length, 1);
  results.push('optional upload headers; overlapping sources merge; old page frames accepted');
  const terminal = app.store.createMeeting('Terminal frame regression');
  const suspension = new CaptureSuspension(from - 500);
  suspension.tick(to); suspension.tick(to + 5, true);
  const terminalHeaders = { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': 'mic:44444444-4444-4444-8444-444444444444',
    'X-Sequence': '0', 'X-Sample-Rate': '16000', 'X-Start-Ms': '0', 'X-Capture-Wall-Ms': String(from - 400),
    'X-Capture-Discontinuities': JSON.stringify([{ offsetSamples: 6400, fromWallMs: from, toWallMs: to }]),
    'X-Suspension-From': String(suspension.interval!.fromWallMs), 'X-Suspension-To': String(suspension.interval!.toWallMs) };
  for (let retry = 0; retry < 2; retry++) {
    const response = await fetch(`${app.url}/api/meetings/${terminal.id}/pcm`, { method: 'POST', body: Buffer.alloc(9600 * 4), headers: terminalHeaders });
    assert.equal(response.status, 201, await response.text());
  }
  assert.equal(app.store.captureGaps(terminal.id).length, 1);
  assert.equal(app.store.captureGaps(terminal.id)[0].atMs, 400);
  assert.equal(app.store.captureGaps(terminal.id)[0].reason, 'sleep');
  const malformed = await fetch(`${app.url}/api/meetings/${terminal.id}/pcm`, { method: 'POST', body: pcm,
    headers: { ...terminalHeaders, 'X-Audio-Source': 'tab:55555555-5555-4555-8555-555555555555', 'X-Capture-Discontinuities': 'not JSON' } });
  assert.equal(malformed.status, 201, 'malformed optional metadata must not fail valid PCM');
  await app.close(); app = await serve();
  cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  assert.equal(app.store.captureGaps(meeting.id).length, 1);
  results.push('gap survives server restart');
  assert.equal(app.store.captureGaps(terminal.id).length, 1);
  assert.equal(app.store.captureGaps(terminal.id)[0].reason, 'sleep');
  assert.equal(app.store.captureGaps(terminal.id)[0].atMs, 400);
  results.push('fixes 1/3: terminal discontinuity headers persist once at sample offset, including after restart; timer-then-resume keeps sleep cause; malformed metadata leaves audio accepted');
  for (const [sequence, startMs, text] of [
    [0, 489000, 'The drying rack has twelve empty shelves. Put the glazed mugs on the top shelf and keep the aisle clear.'],
    [1, 514000, 'The kiln door is cool now. Bring the blue crates over before the shop opens.'],
  ] as const) {
    const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', sequence, startMs, 16000, pcm);
    app.store.completeChunk(chunk.id, { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1,
      audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
  await context.addInitScript(id => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); }, meeting.id);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await watchTranscriptKeys(page);
  const words = 'Please stack the blue crates beside the kiln before opening'.split(' ').map((text, i) => ({ text, startMs: 526000 + i * 240, endMs: 526240 + i * 240 }));
  let lateOverlap = false, override: any = null;
  await page.route('**/api/meetings/*/segments', async route => {
    const response = await route.fetch();
    const json = await response.json();
    if (lateOverlap) json.captureGaps.push({ atMs: 514000, fromWallMs: from - 100, toWallMs: to, reason: 'sleep' });
    const snapshot = { ...json, drafts: [{ source: mic, speaker: 'Me', window: 'note-preview', windowStartMs: 526000,
      coveredUntilMs: words.at(-1)!.endMs, words, text: words.map(w => w.text).join(' '), behind: false }], pending: [], ...override };
    assertUniqueTranscriptKeys(snapshot);
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto(app.url);
  await page.locator('.capture-gap').waitFor();
  // Exercise the actual worklet global (including Date.now availability), with generated sound only.
  const captured = await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('/pcm-worklet.js'); await context.resume();
    const oscillator = context.createOscillator(), node = new AudioWorkletNode(context, 'pcm-capture');
    oscillator.connect(node); node.connect(context.destination); oscillator.start();
    try {
      return await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No timestamped worklet frame')), 5000);
        node.onprocessorerror = () => { clearTimeout(timer); reject(new Error('Capture processor failed')); };
        node.port.onmessage = event => { if (event.data.kind === 'pcm') { clearTimeout(timer); resolve(event.data.captureWallMs); } };
      });
    } finally { oscillator.stop(); node.disconnect(); await context.close(); }
  });
  assert.ok(Math.abs(Date.now() - captured) < 4000);
  results.push('real AudioWorklet emits finite first-sample wall time');
  const gapText = 'Not recorded for 6 minutes, 9:23–9:29 AM: the Mac was asleep.';
  assert.equal(await page.locator('.capture-gap p').textContent(), gapText);
  assert.equal(await page.locator('.capture-gap time').textContent(), '08:34');
  assert.equal(await page.locator('.capture-gap [data-id]').count(), 0);
  const md = await (await fetch(`${app.url}/api/meetings/${meeting.id}/transcript.md`, { headers: { Cookie: cookie } })).text();
  assert.ok(md.indexOf('The drying rack has twelve empty shelves.') < md.indexOf(`*${gapText}*`));
  assert.ok(md.indexOf(`*${gapText}*`) < md.indexOf('The kiln door is cool now.'));
  await writeFile(join(out, 'transcript.md'), md);
  // A real action request must contain only speech, even though cloneContents includes the intervening note.
  let selection: any;
  await page.route('**/api/meetings/*/actions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    selection = route.request().postDataJSON().selection;
    await route.fulfill({ json: { job: {}, merged: false } }); // capture only; no model call
  });
  await page.evaluate(() => {
    const spans = document.querySelectorAll('#transcript span[data-id]');
    const range = document.createRange(); range.setStart(spans[0].firstChild!, 0); range.setEnd(spans[1].lastChild!, spans[1].lastChild!.textContent!.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  });
  await page.locator('#selection-menu').waitFor();
  lateOverlap = true;
  await page.waitForResponse(response => response.url().endsWith('/segments'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.capture-gap').count(), 1, 'a late overlapping source cannot duplicate a held gap row');
  assert.ok(!(await page.evaluate(() => getSelection()!.toString())).includes('Not recorded'));
  await page.locator('#selection-menu [data-action="explain"]').click();
  await page.waitForFunction(() => document.querySelector('#log')!.textContent!.includes('Explain started.'));
  assert.equal(selection.segmentIds.length, 2);
  assert.ok(!selection.text.includes('Not recorded'));
  assert.ok(selection.text.includes('The drying rack has twelve empty shelves.') && selection.text.includes('The kiln door is cool now.'));
  await page.evaluate(() => getSelection()!.removeAllRanges());
  results.push('spanning selection excludes note text and IDs; late overlapping source keeps one held gap row');
  const measurements: unknown[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(200);
    const preview = page.locator('#transcript .preview-text');
    await preview.scrollIntoViewIfNeeded();
    const rect = (await preview.boundingBox())!;
    await page.mouse.move(rect.x + 8, rect.y + 8); await page.mouse.down();
    await page.mouse.move(rect.x + 40, rect.y + 8, { steps: 5 });
    await page.locator('.draft-selection-note').waitFor();
    const measured = await page.evaluate(() => {
      const gap = document.querySelector('.capture-gap')!, note = document.querySelector('.draft-selection-note')!;
      const style = getComputedStyle(gap.querySelector('p')!), ns = getComputedStyle(note);
      const before = gap.previousElementSibling!.querySelector('p')!;
      return { width: innerWidth, font: style.fontSize, lineHeight: style.lineHeight, color: style.color, noteColor: ns.color, noteSize: ns.fontSize,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim(),
        aligned: Math.abs(before.getBoundingClientRect().left - gap.querySelector('p')!.getBoundingClientRect().left) < 1,
        userSelect: getComputedStyle(gap).userSelect, background: getComputedStyle(gap).backgroundColor,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(measured.font, '13px'); assert.equal(measured.lineHeight, '20.8px');
    assert.equal(measured.noteSize, '13px'); assert.equal(measured.color, measured.noteColor);
    assert.equal(measured.color, 'rgb(31, 62, 153)');
    assert.equal(measured.userSelect, 'none'); assert.equal(measured.background, 'rgba(0, 0, 0, 0)');
    assert.ok(measured.aligned); assert.ok(!measured.overflow);
    const shot = join(out, `transcript-notes-${width}.png`);
    await page.screenshot({ path: shot }); screenshots.push(shot); measurements.push(measured);
    await page.mouse.up();
  }
  results.push('option A alignment, 13px/1.6 accent gap, accent drag note, no overflow at desktop and 390 px');
  await checkGapFixesPage(page, async next => {
    const response = page.waitForResponse(r => r.url().endsWith('/segments'));
    override = next; await response; await page.waitForTimeout(150);
  }, results, out);
  results.push(`${await finishTranscriptKeyCheck(page)}; every gap snapshot also has unique keys`);
  assert.deepEqual(errors, []);
  // layout-check also exercises pinned-card → transcript navigation. Seed that prerequisite in this disposable store,
  // after taking the note screenshots; it is unrelated to the transcript-notes behavior and needs no model.
  const line = app.store.segments(meeting.id).at(-1)!;
  const board: Board = { version: 1, meetingId: meeting.id, covered: {}, autoUsed: 0, scans: [], lastScanAt: null, preset: 'discussion', cards: [{
    id: 'fixture-card', type: 'action', text: 'Bring the blue crates to the cool kiln before opening.', confidence: 'high', materials: false, nonProject: false,
    firstMs: line.startMs, createdAt: Date.now(), dismissed: false, attempts: [], occurrences: [{ scanId: 'fixture', lines: [line],
      quote: line.text, matched: 'corrected', publishedAt: Date.now(), glossaryVersion: null }],
  }] };
  await mkdir(join(directory, 'board'), { recursive: true });
  await writeFile(join(directory, 'board', `${meeting.id}.json`), JSON.stringify(board));
  await writeFile(join(out, 'page-check.json'), JSON.stringify({ results, measurements, screenshots, directory, errors }, null, 2));
  console.log(JSON.stringify({ results, screenshots, directory }, null, 2));
} finally { await browser.close(); await app.close(); }
