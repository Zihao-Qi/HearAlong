// Scripted word timings through the real page's snapshot polling, plus headless pointer/selection checks.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { handoffCases, words, active, source } from '../test/fixtures/m9a-handoff.ts';
import { transcriptRows, type DisplaySegment } from '../public/transcript-view.js';
import { miniPreviewWords, miniLog } from '../public/preview-composition.js';
import { checkFix3Page } from './m9a-fix3-page-cases.ts';
import { checkFix4Page } from './m9a-fix4-page-cases.ts';
import { assertUniqueTranscriptKeys, watchTranscriptKeys, finishTranscriptKeyCheck } from './transcript-key-check.ts';
// Repeat the same handoff/selection suite with a historical gap; only speech-only queries exclude the notice.
const earlierGap = process.argv.includes('--earlier-gap') ? { atMs: 0, fromWallMs: 100000, toWallMs: 597000, reason: 'sleep' as const } : null;
const directory = await mkdtemp(join(tmpdir(), 'm9a-page-'));
const app = await startServer({ directory, port: 0, quick: null, heavy: null, recognizer: null, drafts: null });
const meeting = app.store.createMeeting('M9a scripted handoff');
const browser = await chromium.launch({ headless: true, executablePath: process.env.MEETING_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results: string[] = [], errors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(id => localStorage.setItem('meeting-id', id), meeting.id);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await watchTranscriptKeys(page);
  let state: any = handoffCases()[0].steps[0];
  let sent = 0;
  await page.route('**/api/meetings/*/segments', async route => {
    const response = await route.fetch();
    const json = { ...await response.json(), ...state, ...(earlierGap ? { captureGaps: [earlierGap] } : {}) };
    assertUniqueTranscriptKeys(json);
    if (earlierGap) assert.deepEqual(transcriptRows(json).filter(r => !r.gap), transcriptRows({ ...json, captureGaps: [] }),
      'a historical gap must leave every M9a speech row, key and grouping unchanged');
    await route.fulfill({ response, json }); sent++;
  });
  await page.goto(app.url);
  await page.locator('#transcript .para:not(.capture-gap)').first().waitFor();
  const miniPage = await context.newPage();
  await miniPage.setViewportSize({ width: 360, height: 268 });
  miniPage.on('pageerror', e => errors.push(e.message));
  let miniSent = 0, nullMiniAnchor = false;
  await miniPage.route('**/api/live*', route => {
    const log = miniLog<DisplaySegment>(state.segments, state.drafts, state.pending);
    const placements = log.placements.map(p => nullMiniAnchor ? { ...p, beforeKey: null } : p);
    const sources = [...new Set<string>([...state.segments.map((s: any) => s.source ?? source),
      ...state.drafts.map((d: any) => d.source), ...state.pending.map((p: any) => p.source)])];
    return route.fulfill({ json: { recording: {
      meetingId: meeting.id, session: 1, clockMs: 6000, stopping: false, labelled: state.labelled ?? false,
      paragraphs: log.paragraphs.map(p => ({ ...p, text: p.segments.map(s => s.text).join(' ') })),
      paragraphsFrom: 0, paragraphsTag: '', notices: [], card: null,
      pending: state.pending.map((p: any) => ({ ...p, placements: placements.filter(r => r.chunkId === p.chunkId) })),
      drafts: sources.map(s => ({ source: s, speaker: state.labelled ? s.startsWith('tab:') ? 'Them' : 'Me' : null,
        text: miniPreviewWords(s, state.segments, state.drafts, state.pending, 20, placements) })),
    }, mini: { native: false, state: 'open' } } }).then(() => { miniSent++; });
  });
  await miniPage.goto(`${app.url}/mini.html`);
  await miniPage.locator('#m-drafts').getByText('one two three four five six').waitFor();
  const observeFrames = async (target: typeof page, selector: string) => target.evaluate(({ selector, expected }) => {
    const state = { observing: true, errors: [] as string[], frames: 0 };
    (window as any).m9aFrames = state;
    const tick = () => {
      if (!state.observing) return;
      const text = [...document.querySelectorAll(selector)].map(n => n.textContent).join(' ').trim().split(/\s+/).join(' ');
      state.frames++;
      if (text !== expected) state.errors.push(text);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { selector, expected: words.map(w => w.text).join(' ') });
  await observeFrames(page, '#transcript .para:not(.capture-gap) p');
  await observeFrames(miniPage, '#m-scroll .final, #m-scroll .pending-preview, #m-drafts .draft bdi');
  let checkingMini = true;
  const show = async (next: any) => { const before = sent, miniBefore = miniSent; state = next; await page.waitForFunction(() => Boolean(document.querySelector('#transcript .para:not(.capture-gap)'))); while (sent <= before || checkingMini && miniSent <= miniBefore) await page.waitForTimeout(50); await page.waitForTimeout(120); };
  const visible = () => page.locator('#transcript .para:not(.capture-gap) p').allTextContents().then(xs => xs.join(' ').trim().split(/\s+/));
  for (const scenario of handoffCases()) {
    for (const [index, step] of scenario.steps.entries()) {
      await show(step);
      assert.deepEqual(await visible(), words.map(w => w.text));
      if (scenario.name === 'a slow replay of the new stream' && index > 0) {
        assert.equal(await page.locator('#live-draft .preview-text').textContent(), 'four five six', 'the post-cut stretch stays on one grey row');
        const stable = await page.locator('#live-draft').evaluate((node, first) => {
          if (first) (window as any).replayRow = { node, top: node.getBoundingClientRect().top };
          const old = (window as any).replayRow;
          return node === old.node && Math.abs(node.getBoundingClientRect().top - old.top) <= 1;
        }, index === 1);
        assert.equal(stable, true, 'the same post-cut DOM node stays in place through replay and final arrival');
      }
      assert.equal((await miniPage.locator('#m-scroll .final, #m-scroll .pending-preview, #m-drafts .draft bdi').allTextContents()).join(' ').trim(), words.map(w => w.text).join(' '));
      // Observe every painted frame between polls too, not just each settled step.
      const bad = await page.evaluate(async expected => {
        const samples = [];
        for (let i = 0; i < 8; i++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const text = [...document.querySelectorAll('#transcript .para:not(.capture-gap) p')].map(n => n.textContent).join(' ').trim().split(/\s+/).join(' ');
          if (text !== expected) samples.push(text);
        }
        return samples;
      }, words.map(w => w.text).join(' '));
      assert.deepEqual(bad, []);
    }
    results.push(`PASS ${scenario.name}`);
  }
  for (const target of [page, miniPage]) {
    const observed = await target.evaluate(() => { const state = (window as any).m9aFrames; state.observing = false; return state; });
    assert.deepEqual(observed.errors, [], `${target === page ? 'main' : 'mini'}: no missing or duplicate words on any painted frame`);
    results.push(`PASS ${target === page ? 'main' : 'mini'}: ${observed.frames} continuously sampled frames across the five handoffs`);
  }
  const delayedWords = ['alpha', 'beta', 'gamma'].map((text, i) => ({ text, startMs: 2400 + i * 1000, endMs: 2700 + i * 1000 }));
  const themFirst = { id: 'order-them:0', source: 'tab:order', speaker: 'Them', startMs: 1000, endMs: 1800, text: 'Hello from them.', revision: 0, edits: [] };
  const delayed = { ...active(0, 0), source, speaker: 'Me', window: 'delayed', coveredUntilMs: 5000, words: delayedWords };
  const order = () => page.locator('#transcript .para:not(.capture-gap)').evaluateAll(ns => ns.map(n => ({ time: n.querySelector('time')!.textContent, text: n.querySelector('p')!.textContent })));
  await show({ labelled: true, segments: [themFirst], drafts: [delayed], pending: [] });
  const activeOrder = await order();
  await page.locator('#live-draft').evaluate(node => { (window as any).revisedTimeLane = { node, key: (node as HTMLElement).dataset.key }; });
  await show({ labelled: true, segments: [themFirst], drafts: [{ ...delayed,
    words: delayed.words.map((w, i) => i ? w : { ...w, startMs: w.startMs + 50 }) }], pending: [] });
  assert.equal(await page.locator('#live-draft').evaluate(node => node === (window as any).revisedTimeLane.node
    && (node as HTMLElement).dataset.key === (window as any).revisedTimeLane.key), true, 'revising the first word time must not replace an ordinary M9a post-cut lane');
  results.push('PASS ordinary post-cut lane retains its key and DOM node when its first word time is revised');
  await show({ labelled: true, segments: [themFirst], drafts: [], pending: [{ ...delayed, chunkId: 'order-c1', cutMs: 5000 }] });
  assert.deepEqual(await order(), activeOrder, 'a seal must not change the first-word stamp or move Me above Them');
  await page.locator('[data-key="chunk:order-c1"]').evaluate(n => { (window as any).delayedRow = n; });
  await show({ labelled: true, segments: [themFirst, { id: 'order-c1:0', source, speaker: 'Me', startMs: 2400, endMs: 4700, text: 'alpha beta gamma', revision: 0, edits: [] }], drafts: [], pending: [] });
  assert.deepEqual((await order()).map(r => ({ ...r, text: r.text!.trim() })), activeOrder.map(r => ({ ...r, text: r.text!.trim() })));
  assert.equal(await page.locator('[data-key="chunk:order-c1"]').evaluate(n => n === (window as any).delayedRow), true);
  results.push('PASS fix 3 B/C: post-cut node stays put during replay; delayed first-word timestamp and ordering survive seal/final replacement');

  const tailFinalsMini = [{ id: 'mini-c1:0', source, speaker: 'Me', startMs: 100, endMs: 2300, text: 'one two three', revision: 0, edits: [] },
    { id: 'mini-them:0', source: 'tab:mini', speaker: 'Them', startMs: 4500, endMs: 4900, text: 'agreed', revision: 0, edits: [] }];
  await show({ labelled: true, segments: tailFinalsMini, drafts: [{ ...active(3, 4), speaker: 'Me' }],
    pending: [{ ...active(0, 0), source, speaker: 'Me', chunkId: 'mini-c1', cutMs: 3000, coveredUntilMs: 6000, words: words.slice(3) }] });
  assert.equal(await miniPage.locator('#m-scroll .pending-preview').count(), 0, 'tail words stay out of the mini log');
  assert.equal(await miniPage.locator('#m-drafts .draft bdi').first().textContent(), 'four five six');
  await show({ segments: [tailFinalsMini[0], { ...tailFinalsMini[0], id: 'mini-c2:0', startMs: 5000, endMs: 9000,
    text: Array.from({ length: 20 }, (_, i) => `finalword${i}`).join(' ') }], drafts: [active(3, 5)], pending: [] });
  assert.equal(await miniPage.locator('#m-drafts .draft bdi').first().textContent(), 'four five', 'finals cannot use up the preview budget');
  results.push('PASS fix 3 E: mini keeps replay plus tail together and retains active words beside a 20-word final');

  const tiedPending = { ...active(0, 0), source: 'tab:tie', speaker: 'Them', chunkId: 'tab-tie', window: 'tab-tie-window',
    cutMs: 1000, committedUntilMs: 1000, coveredUntilMs: 1000, words: [{ text: 'tab-tie', startMs: 100, endMs: 300 }] };
  const tiedFinals = [0, 2000].map((startMs, i) => ({ id: `mic-tie:${i}`, source, speaker: 'Me', startMs, endMs: startMs + 500,
    text: i ? 'mic-two' : 'mic-zero', revision: 0, edits: [] }));
  const tiedState = { labelled: true, segments: tiedFinals, drafts: [], pending: [tiedPending] };
  await show(tiedState);
  const miniWords = async () => (await miniPage.locator('#m-scroll .final, #m-scroll .pending-preview, #m-drafts .draft bdi').allTextContents()).join(' ').trim().replace(/\s+/g, ' ');
  assert.equal(await miniWords(), 'mic-zero tab-tie mic-two', 'equal-time pending follows the 0 s final and precedes the 2 s final');
  assert.equal(await miniPage.locator('#m-scroll .pending-preview').count(), 1);
  results.push('PASS mini equal-time tie: mic 0 s, tab pending 0 s, mic 2 s each render exactly once in total order');
  nullMiniAnchor = true;
  await show(tiedState);
  assert.equal(await miniWords(), 'mic-zero mic-two tab-tie', 'a null beforeKey appends instead of dropping promoted text');
  assert.equal(await miniPage.locator('#m-scroll .pending-preview').count(), 1);
  nullMiniAnchor = false;
  results.push('PASS mini null placement: promoted pending text appends to the log and is not duplicated in a slot');
  checkingMini = false;
  await miniPage.close();
  const lines = Array.from({ length: 45 }, (_, i) => ({ id: `line${i}:0`, startMs: i * 3000, endMs: i * 3000 + 1000,
    text: `Line ${i} stays under the pointer while new speech arrives in the meeting.`, revision: 0, edits: [] }));
  await show({ segments: lines, drafts: [], pending: [] });
  await page.locator('#jump').evaluate((n: HTMLElement) => n.click());
  const position = await page.locator('#transcript').evaluate(box => {
    box.scrollTop = box.scrollHeight;
    const p = box.querySelector('.para:last-child p')!, r = p.getBoundingClientRect();
    return { x: r.left + 8, y: r.top + 12, top: box.scrollTop };
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  // Nothing may scroll even before a noncollapsed selection has been formed.
  await show({ segments: [...lines, { ...lines[44], id: 'new45:0', startMs: 135000, endMs: 136000, text: 'New text while the pointer is down.' }], drafts: [], pending: [] });
  assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), position.top);
  await page.mouse.move(position.x + 180, position.y, { steps: 8 });
  const held = await page.evaluate(() => ({ text: getSelection()!.toString(), top: document.getElementById('transcript')!.scrollTop }));
  assert.ok(held.text.length > 3, 'real pointer drag selected final words');
  await show({ segments: [...lines, ...Array.from({ length: 5 }, (_, i) => ({ ...lines[44], id: `new${i}:0`, startMs: 135000 + i * 3000, endMs: 136000 + i * 3000 }))], drafts: [], pending: [] });
  assert.deepEqual(await page.evaluate(() => ({ text: getSelection()!.toString(), top: document.getElementById('transcript')!.scrollTop })), held);
  await page.evaluate(() => {
    const range = getSelection()!.getRangeAt(0), row = document.querySelector('[data-key="chunk:line44"]')!;
    (window as any).heldTranscript = { row, html: row.outerHTML, start: range.startContainer, end: range.endContainer,
      startOffset: range.startOffset, endOffset: range.endOffset, y: range.getBoundingClientRect().top,
      ids: [...document.querySelectorAll('#transcript span[data-id]')].filter(n => range.intersectsNode(n)).map(n => (n as HTMLElement).dataset.id) };
  });
  const selectionState = () => page.evaluate(() => {
    const old = (window as any).heldTranscript, range = getSelection()!.getRangeAt(0);
    return { sameNode: document.querySelector('[data-key="chunk:line44"]') === old.row, sameHTML: old.row.outerHTML === old.html,
      sameRange: range.startContainer === old.start && range.endContainer === old.end && range.startOffset === old.startOffset && range.endOffset === old.endOffset,
      text: getSelection()!.toString(), top: document.getElementById('transcript')!.scrollTop, y: range.getBoundingClientRect().top,
      ids: [...document.querySelectorAll('#transcript span[data-id]')].filter(n => range.intersectsNode(n)).map(n => (n as HTMLElement).dataset.id) };
  });
  await page.mouse.up();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('span[data-id="new0:0"]').count(), 1, 'new finals must render after pointer-up without clearing the selection');
  const corrected = lines.map((s, i) => i === 44 ? { ...s, revision: 1, text: 'Deferred correction of the selected line.' } : s);
  const newFinal = { ...lines[44], id: 'new-final:0', startMs: 150000, endMs: 151000, text: 'A new final appears below.' };
  const preview = { ...active(0, 1), window: 'selection-preview', windowStartMs: 153000, coveredUntilMs: 154000,
    words: [{ text: 'preview-one', startMs: 153100, endMs: 153300 }] };
  await show({ segments: [...corrected, newFinal], drafts: [preview], pending: [] });
  assert.equal(await page.locator('span[data-id="new-final:0"]').count(), 1);
  assert.ok((await visible()).includes('preview-one'));
  assert.deepEqual(await selectionState(), { sameNode: true, sameHTML: true, sameRange: true, ...held, y: await page.evaluate(() => (window as any).heldTranscript.y), ids: ['line44:0'] });
  await page.locator('#selection-menu').waitFor({ state: 'visible' });
  const above = { ...lines[43], id: 'late-above:0', startMs: 130500, endMs: 131500, text: 'Text inserted above the selected words. '.repeat(8) };
  // Move the pointer above the insertion: anchoring it instead of the selection would now move the selected line.
  await page.mouse.move(position.x, position.y - 100);
  const grownPreview = { ...preview, coveredUntilMs: 155000, words: [...preview.words, { text: 'preview-two', startMs: 154100, endMs: 154300 }] };
  await show({ segments: [...corrected.slice(0, 44), above, corrected[44], newFinal], drafts: [grownPreview], pending: [] });
  const anchoredSelection = await selectionState();
  assert.equal(anchoredSelection.sameNode && anchoredSelection.sameHTML && anchoredSelection.sameRange, true);
  assert.equal(anchoredSelection.text, held.text);
  assert.deepEqual(anchoredSelection.ids, ['line44:0'], 'selection-menu segment ids remain unchanged');
  assert.ok(Math.abs(anchoredSelection.y - await page.evaluate(() => (window as any).heldTranscript.y)) <= 1);
  assert.ok(anchoredSelection.top > held.top, 'scrollTop compensates for text inserted above the selected line');
  assert.ok((await visible()).includes('preview-two'), 'previews keep updating during a lingering selection');
  const rowY = await page.locator('[data-key="chunk:line44"]').evaluate(n => n.getBoundingClientRect().top);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await page.locator('[data-key="chunk:line44"]').evaluate(n => n.getBoundingClientRect().top) - rowY) <= 1, 'deferred correction lands at the anchor without a jump');
  assert.equal(await page.locator('span[data-id="line44:0"]').textContent(), 'Deferred correction of the selected line. ');
  assert.deepEqual(await visible(), [...corrected.slice(0, 44), above, corrected[44], newFinal].flatMap(s => s.text.trim().split(/\s+/)).concat(['preview-one', 'preview-two']), 'every displayed word occurs exactly once after the deferred update');
  results.push('PASS lingering selection: new finals and previews render; selected node, range and menu ids stay unchanged; selection-anchored flush has no jump');

  const waiting = { ...active(0, 0), chunkId: 'selected-pending', window: 'pending-selection', windowStartMs: 135000,
    cutMs: 138000, coveredUntilMs: 138000, words: ['alpha', 'beta', 'gamma'].map((text, i) => ({ text, startMs: 135100 + i * 1000, endMs: 135300 + i * 1000 })) };
  const tail = { ...active(0, 0), window: 'pending-selection-tail', windowStartMs: 138000, coveredUntilMs: 139000,
    words: [{ text: 'delta', startMs: 138100, endMs: 138300 }] };
  await show({ segments: lines, drafts: [tail], pending: [waiting] });
  // Create an older row *after* the pending row, so map insertion order differs from DOM order.
  const lateSelected = { ...lines[44], id: 'late-selected:0', startMs: 133500, endMs: 134500, text: 'Late selected row.' };
  const selectionHistory = [...lines, lateSelected];
  await show({ segments: selectionHistory, drafts: [tail], pending: [waiting] });
  await page.locator('#transcript').evaluate(box => {
    const row = box.querySelector('[data-key="chunk:late-selected"]')!;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 100;
    const pending = box.querySelector('[data-key="chunk:selected-pending"]')!, range = document.createRange();
    range.setStart(row.querySelector('span[data-id]')!.firstChild!, 0);
    const last = pending.querySelector('.preview-text')!.firstChild!; range.setEnd(last, last.textContent!.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    (window as any).heldPending = { row: pending, html: pending.outerHTML, text: getSelection()!.toString(),
      start: range.startContainer, end: range.endContainer, startOffset: range.startOffset, endOffset: range.endOffset,
      y: range.getBoundingClientRect().top };
  });
  const c1 = [{ ...lines[0], id: 'selected-pending:0', startMs: 135100, endMs: 135300, text: 'alpha' },
    { ...lines[0], id: 'selected-pending:1', startMs: 137500, endMs: 137900, text: 'beta gamma' }];
  const later = { ...lines[0], id: 'later-independent:0', startMs: 144000, endMs: 145000, text: 'zeta' };
  const grownTail = { ...tail, coveredUntilMs: 140000, words: [...tail.words, { text: 'epsilon', startMs: 139100, endMs: 139300 }] };
  const beforeWords = selectionHistory.flatMap(s => s.text.split(/\s+/)).concat(['alpha', 'beta', 'gamma', 'delta']);
  const afterWords = [...beforeWords, 'epsilon', 'zeta'];
  await page.evaluate(allowed => {
    const state = { observing: true, frames: 0, errors: [] as string[] };
    (window as any).pendingSelectionFrames = state;
    const tick = () => {
      if (!state.observing) return;
      const words = [...document.querySelectorAll('#transcript .para:not(.capture-gap) p')].map(p => p.textContent).join(' ').trim().replace(/\s+/g, ' ');
      state.frames++; if (!allowed.includes(words)) state.errors.push(words);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [beforeWords.join(' '), afterWords.join(' ')]);
  await show({ segments: [...selectionHistory, ...c1, later], drafts: [grownTail], pending: [] });
  const pendingHeld = await page.evaluate(() => {
    const old = (window as any).heldPending, range = getSelection()!.getRangeAt(0);
    return { sameNode: document.querySelector('[data-key="chunk:selected-pending"]') === old.row,
      sameHTML: old.row.outerHTML === old.html, sameText: getSelection()!.toString() === old.text,
      sameRange: range.startContainer === old.start && range.endContainer === old.end && range.startOffset === old.startOffset && range.endOffset === old.endOffset,
      deltaY: range.getBoundingClientRect().top - old.y };
  });
  assert.deepEqual(pendingHeld, { sameNode: true, sameHTML: true, sameText: true, sameRange: true, deltaY: 0 });
  assert.equal(await page.locator('span[data-id^="selected-pending:"]').count(), 0, 'both final paragraphs of the held pending chunk are deferred');
  assert.equal(await page.locator('span[data-id="later-independent:0"]').count(), 1, 'unrelated final still renders during the pending handoff');
  assert.deepEqual(await visible(), afterWords, 'old pending and new previews/finals show every word exactly once');
  const pendingY = await page.locator('[data-key="chunk:selected-pending"]').evaluate(n => n.getBoundingClientRect().top);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.waitForTimeout(150);
  assert.equal(await page.locator('span[data-id^="selected-pending:"]').count(), 2);
  assert.equal(await page.locator('[data-key="chunk:selected-pending"]').getAttribute('data-kind'), 'final');
  assert.ok(Math.abs(await page.locator('[data-key="chunk:selected-pending"]').evaluate(n => n.getBoundingClientRect().top) - pendingY) <= 1);
  assert.deepEqual(await visible(), afterWords, 'deferred pending-to-final handoff has no missing or repeated words');
  const sampled = await page.evaluate(() => { const state = (window as any).pendingSelectionFrames; state.observing = false; return state; });
  assert.deepEqual(sampled.errors, []);
  results.push(`PASS selected pending row: multi-row selection survives, unrelated final/preview updates continue, deferred two-paragraph final lands once without a jump (${sampled.frames} painted frames)`);

  const allPreviewWords = [...waiting.words, ...grownTail.words, { text: 'zeta', startMs: 140100, endMs: 140300 }];
  await show({ segments: lines, drafts: [grownTail], pending: [{ ...waiting, coveredUntilMs: 141000, words: allPreviewWords }] });
  const shrinking = await page.locator('#transcript').evaluate(box => {
    box.scrollTop = box.scrollHeight;
    const text = box.querySelector('span[data-id="line44:0"]')!.firstChild!, range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 4);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    return { y: range.getBoundingClientRect().top, top: box.scrollTop, text: getSelection()!.toString() };
  });
  await show({ segments: [...lines, { ...c1[0], text: 'alpha beta gamma', endMs: 137900 }],
    drafts: [{ ...grownTail, coveredUntilMs: 141000, words: allPreviewWords.slice(3) }], pending: [] });
  assert.deepEqual(await page.evaluate(() => ({ y: getSelection()!.getRangeAt(0).getBoundingClientRect().top,
    top: document.getElementById('transcript')!.scrollTop, text: getSelection()!.toString() })), shrinking, 'a handoff shortening rows below the selection must not clamp its scroll position');
  assert.deepEqual(await visible(), lines.flatMap(s => s.text.split(/\s+/)).concat(allPreviewWords.map(w => w.text)));
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#transcript').evaluate(box => box.scrollTop), shrinking.top, 'clearing after a shrinking handoff does not jump either');
  results.push('PASS shorter handoff below a lingering selection preserves selected text and scrollTop, through selection clear');

  await show({ segments: lines, drafts: [grownTail], pending: [{ ...waiting, coveredUntilMs: 141000, words: allPreviewWords }] });
  const heldTail = await page.locator('#transcript').evaluate(box => {
    box.scrollTop = box.scrollHeight;
    const row = box.querySelector('#live-draft')!, text = row.querySelector('.preview-text')!, range = document.createRange();
    range.selectNodeContents(text); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    (window as any).selectedTail = { row, html: row.outerHTML, text: getSelection()!.toString() };
    return text.getBoundingClientRect().top;
  });
  const afterTailFinal = { ...c1[0], id: 'selected-tail-final:0', startMs: 138100, endMs: 140300, text: 'delta epsilon zeta' };
  const future = { ...tail, window: 'future-tail', windowStartMs: 141000, coveredUntilMs: 142000,
    words: [{ text: 'eta', startMs: 141100, endMs: 141300 }] };
  const tailFinals = [...lines, { ...c1[0], text: 'alpha beta gamma', endMs: 137900 }, afterTailFinal];
  await show({ segments: tailFinals, drafts: [future], pending: [] });
  assert.equal(await page.locator('span[data-id="selected-tail-final:0"]').count(), 0);
  assert.deepEqual(await visible(), lines.flatMap(s => s.text.split(/\s+/)).concat(allPreviewWords.map(w => w.text), ['eta']), 'the held merged post-cut run keeps all its words while its final waits');
  await show({ segments: tailFinals, drafts: [{ ...future, coveredUntilMs: 143000,
    words: [...future.words, { text: 'theta', startMs: 142100, endMs: 142300 }] }], pending: [] });
  assert.equal(await page.evaluate(() => {
    const old = (window as any).selectedTail;
    return old.row.isConnected && old.html === old.row.outerHTML && old.text === getSelection()!.toString();
  }), true);
  const tailExpected = lines.flatMap(s => s.text.split(/\s+/)).concat(allPreviewWords.map(w => w.text), ['eta', 'theta']);
  assert.deepEqual(await visible(), tailExpected);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-key^="held-handoff:"]').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).selectedTail.row.isConnected), false);
  assert.ok(Math.abs(await page.locator('span[data-id="selected-tail-final:0"]').evaluate(n => n.getBoundingClientRect().top) - heldTail) <= 1, 'a removed pending-tail key anchors to its replacing final');
  assert.deepEqual(await visible(), tailExpected);
  results.push('PASS selected merged post-cut run: all words stay visible, later previews grow, and its final replaces it once at the anchor');

  const gapPending = { ...waiting, chunkId: 'gap-pending', cutMs: 151000, committedUntilMs: 159000, coveredUntilMs: 159000,
    words: [{ text: 'before-gap', startMs: 135100, endMs: 135300 }, { text: 'returning', startMs: 152100, endMs: 152300 }, { text: 'tail', startMs: 158100, endMs: 158300 }] };
  const gapReplay = { ...tail, window: 'gap-replay', windowStartMs: 151000, committedUntilMs: 151400, coveredUntilMs: 158600,
    words: [{ text: 'stable', startMs: 151100, endMs: 151200 }, { text: 'far', startMs: 158400, endMs: 158600 }] };
  const historyWords = lines.flatMap(s => s.text.split(/\s+/));
  const selectionEnd = { ...lines[0], id: 'gap-selection-end:0', source: 'tab:gap', startMs: 151250, endMs: 151350, text: 'selection-end' };
  const gapHistory = [...lines, selectionEnd];
  await show({ segments: gapHistory, drafts: [gapReplay], pending: [gapPending] });
  assert.deepEqual(await visible(), historyWords.concat(['before-gap', 'stable', 'selection-end', 'returning', 'tail', 'far']));
  const selectedGap = await page.evaluate(() => {
    const range = document.createRange(), start = document.querySelector('span[data-id="line44:0"]')!.firstChild!;
    // A real cross-preview selection ends in selectable final text, not inside a user-select:none span.
    const end = document.querySelector('span[data-id="gap-selection-end:0"]')!.firstChild!;
    range.setStart(start, 0); range.setEnd(end, end.textContent!.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    return { text: getSelection()!.toString(), y: range.getBoundingClientRect().top };
  });
  await page.waitForTimeout(200);
  assert.deepEqual(await visible(), historyWords.concat(['before-gap', 'stable', 'selection-end', 'returning', 'tail', 'far']), 'fix 1’s held preview must not claim tentative gaps');
  const retractedGap = { ...gapReplay, coveredUntilMs: 151400, words: gapReplay.words.slice(0, 1) };
  await show({ segments: gapHistory, drafts: [retractedGap], pending: [gapPending] });
  assert.deepEqual(await visible(), historyWords.concat(['before-gap', 'stable', 'selection-end', 'returning', 'tail']));
  assert.equal(await page.evaluate(() => getSelection()!.toString()), selectedGap.text);
  assert.ok(Math.abs(await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top) - selectedGap.y) <= 1);
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await show({ segments: gapHistory, drafts: [{ ...retractedGap, coveredUntilMs: 152300,
    words: [...retractedGap.words, { text: 'replacement', startMs: 152100, endMs: 152300 }] }], pending: [gapPending] });
  assert.deepEqual(await visible(), historyWords.concat(['before-gap', 'stable', 'selection-end', 'replacement', 'tail']));
  await show({ segments: gapHistory, drafts: [retractedGap], pending: [gapPending] });
  assert.deepEqual(await visible(), historyWords.concat(['before-gap', 'stable', 'selection-end', 'returning', 'tail']), 'retracted tentative text restores the pending word in the page');
  results.push('PASS tentative retraction restores pending words; time-ordered gaps remain visible during fix 1’s held selection');

  await show({ segments: lines, drafts: [], pending: [] });
  const anchor = await page.locator('#transcript').evaluate(box => {
    const row = box.querySelector('[data-key="chunk:line20"]')!;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - 130;
    const p = row.querySelector('p')!, r = p.getBoundingClientRect();
    return { x: r.left + 80, y: r.top + 14, top: r.top };
  });
  await page.waitForTimeout(100);
  await page.mouse.move(anchor.x, anchor.y);
  await show({ segments: [{ ...lines[0], id: 'inserted:0', startMs: -3000, endMs: -2000, text: 'Inserted above the reader. '.repeat(20) }, ...lines], drafts: [], pending: [] });
  const anchoredTop = await page.locator('[data-key="chunk:line20"] p').evaluate(n => n.getBoundingClientRect().top);
  assert.ok(Math.abs(anchoredTop - anchor.top) <= 1, `line under pointer moved ${anchoredTop - anchor.top}px`);
  results.push('PASS text inserted above the reader preserves the line under the pointer');

  await show({ segments: [], drafts: [active(0, 6)], pending: [] });
  await page.locator('#transcript').evaluate(box => { box.scrollTop = 0; });
  const draft = await page.locator('#live-draft .live-draft').boundingBox();
  assert.ok(draft);
  assert.equal(await page.locator('.draft-selection-note').count(), 0, 'no badge or note before a drag');
  await page.mouse.move(draft.x + 5, draft.y + draft.height / 2); await page.mouse.down();
  await page.mouse.move(draft.x + 100, draft.y + draft.height / 2, { steps: 8 });
  assert.equal(await page.locator('.draft-selection-note').textContent(), 'Still being written: select it in a few seconds');
  assert.equal(await page.locator('.live-draft').evaluate(n => getComputedStyle(n).userSelect), 'none');
  assert.equal(await page.evaluate(() => getSelection()!.toString()), '');
  await page.mouse.up();
  results.push('PASS dragging inside the unselectable live draft shows only the muted inline note');
  await checkFix3Page(page, show, results);
  await checkFix4Page(page, show, results, earlierGap ? [earlierGap] : []);
  results.push(`PASS ${await finishTranscriptKeyCheck(page)}; every M9a snapshot also has unique keys`);
  if (earlierGap) {
    assert.equal(await page.locator('#transcript .capture-gap').count(), 1, 'the historical gap stays rendered, not hidden for this suite');
    results.push('PASS all handoff and selection scenarios with an earlier unrelated gap; every speech row exactly matches its no-gap M9a key/grouping');
  }
  assert.deepEqual(errors, []);
} finally {
  await mkdir('artifacts/m9a', { recursive: true });
  await writeFile(`artifacts/m9a/page-check${earlierGap ? '-earlier-gap' : ''}.json`, JSON.stringify({ earlierGap, results, errors }, null, 2));
  await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
console.log(results.join('\n'));
