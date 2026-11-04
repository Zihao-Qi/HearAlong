// Real shared live snapshots: hold before deciding, pending grey tails, and race-safe old citations. Fictional data only.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { LiveDrafts } from '../src/drafts.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { testBrowser } from './test-browser.ts';
import { until } from '../test/helpers/until.ts';

const out = resolve(process.argv[2] ?? 'artifacts/echo-page');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-page-'));
const text = ['Fictional lantern zero uses cedar', 'Copper ribbons need glue before tomorrow', 'Fictional lantern two uses cedar'];
const labels = ['First lantern has cedar.', 'Bring glue for the ribbons.', 'Second lantern has cedar.'];
const notes = async () => ({ model: 'scripted', text: JSON.stringify({ title: 'Lantern review',
  summary: text.map((quote, i) => ({ text: labels[i], cites: [`S${i + 1}`], quote })),
  decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [],
}) });
let now = Date.now();
const drafts = new LiveDrafts({ modelPath: 'unused', workerScript: new URL('../test/fixtures/fake-stream-worker.ts', import.meta.url) });
const recognizer = { async transcribe() { return { text: '', words: [], backend: 'fixture', computeMs: 1, decodeMs: 0,
  audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }; }, close() {} };
const app = await startServer({ directory, port: 0, clock: () => now, recognizer, drafts, quick: null, heavy: null,
  notes, setup: await dashboardSetup(directory, true) });
const browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
const results: string[] = [], errors: string[] = [];
try {
  const meeting = app.store.createMeeting('Fictional lantern review'), other = app.store.createMeeting('Other fictional room');
  const mic = `mic:${randomUUID()}`, call = `tab:${randomUUID()}`, recording = randomUUID();
  const chunks = [];
  for (const [i, sentence] of text.entries()) {
    const chunk = await app.store.addPcm(meeting.id, mic, 100 + i, i * 10000, 16000, Buffer.alloc(4 * 48000));
    app.store.completeChunk(chunk.id, { text: sentence, words: [], backend: 'fixture', computeMs: 1, decodeMs: 0,
      audioSeconds: 3, processRssBytes: 0, timestampKind: 'none' });
    chunks.push(chunk);
  }
  const ids = chunks.map(c => `${c.id}:0`);
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { method: 'POST', headers, body: '{}' })).status, 202);
  await until(async () => Boolean((await (await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { headers })).json()).notes));
  // One real accepted frame on each source establishes the live recording; no physical capture is used.
  for (const source of [mic, call]) {
    const response = await fetch(`${app.url}/api/meetings/${meeting.id}/pcm`, { method: 'POST', body: Buffer.alloc(64000), headers: {
      ...headers, 'Content-Type': 'application/octet-stream', 'X-Audio-Source': source, 'X-Sequence': '0', 'X-Start-Ms': '0',
      'X-Sample-Rate': '16000', 'X-Recording': recording,
    } }); assert.equal(response.status, 201, await response.text());
  }
  // Use a sealed preview to prove completed-but-held mic audio does not retire its grey tail.
  drafts.drop(`${mic}:0`); drafts.begin(meeting.id, mic, 'held-preview', 0);
  for (const n of [2, 3, 4]) { const pcm = new Float32Array(16000); pcm[0] = n; drafts.feed('held-preview', pcm); }
  await until(() => drafts.drafts(meeting.id).some(d => d.text === 'w2 w3 w4'));
  drafts.seal('held-preview', chunks[0]);
  app.store.db.prepare('UPDATE chunks SET completedAt=? WHERE meetingId=?').run(now, meeting.id);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(({ id, echoes, sentences }) => {
    localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes');
    const seen: string[] = []; (window as any).seenEchoes = seen;
    new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) {
        for (const span of [n, ...n.querySelectorAll('span[data-id], .final')]) {
          if (span.closest('#transcript') && echoes.includes(span.getAttribute('data-id') ?? '')) seen.push(span.getAttribute('data-id')!);
          if (span.closest('#m-scroll') && span.matches('.final') && sentences.includes(span.textContent ?? '')) seen.push(span.textContent!);
        }
      }
    }).observe(document, { subtree: true, childList: true });
  }, { id: meeting.id, echoes: [ids[0], ids[2]], sentences: [text[0], text[2]] });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const mini = await context.newPage(); mini.on('pageerror', e => errors.push(e.message));
  await mini.setViewportSize({ width: 360, height: 268 });
  await page.goto(app.url); await mini.goto(`${app.url}/mini.html`);
  const note = (i: number) => page.locator('.note-sentence', { hasText: labels[i] });
  await note(0).waitFor();
  await page.locator('#transcript .preview-text', { hasText: 'w2 w3 w4' }).waitFor();
  await mini.locator('#m-drafts', { hasText: 'w2 w3 w4' }).waitFor();
  assert.equal(await page.locator('#transcript span[data-id]').count(), 0);
  assert.deepEqual(await mini.evaluate(() => (window as any).seenEchoes), []);
  const held = await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers })).json();
  assert.deepEqual(held.segments, []); assert.ok(held.pending.some((p: any) => p.text === 'w2 w3 w4'));
  await page.screenshot({ path: join(out, 'main-held.png') });
  await mini.screenshot({ path: join(out, 'mini-held.png') });
  results.push('main and mini hold mic finals in the shared server path, retaining their grey pending tail');
  // The same live endpoint must suppress duplicate grey words, without consuming the stored pending hypothesis.
  for (const n of [2, 3, 4]) { const pcm = new Float32Array(16000); pcm[0] = n; drafts.feed(`${call}:0`, pcm); }
  await until(() => drafts.drafts(meeting.id).some(d => d.source === call && d.text === 'w0 w2 w3 w4'));
  now += 4000;
  const suppressed = await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers })).json();
  assert.equal(suppressed.pending.some((p: any) => p.source === mic), false);
  assert.equal(suppressed.drafts.some((p: any) => p.source === mic && (p.text || p.words.length)), false);
  // Active sources retain their metadata even when their words are suppressed; the page must not infer a stalled mic.
  const miniSuppressed = (await (await fetch(`${app.url}/api/live`, { headers })).json()).recording;
  assert.equal(miniSuppressed.drafts.find((d: any) => d.source === mic).text, '');
  assert.match(miniSuppressed.drafts.find((d: any) => d.source === call).text, /w2 w3 w4/);
  drafts.drop(`${call}:0`); drafts.begin(meeting.id, call, 'different-call-preview', 0);
  drafts.feed('different-call-preview', new Float32Array(16000));
  await until(() => drafts.drafts(meeting.id).some(d => d.source === call && d.text === 'w0'));
  const restored = await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers })).json();
  assert.ok(restored.pending.some((p: any) => p.source === mic && p.text === 'w2 w3 w4'));
  results.push('echoed grey mic draft/pending words are suppressed for both endpoints, then restored unchanged when different call words arrive');

  const remote = await app.store.addPcm(meeting.id, call, 100, 0, 16000, Buffer.alloc(4 * 16000 * 26));
  app.store.completeChunk(remote.id, { text: `${text[0]} ${text[2]}`, words: [],
    segments: [{ text: text[0], t0Ms: 0, t1Ms: 3000 }, { text: text[2], t0Ms: 20000, t1Ms: 23000 }],
    backend: 'fixture', computeMs: 1, decodeMs: 0, audioSeconds: 26, processRssBytes: 0, timestampKind: 'segment' });
  const remoteIds = [`${remote.id}:0`, `${remote.id}:1`];
  await page.locator(`#transcript span[data-id="${ids[1]}"]`).waitFor();
  await mini.locator('.final', { hasText: text[1] }).waitFor();
  await page.locator('#transcript .preview-text', { hasText: 'w2 w3 w4' }).waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => (window as any).seenEchoes), []);
  // In the mini, the surviving Them sentences have the same text; only their one post-catch-up appearance is allowed.
  for (const sentence of [text[0], text[2]]) assert.equal(await mini.locator('.final', { hasText: sentence }).count(), 1);
  const miniSeen = await mini.evaluate(() => (window as any).seenEchoes as string[]);
  assert.deepEqual(miniSeen.sort(), [text[0], text[2]].sort());
  assert.equal(await page.locator(`#transcript span[data-id="${ids[0]}"]`).count(), 0);
  assert.equal(await page.locator(`#transcript span[data-id="${ids[2]}"]`).count(), 0);
  await page.screenshot({ path: join(out, 'main-decided.png') });
  await mini.screenshot({ path: join(out, 'mini-decided.png') });
  results.push('echo mic finals never enter either live view before decision; genuine/headphones speech appears when the call catches up');
  const endedText = 'Copper wire supports the folded shade';
  const endedChunk = await app.store.addPcm(meeting.id, mic, 103, 30000, 16000, Buffer.alloc(4 * 48000));
  app.store.completeChunk(endedChunk.id, { text: endedText, words: [], backend: 'fixture', computeMs: 1, decodeMs: 0,
    audioSeconds: 3, processRssBytes: 0, timestampKind: 'none' });
  assert.equal((await (await fetch(`${app.url}/api/meetings/${meeting.id}/segments`, { headers })).json()).segments.some((s: any) => s.id === `${endedChunk.id}:0`), false);
  assert.equal((await fetch(`${app.url}/api/meetings/${meeting.id}/pcm/end`, { method: 'POST', headers,
    body: JSON.stringify({ source: call, lastSequence: 0, stopping: false }) })).status, 200);
  await page.locator(`#transcript span[data-id="${endedChunk.id}:0"]`).waitFor();
  await mini.locator('.final', { hasText: endedText }).waitFor();
  results.push('ending the call mid-hold immediately releases genuine speech in both views');

  assert.deepEqual(await (await fetch(`${app.url}/api/meetings/${meeting.id}/segment-location?id=${encodeURIComponent(ids[0])}`, { headers })).json(), { id: remoteIds[0] });
  assert.equal((await fetch(`${app.url}/api/meetings/${other.id}/segment-location?id=${encodeURIComponent(ids[0])}`, { headers })).status, 404);
  await note(0).click();
  await page.locator(`#transcript span[data-id="${remoteIds[0]}"].flash.cited`).waitFor();
  results.push('old hidden citation scrolls, flashes and highlights the correct surviving Them span');

  let release: (() => void) | undefined, waiting = false, resolved = false;
  await page.route('**/segment-location?*', async route => {
    if (!route.request().url().includes(encodeURIComponent(ids[2]))) { await route.continue(); return; }
    waiting = true; await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { id: remoteIds[1] } }); resolved = true;
  });
  await note(2).click(); await until(() => waiting);
  await note(1).click(); await page.locator(`#transcript span[data-id="${ids[1]}"].flash.cited`).waitFor();
  release!(); await until(() => resolved); await page.waitForTimeout(250);
  assert.equal(await page.locator(`#transcript span[data-id="${remoteIds[1]}"].cited`).count(), 0);
  assert.equal(await page.locator(`#transcript span[data-id="${ids[1]}"].cited`).count(), 1);
  waiting = false; resolved = false;
  await note(2).click(); await until(() => waiting);
  const pick = async (title: string) => {
    await page.locator('#meeting-button').click();
    await page.locator('#meeting-list [role="menuitemradio"]').filter({ hasText: title }).click();
    await page.locator('#meeting-title', { hasText: title }).waitFor();
  };
  await pick('Other fictional room'); await pick('Fictional lantern review'); await note(0).waitFor();
  release!(); await until(() => resolved); await page.waitForTimeout(250);
  assert.equal(await page.locator(`#transcript span[data-id="${remoteIds[1]}"].cited`).count(), 0);
  await page.unroute('**/segment-location?*');
  results.push('a newer citation click and a meeting switch away/back both invalidate older in-flight lookups');

  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#ctab-notes').click();
  await page.route('**/segment-location?*', route => route.fulfill({ status: 404, json: { error: 'Line not found.' } }));
  const beforeScroll = await page.locator('#notes-panel').evaluate(n => n.scrollTop);
  const failed = page.waitForResponse(r => r.url().includes('segment-location'));
  await note(0).click(); await failed; await page.waitForTimeout(150);
  assert.equal(await page.locator('#ctab-notes').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#notes-panel').evaluate(n => n.scrollTop), beforeScroll);
  await page.screenshot({ path: join(out, 'compact-failed-citation.png') });
  await page.unroute('**/segment-location?*'); await note(0).click();
  await page.locator(`#transcript span[data-id="${remoteIds[0]}"].flash.cited`).waitFor();
  assert.equal(await page.locator('#ctab-live').getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: join(out, 'compact-citation.png') });
  results.push('compact citation changes pane only on success; lookup failure preserves pane and scroll');
  for (const suffix of ['transcript.txt', 'transcript.md', 'transcript.md?mode=raw']) {
    const exported = await (await fetch(`${app.url}/api/meetings/${meeting.id}/${suffix}`, { headers })).text();
    assert.equal(exported.split(text[0]).length - 1, 1);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(results.join('\n'));
  now += 10000;
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
