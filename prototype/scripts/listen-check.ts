// Fictional audio only; headless, muted, disposable Chromium and loopback-only requests.
import './check-env.ts';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { dashboardSetup } from '../test/helpers/dashboard-setup.ts';

const out = resolve(process.argv[2] ?? 'artifacts/listen');
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'listen-page-'));
const app = await startServer({ directory, port: 0, setup: await dashboardSetup(directory, true), recognizer: null, drafts: null, quick: null, heavy: null, board: null });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const passed: string[] = [], failures: string[] = [], screenshots: string[] = [];
const result = (text: string) => ({ text, words: [], backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 4, processRssBytes: 0, timestampKind: 'none' as const });
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed.push(name); } catch (error) { failures.push(`${name}: ${(error as Error).message}`); console.error(failures.at(-1)); }
}
async function shot(page: Page, name: string) { const path = join(out, `${name}.png`); await page.screenshot({ path }); screenshots.push(path); }
try {
  const kept = app.store.createMeeting('Fictional shipment');
  for (let i = 0; i < 18; i++) {
    const audio = new Float32Array(64000); for (let j = 0; j < audio.length; j++) audio[j] = .1 * Math.sin(j * 2 * Math.PI * (220 + i * 20) / 16000);
    const c = await app.store.addPcm(kept.id, 'mic:fiction', i, i * 4000, 16000, Buffer.from(audio.buffer));
    app.store.completeChunk(c.id, result(`Fictional line ${i + 1}: check the shipping quote before Friday.`));
  }
  app.store.db.prepare('INSERT INTO capture_gaps (meetingId,source,atMs,fromWallMs,toWallMs,reason) VALUES (?,?,?,?,?,?)')
    .run(kept.id, 'mic:fiction', 3000, 1000000, 1010000, 'sleep');
  const online = app.store.createMeeting('Fictional online meeting');
  for (const [source, text] of [['mic:fiction', 'I will check the quote.'], ['tab:fiction', 'Please check the shipping too.']] as const) {
    const c = await app.store.addPcm(online.id, source, 0, 0, 16000, Buffer.alloc(64000)); app.store.completeChunk(c.id, result(text));
  }
  const empty = app.store.createMeeting('Fictional no audio');
  const gone = app.store.createMeeting('Fictional deleted');
  for (const m of [empty, gone]) {
    const c = await app.store.addPcm(m.id, 'mic:fiction', 0, 0, 16000, Buffer.alloc(64000)); app.store.completeChunk(c.id, result('The transcript remains readable.'));
    app.store.db.prepare("UPDATE chunks SET path='' WHERE meetingId=?").run(m.id);
  }
  app.store.db.prepare('UPDATE meetings SET audioRemovedAt=1, audioRemovedAfter=? WHERE id=?').run('1 month', gone.id);
  app.store.db.prepare('UPDATE meetings SET audioEmpty=1 WHERE id=?').run(empty.id);
  browser = await chromium.launch({ args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  await context.addInitScript(id => localStorage.setItem('meeting-id', id), kept.id);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url); await page.locator('.para[data-kind="final"]').first().waitFor();
  const times = page.locator('.listen-time');
  await check('hover and focus expose only icon/tint, preserving text geometry', async () => {
    await times.first().scrollIntoViewIfNeeded(); await page.mouse.move(1250, 20);
    const before = await times.first().evaluate(n => ({ color: getComputedStyle(n).color, text: n.closest('.para')!.querySelector('p')!.getBoundingClientRect().toJSON(), icon: getComputedStyle(n, '::before').opacity }));
    assert.equal(before.icon, '0');
    assert.equal(await page.locator('.para:not([data-kind="final"]) .listen-time').count(), 0);
    await times.first().hover();
    const after = await times.first().evaluate(n => ({ color: getComputedStyle(n).color, bg: getComputedStyle(n).backgroundColor, text: n.closest('.para')!.querySelector('p')!.getBoundingClientRect().toJSON(), icon: getComputedStyle(n, '::before').opacity, content: getComputedStyle(n, '::before').content }));
    assert.equal(after.icon, '1'); assert.match(after.content, /▶/); assert.equal(after.bg, 'rgb(238, 242, 253)'); assert.notEqual(after.color, before.color); assert.deepEqual(after.text, before.text);
    await shot(page, 'hover-wide'); await times.first().focus(); await page.mouse.move(1250, 20);
    assert.equal(await times.first().evaluate(n => getComputedStyle(n, '::before').opacity), '1');
  });
  async function timeGeometry() {
    return times.first().evaluate(button => {
      const time = button.closest('time')!, digits = document.createRange(); digits.selectNodeContents(button);
      const pill = button.getBoundingClientRect(), icon = getComputedStyle(button, '::before');
      const iconLeft = pill.left + parseFloat(icon.left);
      const iconRight = iconLeft + parseFloat(icon.width);
      return { textX: digits.getBoundingClientRect().left, originalX: time.getBoundingClientRect().left,
        iconLeft, iconRight, pillLeft: pill.left, pillRight: pill.right };
    });
  }
  await check('hover triangle stays inside the pill; time digits keep the original wide and compact x', async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 860 }); if (width === 390) await page.locator('#ctab-live').click();
      await times.first().hover(); const geometry = await timeGeometry();
      assert.ok(Math.abs(geometry.textX - geometry.originalX) < .5, JSON.stringify(geometry));
      assert.ok(geometry.iconLeft >= geometry.pillLeft && geometry.iconRight <= geometry.pillRight, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.textX - geometry.iconRight - 5) < 1, JSON.stringify(geometry));
      await shot(page, `hover-pill-${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 860 });
  });
  await check('keyboard focus is distinct from hover on time and player controls', async () => {
    await page.locator('#transcript').focus(); await page.keyboard.press('Tab');
    const focus = await times.first().evaluate(n => ({ focused: n.matches(':focus-visible'), style: getComputedStyle(n).outlineStyle, width: getComputedStyle(n).outlineWidth, color: getComputedStyle(n).outlineColor }));
    assert.deepEqual(focus, { focused: true, style: 'solid', width: '2px', color: 'rgb(47, 86, 198)' }); await shot(page, 'focus-ring');
    await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    try {
      for (const selector of ['#listen-toggle', '#listen-position', '#listen-speed', '#listen-close']) {
        await page.locator(selector).focus();
        assert.equal(await page.locator(selector).evaluate(n => getComputedStyle(n).outlineColor), 'rgb(47, 86, 198)');
        assert.equal(await page.locator(selector).evaluate(n => getComputedStyle(n).outlineWidth), '2px');
      }
    } finally { await page.locator('#listen-close').click(); }
  });
  await check('play/pause use centred aria-hidden mockup SVGs', async () => {
    await times.first().click(); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    try {
      const icon = page.locator('#listen-toggle svg'); assert.equal(await icon.count(), 1);
      assert.equal(await icon.getAttribute('aria-hidden'), 'true');
      assert.equal(await icon.locator('path').getAttribute('d'), 'M3 2h3v10H3zM8 2h3v10H8z');
      const control = (await page.locator('#listen-toggle').boundingBox())!, box = (await icon.boundingBox())!;
      assert.equal(control.width, 44); assert.equal(control.height, 44);
      assert.ok(Math.abs(box.x + box.width / 2 - control.x - control.width / 2) < .5);
      assert.ok(Math.abs(box.y + box.height / 2 - control.y - control.height / 2) < .5);
      await shot(page, 'playing-pause-icon'); await page.locator('#listen-toggle').click();
      assert.equal(await icon.locator('path').getAttribute('d'), 'M3.5 2l9 5-9 5z'); await shot(page, 'paused-play-icon');
    } finally { await page.locator('#listen-close').click(); }
  });
  await check('line playback, heard tint, speed, slider, end and Close', async () => {
    await times.nth(1).click(); await page.locator('#listen-player').waitFor();
    await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && Math.abs(a.currentTime - 4) <= .25; });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    assert.equal(await page.locator('.para.heard').count(), 1);
    assert.equal(await page.locator('.para.heard').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(238, 242, 253)');
    await shot(page, 'playing-wide');
    for (const rate of [1.25, 1.5, 2, 1]) {
      await page.locator('#listen-speed').click(); assert.equal(await page.locator('audio').evaluate(a => (a as HTMLAudioElement).playbackRate), rate);
      assert.equal(await page.locator('#listen-speed').getAttribute('aria-label'), `Speed ${rate}×. Change speed`);
    }
    await page.locator('#listen-position').evaluate(n => new Promise<void>(resolve => {
      document.querySelector('audio')!.addEventListener('seeked', () => resolve(), { once: true });
      (n as HTMLInputElement).value = '12'; n.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    await page.waitForFunction(() => document.querySelector('audio')!.currentTime === 12);
    await page.waitForFunction(() => document.querySelector('.para.heard .listen-time')?.textContent === '00:12');
    await shot(page, 'seek-wide');
    // Existing M9a selection guard: seeking must not move selected text.
    await page.locator('#transcript').evaluate(box => { const n = box.querySelector('.para p')!; const r = document.createRange(); r.selectNodeContents(n); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    const selectedTop = await page.locator('#transcript').evaluate(n => n.scrollTop);
    // Observe completion after the player's own seeked handler, not an arbitrary delay.
    const seek = (seconds: number) => page.locator('audio').evaluate((a, seconds) => new Promise<void>(resolve => {
      a.addEventListener('seeked', () => resolve(), { once: true }); (a as HTMLAudioElement).currentTime = seconds;
    }), seconds);
    await seek(60);
    assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), selectedTop);
    // Clearing the selection also renders: finish that before simulating the user's scroll.
    await page.evaluate(() => new Promise<void>(resolve => {
      document.addEventListener('selectionchange', () => resolve(), { once: true }); getSelection()!.removeAllRanges();
    }));
    // scrollTop changes synchronously, but its scroll event need not arrive within 50 ms on a displayless runner.
    await page.locator('#transcript').evaluate(box => new Promise<void>(resolve => {
      box.addEventListener('scroll', () => resolve(), { once: true }); box.scrollTop = 20;
    }));
    await seek(64);
    assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), 20);
    assert.equal(await page.locator('audio').evaluate(a => (a as HTMLAudioElement).preservesPitch), true);
    await seek(await page.locator('audio').evaluate(a => (a as HTMLAudioElement).duration - .15));
    await page.locator('audio').evaluate(a => (a as HTMLAudioElement).play());
    await page.waitForFunction(() => document.querySelector('audio')!.ended);
    assert.equal(await page.locator('#listen-toggle').getAttribute('aria-label'), 'Play');
    await page.locator('#listen-toggle').click(); await page.waitForFunction(() => document.querySelector('audio')!.currentTime < 1);
    await page.getByRole('button', { name: 'Close the player', exact: true }).click();
    assert.equal(await page.locator('#listen-player').count(), 0); assert.equal(await page.locator('audio').count(), 0); await shot(page, 'closed');
  });
  await check('compact 44px time column, docked bar, no overflow at 390px', async () => {
    await page.setViewportSize({ width: 390, height: 860 }); await page.locator('#ctab-live').click();
    await times.first().click(); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const rects = await page.evaluate(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
      return { column: rect('.para time'), bar: rect('#listen-player'), box: rect('#transcript'), pane: rect('#transcript-pane'), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(rects.column.width, 44); assert.ok(rects.box.bottom <= rects.bar.top + 1); assert.ok(Math.abs(rects.pane.bottom - rects.bar.bottom) <= 1); assert.equal(rects.overflow, false);
    await shot(page, 'compact-playing');
  });
  async function switchTo(title: string) { await page.locator('#meeting-button').click(); await page.locator('#meeting-list [role="menuitemradio"]').filter({ has: page.getByText(title, { exact: true }) }).click(); }
  await check('switch closes player; deleted and empty messages', async () => {
    await switchTo(gone.title); assert.equal(await page.locator('#listen-player').count(), 0);
    await times.first().click(); await page.getByText('This meeting’s audio was deleted 1 month after the meeting. To keep it longer: Settings › Keep audio for.', { exact: true }).waitFor(); await shot(page, 'deleted');
    await switchTo(empty.title); await times.first().click(); await page.getByText('There is no audio for this meeting.', { exact: true }).waitFor(); await shot(page, 'empty');
  });
  await check('recording anywhere stops playback and prevents media requests', async () => {
    await switchTo(kept.title); await times.first().click(); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    const source = `tab:${randomUUID()}`;
    await app.capture.accept(empty.id, source, 0, 0, Buffer.alloc(64000));
    await page.getByText('You can listen once the recording stops, so the microphone doesn’t record the playback.', { exact: true }).waitFor();
    assert.equal(await page.locator('audio').count(), 0); await shot(page, 'recording');
    const requests: string[] = []; page.on('request', req => { if (req.url().includes('/audio')) requests.push(req.url()); });
    await times.nth(1).click(); await page.waitForTimeout(200); assert.deepEqual(requests, []);
    await app.capture.end(empty.id, source, 0);
  });
  await check('removal while player is open maps server 410 to deletion copy', async () => {
    await page.getByRole('button', { name: 'Close the player', exact: true }).click();
    await page.waitForResponse(async response => response.url().endsWith('/api/status') && !(await response.json()).recordingAnywhere);
    await times.first().click(); await page.locator('audio').waitFor({ state: 'attached' });
    app.store.db.prepare('UPDATE meetings SET audioRemovedAt=1, audioRemovedAfter=? WHERE id=?').run('1 week', kept.id);
    await page.locator('audio').evaluate(a => a.dispatchEvent(new Event('error')));
    await page.getByText('This meeting’s audio was deleted 1 week after the meeting. To keep it longer: Settings › Keep audio for.', { exact: true }).waitFor(); await shot(page, 'removed-open');
  });
  await check('online hover pill never intersects its speaker label', async () => {
    await page.setViewportSize({ width: 1280, height: 860 }); await switchTo(online.title);
    await page.locator('.speaker').first().waitFor(); await times.first().hover();
    const boxes = await times.first().evaluate(button => ({ button: button.getBoundingClientRect().toJSON(), speaker: button.closest('time')!.querySelector('.speaker')!.getBoundingClientRect().toJSON() }));
    assert.ok(boxes.button.bottom <= boxes.speaker.top, JSON.stringify(boxes)); await shot(page, 'hover-online-speaker');
    assert.ok(Math.abs((await timeGeometry()).textX - (await timeGeometry()).originalX) < .5);
  });
  await check('closing playback preserves 4500 → 0 → 0 after the next unchanged render; explicit Jump still follows', async () => {
    const follow = await context.newPage();
    follow.on('pageerror', error => console.error(`follow fixture: ${error.message}`));
    try {
      await follow.route('**/listen-follow-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>#box{height:300px;overflow-y:auto;overflow-anchor:none}.para{height:60px}p{margin:0}</style><div id="box"></div><script type="module">
import {createTranscriptView} from '/transcript-view.js';
window.snapshot={segments:Array.from({length:80},(_,i)=>({id:'fictional-'+i+':0',revision:0,startMs:i*4000,endMs:(i+1)*4000,text:'Fictional line '+i}))};
window.view=createTranscriptView(document.querySelector('#box'),{segmentNode:s=>document.createTextNode(s.text)});
window.view.render(window.snapshot);window.ready=true;
</script>` }));
      await follow.goto(app.url + '/listen-follow-fixture'); await follow.waitForFunction(() => (window as any).ready);
      const positions = await follow.evaluate(() => {
        const box = document.querySelector('#box')!, { view, snapshot } = window as any;
        const before = box.scrollTop; view.hear(1000); const during = box.scrollTop;
        view.hear(null); const closed = box.scrollTop; view.render(snapshot); const nextPoll = box.scrollTop;
        const following = view.following; view.follow(); return { before, during, closed, nextPoll, following, jumped: box.scrollTop };
      });
      await writeFile(join(out, 'follow-positions.json'), JSON.stringify(positions, null, 2));
      assert.deepEqual(positions, { before: 4500, during: 0, closed: 0, nextPoll: 0, following: false, jumped: 4500 });
    } finally { await follow.close(); }
  });
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await app.close(); await rm(directory, { recursive: true, force: true });
  await writeFile(join(out, 'results.json'), JSON.stringify({ passed, failures, screenshots, modelsCalled: false }, null, 2));
}
if (failures.length) throw new Error(failures.join('\n'));
console.log(JSON.stringify({ passed, screenshots, modelsCalled: false }, null, 2));
