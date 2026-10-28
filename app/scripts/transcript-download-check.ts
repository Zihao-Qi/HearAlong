// Real downloads from both menus, using fictional speech and a disposable local server only.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium, type Download, type Page } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const out = resolve(process.argv[2] ?? 'artifacts/transcript-download');
await mkdir(out, { recursive: true });
assert.ok(process.env.MEETING_TEST_CHROME, 'Use an explicit disposable test browser');
const directory = await mkdtemp(join(tmpdir(), 'transcript-download-page-'));
const setup = await dashboardSetup(directory, true);
const app = await startServer({ directory, port: 0, setup, quick: null, heavy: null, drafts: null, notes: null, actions: null, board: null,
  recognizer: { async transcribe() { return { text: '', words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' }; }, close() {} } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: string[] = [], screenshots: string[] = [], errors: string[] = [], failures: string[] = [];
async function checkCase(name: string, check: () => Promise<void>) {
  try { await check(); results.push(name); }
  catch (error) { const message = `${name}: ${(error as Error).message}`; failures.push(message); console.error(message); }
}
try {
  const meeting = app.store.createMeeting('Forest recall: Q3/Q4 café');
  for (const [sequence, startMs, text] of [[0, 0, 'Forest north recall is 0.81.'], [1, 5000, 'Use the per-site table.']] as const) {
    const chunk = await app.store.addPcm(meeting.id, 'mic:fixture', sequence, startMs, 16000, Buffer.alloc(64000, sequence + 1));
    app.store.completeChunk(chunk.id, { text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, timestampKind: 'none' });
  }
  app.store.db.prepare('INSERT INTO capture_gaps (meetingId,source,atMs,fromWallMs,toWallMs,reason) VALUES (?,?,?,?,?,?)')
    .run(meeting.id, 'mic:fixture', 4000, 1000000, 1120000, 'sleep');
  browser = await chromium.launch({ headless: true, executablePath: process.env.MEETING_TEST_CHROME });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US', acceptDownloads: true });
  // No external requests, even if a future page dependency tries to make one.
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(id => localStorage.setItem('meeting-id', id), meeting.id);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.getByText('Forest north recall is 0.81.', { exact: true }).waitFor();
  const filenames = ['Forest recall- Q3-Q4 café transcript.md', 'Forest recall- Q3-Q4 café transcript.txt', 'Forest recall- Q3-Q4 café transcript (raw).md'];
  async function verify(download: Download, i: number, label: string) {
    assert.equal(download.suggestedFilename(), filenames[i]);
    const content = await readFile((await download.path())!, 'utf8');
    if (i === 1) {
      assert.equal(content, 'Forest recall: Q3/Q4 café\n\nForest north recall is 0.81.\n\n[Not recorded for 2 minutes: the Mac was asleep.]\n\nUse the per-site table.\n');
      assert.doesNotMatch(content, /\[\d\d:\d\d:\d\d\]/);
    } else {
      assert.equal(content, app.store.markdown(meeting.id, i === 2 ? 'raw' : 'corrected', 'en-US'));
    }
    await writeFile(join(out, `${label}-${i}.${i === 1 ? 'txt' : 'md'}`), content);
    results.push(`${label}: ${filenames[i]} and content`);
  }
  async function clickDownload(page: Page, selector: string, i: number, label: string) {
    const pending = page.waitForEvent('download');
    await page.locator(selector).click();
    await verify(await pending, i, label);
  }
  for (const [i, id] of ['meeting-export', 'meeting-export-plain', 'meeting-export-raw'].entries()) {
    await page.locator('#meeting-button').click();
    await clickDownload(page, '#' + id, i, 'meeting');
    assert.equal(await page.locator('#meeting-menu').isHidden(), true);
  }
  await page.locator('#meeting-button').focus();
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#meeting-export-plain').evaluate(n => n === document.activeElement), true);
  const keyboardDownload = page.waitForEvent('download'); await page.keyboard.press('Enter');
  await verify(await keyboardDownload, 1, 'keyboard');
  assert.equal(await page.locator('#meeting-menu').isHidden(), true);
  await page.locator('#open-system').click();
  await page.locator('.settings-nav [data-section="export"]').click();
  for (const [i, id] of ['export', 'export-plain', 'export-raw'].entries()) {
    await page.locator('#transcript-options').click();
    await clickDownload(page, '#' + id, i, 'settings');
    assert.equal(await page.locator('#transcript-menu').isHidden(), true);
  }
  await page.locator('#transcript-options').focus(); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#export-plain').evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#transcript-options').evaluate(n => n === document.activeElement), true);
  await page.locator('#transcript-options').click(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#transcript-menu').isHidden(), true);
  await page.locator('#transcript-options').click(); await page.locator('[data-section="export"] h3').click();
  assert.equal(await page.locator('#transcript-menu').isHidden(), true);
  results.push('Settings arrows, Escape focus return, Tab and outside click');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.locator('#transcript-options').click();
    const bounds = await page.locator('#transcript-menu').evaluate(menu => {
      const rect = menu.getBoundingClientRect(), content = menu.closest('.settings-content')!.getBoundingClientRect();
      return { bottom: rect.bottom, right: rect.right, contentBottom: content.bottom, contentRight: content.right };
    });
    assert.ok(bounds.bottom <= bounds.contentBottom && bounds.right <= bounds.contentRight, `${width}: all three downloads fit inside Settings`);
    const settingsShot = `settings-export-${width}.png`;
    await page.screenshot({ path: join(out, settingsShot) }); screenshots.push(settingsShot);
    await page.keyboard.press('Escape'); await page.locator('#close-settings').click();
    await page.locator('#meeting-button').click();
    const meetingShot = `meeting-menu-${width}.png`;
    await page.screenshot({ path: join(out, meetingShot) }); screenshots.push(meetingShot);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.keyboard.press('Escape');
    await page.locator('#open-system').click(); await page.locator('.settings-nav [data-section="export"]').click();
  }
  await checkCase('Settings export row computes to nowrap', async () => {
    assert.equal(await page.locator('.transcript-export-row').evaluate(row => getComputedStyle(row).flexWrap), 'nowrap');
  });
  await checkCase('Raw subtitles share Replay muted-small styling in both menus', async () => {
    const replay = await page.locator('#open-replay span').evaluate(span => ({ font: getComputedStyle(span).fontSize, color: getComputedStyle(span).color }));
    for (const id of ['meeting-export-raw', 'export-raw']) {
      const raw = await page.locator(`#${id} span`).evaluate(span => ({ font: getComputedStyle(span).fontSize, color: getComputedStyle(span).color }));
      assert.deepEqual(raw, replay);
      assert.equal(raw.font, '13px');
    }
  });
  await page.locator('#close-settings').click();
  await checkCase('Space downloads plain text and closes the meeting menu', async () => {
    await page.locator('#meeting-button').focus(); await page.keyboard.press('ArrowDown');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#meeting-export-plain').evaluate(n => n === document.activeElement), true);
    const download = page.waitForEvent('download', { timeout: 5000 });
    await page.keyboard.press('Space');
    await verify(await download, 1, 'space');
    assert.equal(await page.locator('#meeting-menu').isHidden(), true);
  });
  for (let i = 1; i < 15; i++) app.store.createMeeting(`Forest planning ${String(i).padStart(2, '0')}`);
  await page.reload();
  await page.getByText('Forest north recall is 0.81.', { exact: true }).waitFor();
  for (const [width, height] of [[1280, 720], [1280, 600], [390, 640]]) {
    await checkCase(`15 meetings at ${width}×${height}: bounded menu and reachable final action`, async () => {
      await page.setViewportSize({ width, height });
      await page.locator('#meeting-button').click();
      assert.equal(await page.locator('#meeting-list [role="menuitemradio"]').count(), 15);
      const bounds = await page.locator('#meeting-menu').evaluate(menu => {
        const list = menu.querySelector('#meeting-list')!, rows = [...list.children];
        const third = rows[2].getBoundingClientRect(), first = rows[0].getBoundingClientRect();
        return { top: menu.getBoundingClientRect().top, bottom: menu.getBoundingClientRect().bottom,
          listHeight: list.clientHeight, threeRows: third.bottom - first.top, menuHeight: menu.clientHeight, menuScrollHeight: menu.scrollHeight };
      });
      console.log(JSON.stringify({ viewport: { width, height }, ...bounds }));
      const shot = `meeting-menu-15-${width}x${height}.png`;
      await page.screenshot({ path: join(out, shot) }); screenshots.push(shot);
      assert.ok(bounds.bottom <= height - 12, `${width}×${height}: bottom ${bounds.bottom} exceeds ${height - 12}`);
      assert.ok(bounds.top >= 0);
      assert.ok(bounds.listHeight >= bounds.threeRows, 'the list keeps room for at least three meetings');
      if (height === 720) assert.equal(bounds.menuScrollHeight, bounds.menuHeight, 'only the meetings list scrolls when a short list fits');
      const lastMeeting = page.locator('#meeting-list [role="menuitemradio"]').last();
      await lastMeeting.scrollIntoViewIfNeeded();
      const lastVisible = await lastMeeting.evaluate(row => {
        const rect = row.getBoundingClientRect(), list = row.parentElement!.getBoundingClientRect(), menu = row.closest('#meeting-menu')!.getBoundingClientRect();
        return rect.top >= Math.max(list.top, menu.top) && rect.bottom <= Math.min(list.bottom, menu.bottom);
      });
      assert.equal(lastVisible, true, 'the last meeting is reachable inside the list');
      await page.locator('#move-meeting').scrollIntoViewIfNeeded();
      const actionBounds = (await page.locator('#move-meeting').boundingBox())!;
      assert.ok(actionBounds.y >= 0 && actionBounds.y + actionBounds.height <= height - 12);
      await page.locator('#move-meeting').click();
      await page.locator('#project-dialog').waitFor({ state: 'visible' });
      await page.locator('#close-project-dialog').click();
      assert.equal(await page.locator('#meeting-menu').isHidden(), true);
    });
    // A failed geometry assertion must not hide the other viewport regressions.
    if (await page.locator('#meeting-menu').isVisible()) await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'index.md'), '# Transcript download check\n\n' + screenshots.map(s => `- [${s}](${s})`).join('\n') + '\n\n' + results.map(s => `- PASS ${s}`).join('\n') + '\n');
  console.log(JSON.stringify({ results, screenshots, failures, out }, null, 2));
  assert.deepEqual(failures, []);
} finally { await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
