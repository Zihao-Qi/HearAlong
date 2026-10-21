import { chromium } from 'playwright-core';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import type { ActionRunner } from '../src/actions.ts';
import { LiveDrafts } from '../src/drafts.ts';

// Fictional lantern-workshop check. With real local STT, supply generated speech matching the workshop lines below.
// MEETING_TEST_NO_MODELS=1 substitutes speech too (no model calls); a generated WAV still drives replay and capture.
const directory = await mkdtemp(join(tmpdir(), 'meeting-browser-'));
const audio = resolve('artifacts/synthetic-meeting.wav');
const screenshot = resolve('artifacts/dashboard.png');
// A scripted notes model: cites the first transcript line and quotes its first words (no cloud call).
const notes = async ({ inputPath }: { inputPath: string }) => {
  const first = (await readFile(inputPath, 'utf8')).split('\n').find(line => /^S1 /.test(line))!;
  const quote = first.replace(/^S1 \[[^\]]+\] /, '').split(' ').slice(0, 8).join(' ');
  return { text: JSON.stringify({ summary: [{ text: 'Thirty-six lanterns are ready for the evening parade.', cites: ['S1'], quote }], decisions: [], actions: [], openQuestions: [],
    otherMatters: [{ text: 'Check the repair cafe intake limit for Saturday.', kind: 'todo', label: 'admin', cites: ['S1'], quote }], otherTalk: [] }), model: 'scripted' };
};
// A scripted action model (no cloud call): streams a status and a draft, then answers with one checkable citation.
const actions: ActionRunner = async ({ action, inputPath, onEvent, signal }) => {
  const input = await readFile(inputPath, 'utf8');
  const rootId = /^- ([0-9a-f-]{36}): .*inventory\.md \(file\)$/m.exec(input)?.[1];
  const web = action === 'lookUp';
  onEvent({ type: 'tool_execution_start', toolName: web ? 'web_search' : 'read', args: { path: '/m/inventory.md', query: 'repair cafe intake limit' } });
  onEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working on it…' } });
  await new Promise(r => setTimeout(r, 1500));
  if (signal.aborted) throw new Error('Pi task was cancelled.');
  const meta = (sources: unknown[]) => `\n<<<META\n${JSON.stringify({ sources, assumptions: web ? [] : ['Inventory reflects the latest battery check'], openPoints: [] })}\nMETA>>>`;
  const text = web ? 'The repair cafe accepts at most **7** items per visitor [1].' + meta([{ id: 1, type: 'web', url: 'https://example.org/repair-cafe', title: 'Repair cafe intake', quote: 'The repair cafe accepts at most 7 items per visitor.' }])
    : '**36** lanterns passed the battery check [1].' + meta([{ id: 1, type: 'file', rootId, path: 'inventory.md', lines: '3', quote: 'Ready lantern count after the battery check: 36.' }]);
  return { text, ms: 1500, tools: [], aborted: false, stopReason: 'stop', exitCode: 0, exitSignal: null, settled: true, toolEvents: 1, provider: 'scripted', model: 'scripted',
    toolResults: web ? [{ id: '1', name: 'fetch_content', args: { url: 'https://example.org/repair-cafe' }, isError: false, text: 'The repair cafe accepts at most 7 items per visitor.' }] : [] };
};
// A scripted quick model for the board: one question card citing the first new line, quoting its first words.
const board = async (message: string) => {
  const line = message.split('\n').find(l => /^S\d+ \[[^\]]+\] NEW /.test(l))!;
  const ref = line.split(' ')[0];
  const quote = line.replace(/^S\d+ \[[^\]]+\] NEW /, '').split(' ').slice(0, 8).join(' ');
  return { text: JSON.stringify({ items: [{ type: 'question', text: 'How many lanterns passed the battery check?', cites: [ref], quote, confidence: 'medium', materials: true, nonProject: false }] }),
    ms: 1, attempts: 1, stopReason: 'stop', aborted: false, usages: [] };
};
const noModels = process.env.MEETING_TEST_NO_MODELS === '1';
const serve = () => startServer({ directory, port: 0, quick: null, heavy: null, notes, actions, board,
  ...(noModels ? { recognizer: { async transcribe() { return { text: 'The workshop has thirty-six lanterns ready for the evening parade. Please check the repair cafe intake limit for Saturday.',
    backend: 'scripted', computeMs: 1, decodeMs: 1, audioSeconds: 1, processRssBytes: 0, words: [], timestampKind: 'none' as const }; }, close() {} },
  drafts: new LiveDrafts({ modelPath: 'unused', workerScript: new URL('../test/fixtures/fake-stream-worker.ts', import.meta.url) }) } : {}) });
