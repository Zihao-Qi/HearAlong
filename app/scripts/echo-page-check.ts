// Read-time echo removal through the real transcript poll, scroll anchoring, exports and old note citations.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';
import { testBrowser } from './test-browser.ts';
import { until } from '../test/helpers/until.ts';
import { miniLog } from '../public/preview-composition.js';
import { ROLE_LABEL } from '../src/speakers.ts';

const out = resolve(process.argv[2] ?? 'artifacts/echo-page');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'hearalong-echo-page-'));
const sentence = (n: number) => `Fictional lantern ${n} uses a cedar frame`;
const notes = async () => ({ model: 'scripted', text: JSON.stringify({ title: 'Lantern review',
  summary: [{ text: 'The lantern has a cedar frame.', cites: ['S11'], quote: sentence(10) }],
  decisions: [], actions: [], openQuestions: [], otherMatters: [], otherTalk: [],
}) });
const app = await startServer({ directory, port: 0, recognizer: null, drafts: null, quick: null, heavy: null,
  notes, setup: await dashboardSetup(directory, true) });
const browser = await chromium.launch({ executablePath: testBrowser(), headless: true });
const results: string[] = [], errors: string[] = [];
try {
  const meeting = app.store.createMeeting('Fictional lantern review');
  const add = async (source: string, n: number, text: string) => {
    const chunk = await app.store.addPcm(meeting.id, source, n, n * 5000, 16000, Buffer.alloc(4 * 16000));
    app.store.completeChunk(chunk.id, { text, words: [], backend: 'fixture', computeMs: 1, decodeMs: 0,
      audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
    return `${chunk.id}:0`;
  };
  await add('tab:marker', 0, ''); // The call is already labelled while its recognized partner blocks are pending.
  const ids = [];
  for (let n = 0; n < 60; n++) ids.push(await add('mic:room', n, sentence(n)));
  const cookie = (await fetch(app.url)).headers.get('set-cookie')!.split(';')[0];
  const headers = { Cookie: cookie, Origin: app.url, 'Content-Type': 'application/json' };
  const response = await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 202);
  await until(async () => Boolean((await (await fetch(`${app.url}/api/meetings/${meeting.id}/notes`, { headers })).json()).notes));
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(id => { localStorage.setItem('meeting-id', id); localStorage.setItem('right-tab', 'notes'); }, meeting.id);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url);
  await page.locator(`#transcript span[data-id="${ids[59]}"]`).waitFor();
  await page.locator('#transcript').evaluate((box, id) => {
    const row = box.querySelector(`span[data-id="${id}"]`)!.closest('.para')!;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 100;
    box.dispatchEvent(new Event('scroll'));
  }, ids[30]);
  const mini = await context.newPage();
  await mini.setViewportSize({ width: 360, height: 268 });
  await mini.route(/\/api\/live(?:\?.*)?$/, async route => {
    const speakers = app.store.speakers(meeting.id);
    const segments = app.store.segments(meeting.id).map(s => ({ ...s, speaker: ROLE_LABEL[speakers.roleOf(s.source, s.startMs, s.endMs)!] }));
    const { paragraphs } = miniLog(segments, [], []);
    await route.fulfill({ json: { recording: { meetingId: meeting.id, session: 1, clockMs: 300000, labelled: true,
      paragraphs: paragraphs.map(p => ({ ...p, text: p.segments.map(s => s.text).join(' ') })), paragraphsFrom: 0, paragraphsTag: '', drafts: [], pending: [], notices: [] },
      mini: { native: false, state: 'open' } } });
  });
  await mini.goto(`${app.url}/mini.html`);
  const miniAnchor = mini.locator('.final', { hasText: sentence(30) });
  await miniAnchor.waitFor();
  await mini.locator('#m-scroll').evaluate(box => {
    const row = [...box.querySelectorAll('.ln')].find(n => n.textContent?.includes('Fictional lantern 30 uses'))!;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    box.dispatchEvent(new Event('scroll'));
  });
  const miniBefore = await miniAnchor.evaluate(n => n.getBoundingClientRect().top);
  const anchor = page.locator(`#transcript span[data-id="${ids[30]}"]`);
  const before = await anchor.evaluate(n => n.getBoundingClientRect().top);
  console.log('reader before', before, await page.locator('#transcript').evaluate(n => ({ top: n.scrollTop, height: n.scrollHeight, visible: n.clientHeight })));
  const remoteIds = [];
  for (let n = 0; n < 20; n++) remoteIds.push(await add('app:call', n, `${sentence(n)} with extra paper ribbons around the outside edge`));
  await page.locator(`#transcript span[data-id="${remoteIds[19]}"]`).waitFor();
  assert.equal(await page.locator(`#transcript span[data-id="${ids[10]}"]`).count(), 0);
  const after = await anchor.evaluate(n => n.getBoundingClientRect().top);
  console.log('reader after', after, await page.locator('#transcript').evaluate(n => ({ top: n.scrollTop, height: n.scrollHeight, visible: n.clientHeight })));
  assert.ok(Math.abs(after - before) <= 1, `late partner arrival moved the reader by ${after - before} px`);
  await mini.locator('.final', { hasText: `${sentence(19)} with extra` }).waitFor();
  assert.ok(Math.abs(await miniAnchor.evaluate(n => n.getBoundingClientRect().top) - miniBefore) <= 1, 'mini reader stays anchored');
  assert.equal(await mini.locator('.final', { hasText: new RegExp(`^${sentence(10)}$`) }).count(), 0);
  results.push('late call finals remove mic echoes without moving the surviving line under either transcript reader');
  const location = await (await fetch(`${app.url}/api/meetings/${meeting.id}/segment-location?id=${encodeURIComponent(ids[10])}`, { headers })).json();
  assert.equal(location.startMs, 50000);
  const other = app.store.createMeeting('Other fictional meeting');
  assert.equal((await fetch(`${app.url}/api/meetings/${other.id}/segment-location?id=${encodeURIComponent(ids[10])}`, { headers })).status, 404);
  const note = page.locator('.note-sentence', { hasText: 'The lantern has a cedar frame.' });
  await note.click();
  await page.locator(`#transcript span[data-id="${remoteIds[10]}"].flash`).waitFor();
  results.push('old note citation opens the surviving call line at the hidden mic line time; cross-meeting lookup refused');
  for (const suffix of ['transcript.txt', 'transcript.md', 'transcript.md?mode=raw']) {
    const text = await (await fetch(`${app.url}/api/meetings/${meeting.id}/${suffix}`, { headers })).text();
    assert.equal(text.split(sentence(10)).length - 1, 1);
  }
  results.push('copy/plain, corrected Markdown and raw Markdown contain each echoed sentence once');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(results.join('\n'));
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
