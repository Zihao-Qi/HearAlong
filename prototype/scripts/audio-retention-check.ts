// Model-free retention UI check; all data is temporary, browser uses an isolated profile.
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright-core';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.ts';
import { AUDIO_RETENTION } from '../src/audio-retention.ts';

const directory = await mkdtemp(join(tmpdir(), 'audio-ui-'));
let browser: Browser | undefined;
let app: Awaited<ReturnType<typeof startServer>> | undefined;
const screenshots: string[] = [];
const previousModelPath = process.env.MEETING_MODEL_PATH;
try {
  const standIn = join(directory, 'model-stand-in');
  await writeFile(standIn, 'Not a model. The recognizer below is scripted.');
  process.env.MEETING_MODEL_PATH = standIn;
  app = await startServer({ directory, port: 0, recognizer: { async transcribe() {
    return { text: 'A fresh recording continues this meeting.', backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const };
  }, close() {} }, drafts: null, quick: null, heavy: null });
  for (let i = 0; i < 2; i++) {
    const m = app.store.createMeeting(`Older meeting ${i + 1}`);
    const c = await app.store.addPcm(m.id, 'mic:take', 0, 0, 16000, Buffer.alloc(64000));
    app.store.completeChunk(c.id, { text: 'The transcript and notes stay on this Mac.', backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' });
    app.store.db.prepare('UPDATE meetings SET audioLegacy=1, audioDoneAt=? WHERE id=?').run(Date.now() - 3 * AUDIO_RETENTION.day, m.id);
  }
  await app.audioRetention.run();
  browser = await chromium.launch({ executablePath: process.env.MEETING_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  await mkdir(resolve('artifacts'), { recursive: true });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(app.url);
      await page.locator('#older-audio').waitFor({ state: 'visible' });
      assert.match(await page.locator('#older-audio-text').innerText(), /Remove the audio of 2 older meetings \(0.1 MB\)\? Transcripts and notes are kept\./);
      assert.equal(await page.locator('#audio-removed').isVisible(), false);
      for (const id of ['remove-older-audio', 'keep-older-audio']) assert.ok((await page.locator('#' + id).boundingBox())!.height >= 44);
      const question = resolve(`artifacts/audio-retention-question-${width}.png`);
      await page.screenshot({ path: question }); screenshots.push(question);
      await page.locator('#open-system').click();
      await page.locator('#settings button[data-section="speech"]').click();
      assert.equal(await page.locator('#audio-retention').inputValue(), 'day');
      assert.deepEqual(await page.locator('#audio-retention option').allTextContents(), ['1 day', '1 week', '1 month', 'Always']);
      assert.ok((await page.locator('#audio-retention').boundingBox())!.height >= 44);
      assert.equal(await page.locator('#retry').isVisible(), false);
      const settings = resolve(`artifacts/audio-retention-settings-${width}.png`);
      await page.screenshot({ path: settings }); screenshots.push(settings);
      const savedMonth = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
      await page.locator('#audio-retention').selectOption('month');
      assert.equal((await (await savedMonth).json()).audioRetention, 'month');
      assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).audioRetention, 'month');
      await page.waitForFunction(() => !document.getElementById('audio-retention')?.dataset.running);
      const savedDay = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
      await page.locator('#audio-retention').selectOption('day');
      assert.equal((await (await savedDay).json()).audioRetention, 'day');
      await page.locator('#close-settings').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.goto(app.url);
  await page.locator('#remove-older-audio').click();
  await page.locator('#older-audio').waitFor({ state: 'hidden' });
  await page.locator('#audio-removed').getByText('Audio removed after 1 day', { exact: true }).waitFor();
  await page.locator('#open-system').click();
  await page.locator('#settings button[data-section="speech"]').click();
  assert.equal(await page.locator('#retry').isVisible(), false);
  await page.locator('#close-settings').click();
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording', { exact: false }).waitFor();
  await page.waitForTimeout(2500); // the fake microphone must actually deliver frames before Stop
  await page.locator('#stop').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden' });
  await page.locator('#transcript').getByText('A fresh recording continues this meeting.', { exact: false }).waitFor();
  await page.locator('#audio-removed').waitFor({ state: 'hidden' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const path = resolve(`artifacts/audio-retention-resumed-${width}.png`);
    await page.screenshot({ path }); screenshots.push(path);
  }
  console.log(JSON.stringify({ checks: 'passed', screenshots, modelsCalled: false }, null, 2));
} finally {
  if (previousModelPath === undefined) delete process.env.MEETING_MODEL_PATH;
  else process.env.MEETING_MODEL_PATH = previousModelPath;
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