let app = await serve();
const browser = await chromium.launch({
  executablePath: process.env.MEETING_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  // Only a generated file is used as a fake microphone. No physical device is accessed.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audio}`],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  // The meeting menu (top bar): a new meeting is named in place; a meeting is picked from the list.
  const newMeeting = async (title: string) => {
    await page.locator('#meeting-button').click();
    await page.locator('#new-meeting').click();
    await page.locator('#meeting-name').waitFor();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.locator('#meeting-title', { hasText: title }).waitFor();
  };
  const pickMeeting = async (title: string) => {
    await page.locator('#meeting-button').click();
    await page.locator('#meeting-list button', { hasText: title }).first().click();
    await page.locator('#meeting-title', { hasText: title }).waitFor();
  };
  await page.goto(app.url);
  await page.locator('#live-chip').waitFor({ state: 'hidden' });
  assert.equal(app.store.meetings().length, 0);

  // Replay a recording at 16x into a fresh meeting.
  await page.locator('#meeting-button').click();
  await page.locator('#open-replay').click();
  await page.locator('#replay-file').setInputFiles(audio);
  await page.locator('#replay-speed').selectOption('16');
  await page.locator('#replay').click();
  await page.locator('#live-chip').getByText(/Replay/).waitFor();
  await page.waitForFunction(() => document.getElementById('transcript')?.textContent?.includes('lanterns'), null, { timeout: 60_000 });
  const replayMeeting = app.store.meetings()[0];
  assert.ok(app.store.segments(replayMeeting.id).length >= 1, 'segments were published');
  assert.match(app.store.markdown(replayMeeting.id), /parade/);

  // A selection survives polling refreshes and opens the action menu.
  await page.evaluate(() => {
    const p = document.querySelector('#transcript .para p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator('#selection-menu').waitFor({ state: 'visible' });
  await page.waitForTimeout(2500); // two or more refresh cycles
  assert.ok((await page.evaluate(() => window.getSelection()!.toString())).includes('lanterns'), 'selection kept across refreshes');
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.locator('#selection-menu').waitFor({ state: 'hidden' });

  // Material attach and search (read-only).
  const material = join(directory, 'inventory.md');
  await writeFile(material, '# Lantern workshop inventory\nReady: 36\nReady lantern count after the battery check: 36.\n');
  await page.locator('#open-meeting').click();
  await page.locator('#material-path').fill(material);
  await page.locator('#attach').click();
  await page.locator('#materials').getByText('inventory.md (file)').waitFor();
  await page.locator('#query').fill('Ready');
  await page.locator('#search').click();
  await page.locator('#search-results').getByText(/Ready: 36/).waitFor();

  // Live microphone path: worklet → PCM uploads → disk queue → native STT.
  await page.locator('#settings [data-close-panel]').click();
  await newMeeting('Synthetic live meeting');
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor();
  await page.waitForTimeout(6200);
  const during = await page.evaluate(async () => { const id = localStorage.getItem('meeting-id'); return (await fetch(`/api/meetings/${id}/segments`)).json(); });
  assert.equal(during.draftsAvailable, true, 'live drafts run while recording');
  await page.locator('#stop').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden' });
  const liveMeeting = app.store.meetings().find(m => m.title === 'Synthetic live meeting')!;
  const microphone = app.store.chunks(liveMeeting.id).filter(c => c.source.startsWith('mic:'));
  const frames = app.store.db.prepare('SELECT samples, windowChunkId FROM frames WHERE meetingId=?').all(liveMeeting.id) as { samples: number; windowChunkId: string | null }[];
  assert.ok(frames.length >= 6 && frames.some(f => f.samples < 16000), '1 s frames and the flushed partial tail are saved');
  assert.ok(frames.every(f => f.windowChunkId === microphone[0]?.id) && microphone.length === 1, 'stop seals every frame into one window');
  assert.equal(microphone[0].sampleRate, 16000);
  assert.ok(Math.abs(microphone[0].seconds - frames.reduce((n, f) => n + f.samples, 0) / 16000) < 1e-6, 'the window holds exactly its frames');
  await app.jobs!.wait();
  assert.ok(app.store.chunks(liveMeeting.id).every(c => c.status === 'completed'));
  await page.waitForFunction(() => document.querySelectorAll('#transcript .para').length > 0, null, { timeout: 30_000 });

  // Online meeting: microphone + a meeting tab. Automated Chrome cannot capture a real tab here (macOS screen-recording
  // permission), so getDisplayMedia is replaced by a stand-in: a 330 Hz tone on the RIGHT channel only (a mono pick of the
  // left channel would save silence), plus a video track that reports a browser tab. Everything after the call is the app's code.
  await page.evaluate(() => {
    (window as any).__tabTracks = [];
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator(); osc.frequency.value = 330;
      const merger = ctx.createChannelMerger(2);
      osc.connect(merger, 0, 1); // right channel only
      const dest = ctx.createMediaStreamDestination(); dest.channelCount = 2; merger.connect(dest); osc.start();
      const canvas = document.createElement('canvas'); canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
      const video = canvas.captureStream(1).getVideoTracks()[0];
      Object.defineProperty(video, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      const audioTrack = dest.stream.getAudioTracks()[0];
      (window as any).__tabTracks.push(audioTrack);
      return new MediaStream([video, audioTrack]);
    };
  });
  await newMeeting('Synthetic online meeting');
  await page.locator('#start').click();
  await page.locator('#start-online').click();
  await page.locator('#live-chip').getByText('mic + tab').waitFor({ timeout: 15_000 });
  check: {
    await page.waitForTimeout(4200);
    // The user stops sharing: the tab source ends, the microphone keeps recording.
    await page.evaluate(() => { for (const t of (window as any).__tabTracks) { t.stop(); t.dispatchEvent(new Event('ended')); } });
    await page.locator('#live-chip').getByText(/^Recording(?! · mic)/).waitFor();
    assert.ok(await page.locator('#add-tab').isVisible(), 'Add meeting tab is offered again after the tab ended');
    const online = app.store.meetings().find(m => m.title === 'Synthetic online meeting')!;
    const framesOf = (kind: string) => app.store.db.prepare(`SELECT COUNT(*) AS n FROM frames WHERE meetingId=? AND source LIKE '${kind}:%'`).get(online.id) as { n: number };
    const micBefore = framesOf('mic').n;
    await page.waitForTimeout(2500);
    assert.ok(framesOf('mic').n > micBefore, 'the microphone keeps recording after the tab ended');
    await page.locator('#stop').click();
    await page.locator('#live-chip').waitFor({ state: 'hidden' });
    await app.jobs!.wait();
    const chunks = app.store.chunks(online.id);
    const tab = chunks.filter(c => c.source.startsWith('tab:')), mic = chunks.filter(c => c.source.startsWith('mic:'));
    assert.ok(tab.length >= 1 && mic.length >= 1, 'both sources saved windows');
    // The right-only tone reached the saved mono audio (downmix of both channels).
    const pcm = new Float32Array((await readFile(app.store.resolvePath(tab[0].path))).buffer.slice(0));
    const rms = Math.sqrt(pcm.reduce((n, x) => n + x * x, 0) / pcm.length);
    assert.ok(rms > 0.05, `the tab audio is silent (rms ${rms}): a channel was dropped`);
    // Both sources share one clock: the tab started within a second of the microphone, and its audio lies inside the mic's span.
    const tabStart = Math.min(...tab.map(c => c.startMs)), micStart = Math.min(...mic.map(c => c.startMs));
    assert.ok(tabStart >= micStart && tabStart - micStart < 3000, `tab start ${tabStart} vs mic ${micStart}`);
    assert.equal(app.store.speakers(online.id).labelled, true);
    break check;
  }
  // A cancelled share, slower than nothing: microphone only, a message, no unhandled rejection. Then a tab whose audio
  // ended before it could be wired: no phantom source, Add meeting tab stays offered.
  for (const variant of ['cancelled', 'dead'] as const) {
    await page.evaluate(kind => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        if (kind === 'cancelled') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination(); ctx.createOscillator().connect(dest);
        const canvas = document.createElement('canvas'); canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
        const video = canvas.captureStream(1).getVideoTracks()[0];
        Object.defineProperty(video, 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
        const audio = dest.stream.getAudioTracks()[0]; audio.stop(); // ended before the app can use it
        return new MediaStream([video, audio]);
      };
    }, variant);
    await page.locator('#start').click();
    await page.locator('#start-online').click();
    await page.locator('#live-chip').getByText('Recording').waitFor();
    await page.waitForTimeout(1500);
    assert.doesNotMatch(await page.locator('#live-chip').textContent() ?? '', /tab/, `${variant}: a tab source was added`);
    assert.ok(await page.locator('#add-tab').isVisible(), `${variant}: Add meeting tab is not offered`);
    assert.match(await page.locator('#log').textContent() ?? '', /Recording the microphone only/, `${variant}: no fallback message`);
    await page.locator('#stop').click();
    await page.locator('#live-chip').waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, [], 'no page errors (unhandled rejections) in the online scenarios');
  await mkdir(resolve('artifacts'), { recursive: true });
  await pickMeeting(replayMeeting.title);
  await page.waitForFunction(() => document.getElementById('transcript')?.textContent?.includes('parade'));
  // Notes tab: write notes, then a citation chip scrolls to and highlights the cited line.
  await page.locator('#tab-notes').click();
  await page.locator('#write-notes').click();
  await page.locator('#notes-body .note').first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('#write-notes').isVisible(), false);
  assert.equal(await page.locator('#notes-warnings').isVisible(), false);
  await page.locator('#notes-options').click();
  await page.locator('#notes-menu').getByText('AI notes: check a quote before relying on it.').waitFor();
  const exportUrl = new URL((await page.locator('#export-notes').getAttribute('href'))!, app.url).href;
  const exported = await (await page.request.get(exportUrl)).text();
  assert.match(exported, /AI draft from the transcript/);
  assert.match(exported, /Thirty-six lanterns are ready for the evening parade/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-notes').click()]);
  assert.equal(await readFile((await download.path())!, 'utf8'), exported, 'Download keeps the notes Markdown and warnings');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__copiedNotes = text; },
    } });
  });
  await page.locator('#notes-options').click();
  await page.locator('#copy-notes').click();
  await page.waitForFunction(() => typeof (window as any).__copiedNotes === 'string');
  assert.equal(await page.evaluate(() => (window as any).__copiedNotes), exported, 'Copy uses the same Markdown, including warnings');
  await page.locator('#notes-body .note-time').first().click();
  assert.equal(await page.locator('#notes-body .note-details').first().isVisible(), true);
  await page.locator('#notes-body .cite').first().click();
  await page.locator('#transcript span.flash').first().waitFor();

  // M3: select text → Answer → a card streams its status, then shows the answer with a checked citation.
  await page.locator('#tab-board').click();
  await page.evaluate(() => {
    const p = document.querySelector('#transcript .para p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.locator('#selection-menu').waitFor({ state: 'visible' });
  await page.locator('#selection-menu button[data-action="answer"]').click();
  await page.locator('.action-card .action-status').getByText('Reading inventory.md').waitFor();
  await page.locator('.action-card .check-pill.ok').getByText('1/1 quotes found').waitFor({ timeout: 15_000 });
  await page.locator('.action-card .answer strong').getByText('36', { exact: true }).waitFor();
  await page.locator('.action-card .cite-ref').first().click();
  await page.locator('.action-card details.source[open]').waitFor();
  // A follow-up is threaded inside its parent card.
  await page.locator('.action-card button', { hasText: 'Ask a follow-up' }).click();
  await page.locator('.follow-form input').fill('Do those all have charged batteries?');
  await page.locator('.follow-form button[type="submit"]').click();
  await page.locator('.action-card .thread .action-card .check-pill.ok').waitFor({ timeout: 15_000 });
  // Look into it on an Other matters card: runs as Look up, feedback on the Notes tab, badge on Board.
  await page.locator('#tab-notes').click();
  await page.locator('#notes-body > .notes-fold > summary', { hasText: 'Not about the project' }).click();
  await page.locator('#notes-body .notes-fold .note-time').first().click();
  await page.locator('.look-into button', { hasText: 'Look into it' }).click();
  await page.locator('.look-form button', { hasText: 'Look up on the web' }).click();
  await page.locator('.look-into button', { hasText: 'View on Board' }).waitFor();
  await page.locator('#board-badge:not([hidden])').waitFor();
  await page.locator('.look-into button', { hasText: 'View on Board' }).click();
  await page.locator('.action-card', { hasText: 'Look up' }).locator('.check-pill.ok').waitFor({ timeout: 15_000 });
  assert.equal(await page.evaluate(() => scrollY), 0, 'the page never scrolls');

  // M4: the replayed meeting gets a board card from the quick model; Investigate answers inside the card.
  await page.locator('#tab-board').click();
  await page.locator('#scan-board').click();
  const card = page.locator('.board-card').first();
  await card.waitFor({ timeout: 30_000 }).catch(async error => {
    console.log('BOARD DEBUG', JSON.stringify(await page.evaluate(async id => { const r = await fetch(`/api/meetings/${id}/board`); return { status: r.status, body: (await r.text()).slice(0, 1500) }; }, replayMeeting.id)));
    console.log('SEGMENTS', JSON.stringify(app.store.segments(replayMeeting.id).map(x => [x.state, x.text.slice(0, 40)])));
    console.log('SCANS', JSON.stringify(JSON.parse(await readFile(join(directory, 'board', `${replayMeeting.id}.json`), 'utf8')).scans));
    throw error;
  });
  await card.locator('.action-head .tag', { hasText: 'Question' }).waitFor(); // the type says it is a suggestion; no extra chip
  assert.equal(await card.locator('.prov').count(), 0, 'no separate provenance chip');
  await card.locator('button', { hasText: 'Investigate' }).click();
  await card.locator(':scope > .action-head .check-pill.ok').waitFor({ timeout: 15_000 });
  assert.equal(await card.locator('.card-answer .check-pill').count(), 0, 'one check pill per card');
  await card.locator('.card-answer .answer.compact').waitFor();
  assert.equal(await card.locator('.card-answer .selection-quote').count(), 0, 'the embedded answer does not repeat the quote');
  // Dismiss with undo; the transcript mark opens the card.
  await card.locator('button.dismiss').click();
  await page.locator('.undo-bar button', { hasText: 'Undo' }).click();
  await page.locator('.board-card:not(.dismissed)').first().waitFor();
  await page.locator('#tab-notes').click();
  await page.locator('#transcript .para-mark').first().click();
  await page.locator('.board-card.flash').first().waitFor();
  await page.locator('#board-sort').click(); // Time → Type
  await page.locator('.board-group > summary', { hasText: 'Questions' }).waitFor();
  assert.equal(await page.evaluate(() => scrollY), 0, 'the page never scrolls');
  await page.screenshot({ path: screenshot });

  // Restart: transcript and replay state persist.
  await page.goto('about:blank');
  await app.close();
  app = await serve();
  await page.goto(app.url);
  await page.waitForFunction(() => document.getElementById('transcript')?.textContent?.includes('parade'));
  assert.deepEqual(errors, []);
  // Room mode (step 4): chosen in Settings & status, used by the next in-person recording, and saved with that take.
  await page.locator('#open-system').click();
  assert.equal(await page.locator('#room-mode').isChecked(), true, 'room mode is the default for in-person recording');
  await page.locator('#room-mode').check();
  await page.locator('#settings [data-close-panel]').click();
  await newMeeting('Room mode take');
  await page.locator('#start').click();
  await page.locator('#start-mic').click();
  await page.locator('#live-chip').getByText('Recording').waitFor();
  await page.waitForTimeout(2500);
  await page.locator('#stop').click();
  await page.locator('#live-chip').waitFor({ state: 'hidden' });
  const roomTake = app.store.meetings().find(m => m.title === 'Room mode take')!;
  const taken = Object.values(app.store.sourceSettings(roomTake.id))[0] as Record<string, unknown> | undefined;
  assert.equal(taken?.roomMode, true, 'the take records room mode');
  assert.equal(taken?.echoCancellation, false, 'room mode turned echo cancellation off');
  await page.locator('#open-system').click();
  await page.locator('#room-mode').uncheck();
  await page.locator('#settings [data-close-panel]').click();
  // New meeting from the top bar opens straight into naming it; the pencil renames; Escape cancels.
  const before = app.store.meetings().length;
  await newMeeting('Lantern workshop handover');
  assert.equal(app.store.meetings().length, before + 1);
  assert.equal(app.store.meetings()[0].title, 'Lantern workshop handover');
  await page.locator('#meeting-button').dblclick();
  await page.keyboard.type('Cancelled workshop title');
  await page.keyboard.press('Escape');
  assert.equal(app.store.meetings()[0].title, 'Lantern workshop handover', 'Escape keeps the old name');

  const report = { browser: 'Chromium, headless, isolated profile', physicalMicrophoneAccessed: false, cloudRequests: false,
    replayTranscribed: true, segmentsPublished: true, selectionSurvivesRefresh: true, selectionMenu: true, materialSearch: true,
    notesTab: true, citationJump: true, actionCards: true, followUpThread: true, lookIntoIt: true, boardCards: true, boardInvestigate: true, dismissUndo: true, transcriptMarks: true, syntheticMicrophoneCapture: true, onlineMicAndTab: true, newAndRenameMeeting: true, roomModeTake: true, tailFrameSealed: true, liveDrafts: true, persistedAfterRestart: true, browserErrors: errors, screenshot,
    speech: noModels ? 'Scripted recognizer and fake draft worker; no models called' : 'Local STT',
    limitation: 'Synthetic audio only; real room audio and hour-long live recording are not validated here.' };
  await writeFile(resolve('artifacts/browser-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
