import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { active, source } from '../test/fixtures/m9a-handoff.ts';
import type { CaptureGap } from '../public/capture-gaps.js';

export async function checkFix4Page(page: Page, show: (snapshot: any) => Promise<void>, results: string[], captureGaps: CaptureGap[] = []) {
  const failures: string[] = [];
  const check = async (name: string, body: () => Promise<void>) => {
    try { await body(); results.push(`PASS ${name}`); }
    catch (error) { failures.push(`${name}: ${(error as Error).message}`); }
    finally { await page.mouse.up(); await page.evaluate(() => getSelection()?.removeAllRanges()); await page.waitForTimeout(50); }
  };
  await check('fix 4: an unchanged snapshot claims a held zero-duration word exactly once', async () => {
    const segments = [1000, 3000].map((startMs, i) => ({ id: `point-anchor${i}:0`, source: 'tab:point', startMs, endMs: startMs + 300,
      text: i ? 'right' : 'left', revision: 0, edits: [] }));
    const draft = { ...active(0, 0), committedUntilMs: 0, coveredUntilMs: 2000, words: [{ text: 'instant', startMs: 2000, endMs: 2000 }] };
    const state = { segments, drafts: [draft], pending: [] };
    const speech = () => page.locator('#transcript .para:not(.capture-gap) p').allTextContents().then(xs => xs.join(' ').trim().replace(/\s+/g, ' '));
    await show(state); assert.equal(await speech(), 'left instant right');
    const held = await page.evaluate(() => {
      const left = document.querySelector('span[data-id="point-anchor0:0"]')!.firstChild!,
        right = document.querySelector('span[data-id="point-anchor1:0"]')!.firstChild!, range = document.createRange();
      range.setStart(left, 0); range.setEnd(right, right.textContent!.length);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      const row = document.getElementById('live-draft')!;
      (window as any).heldPoint = { row, html: row.outerHTML, left, right };
      return { text: getSelection()!.toString(), y: range.getBoundingClientRect().top };
    });
    for (let poll = 0; poll < 2; poll++) {
      await show(state);
      assert.equal(await speech(), 'left instant right', 'an unchanged poll must not add a second instant in a growth row');
      assert.equal(await page.locator('#transcript [data-key^="growth:"]').count(), 0);
      assert.equal(await page.evaluate(() => {
        const old = (window as any).heldPoint, range = getSelection()!.getRangeAt(0);
        return old.row.isConnected && old.row.outerHTML === old.html && range.startContainer === old.left && range.endContainer === old.right;
      }), true);
      assert.equal(await page.evaluate(() => getSelection()!.toString()), held.text);
      assert.ok(Math.abs(await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top) - held.y) <= 1);
    }
    const pointFinal = { id: 'point-final:0', source, startMs: 2000, endMs: 2000, text: 'instant', revision: 0, edits: [] };
    await show({ segments: [...segments, pointFinal], drafts: [], pending: [] });
    assert.equal(await page.locator('span[data-id="point-final:0"]').count(), 0, 'a coincident point final must wait for the held word');
    assert.equal(await speech(), 'left instant right');
    await page.evaluate(() => getSelection()!.removeAllRanges()); await page.waitForTimeout(150);
    assert.equal(await page.locator('span[data-id="point-final:0"]').count(), 1);
    assert.equal(await speech(), 'left instant right');
  });

  await check('fix 4: unrelated compact-tab selections and note expiry never restart a hidden transcript', async () => {
    await page.setViewportSize({ width: 700, height: 860 });
    await page.locator('#ctab-live').click();
    // A second instance of the production renderer exposes its follow state for a deterministic poll-before-scroll-event check.
    // It lives in the real Transcript pane and is hidden by the actual compact Notes tab, not by mocked geometry.
    await page.evaluate(async ({ source, captureGaps }) => {
      const { createTranscriptView } = await import(new URL('/transcript-view.js', location.href).href) as typeof import('../public/transcript-view.js');
      const box = document.createElement('div'); box.id = 'fix4-transcript'; box.className = 'transcript';
      box.style.cssText = 'flex:0 0 180px;height:180px;overflow:auto';
      document.getElementById('transcript-pane')!.append(box);
      const view = createTranscriptView(box, { segmentNode: (s: any) => {
        const span = document.createElement('span'); span.dataset.id = s.id; span.textContent = s.text; return span;
      } });
      const snapshot = { captureGaps, segments: Array.from({ length: 40 }, (_, i) => ({ id: `hidden${i}:0`, source, startMs: i * 3000,
        endMs: i * 3000 + 1000, text: `Completed line ${i}`, revision: 0 })), pending: [],
        drafts: [{ source, window: 'hidden-note', windowStartMs: 200000, committedUntilMs: 200000, coveredUntilMs: 200300,
          words: [{ text: 'note', startMs: 200100, endMs: 200300 }], text: 'note', behind: false }] };
      (window as any).hiddenTranscript = { box, view, snapshot };
      view.render(snapshot);
    }, { source, captureGaps });
    try {
      const rect = await page.locator('#fix4-transcript .preview-text').boundingBox(); assert.ok(rect);
      await page.mouse.move(rect.x + 2, rect.y + rect.height / 2); await page.mouse.down();
      await page.mouse.move(rect.x + 14, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
      assert.equal(await page.locator('#fix4-transcript .draft-selection-note').count(), 1, 'arm a real note-expiry render');
      const paused = await page.evaluate(() => {
        const { box, view } = (window as any).hiddenTranscript;
        box.scrollTop = 200; box.dispatchEvent(new Event('scroll'));
        return { following: view.following, top: box.scrollTop, visible: Boolean(box.offsetParent) && box.clientHeight > 0 };
      });
      assert.deepEqual(paused, { following: false, top: 200, visible: true });
      await page.locator('#ctab-notes').click();
      const hiddenSelection = await page.evaluate(() => {
        const text = document.createElement('p'); text.id = 'fix4-notes-text'; text.textContent = 'Unrelated Notes selection';
        document.getElementById('notes-panel')!.append(text);
        const range = document.createRange(); range.selectNodeContents(text);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        const { box, view } = (window as any).hiddenTranscript;
        return { following: view.following, hidden: box.offsetParent === null && box.clientHeight === 0 };
      });
      await page.waitForTimeout(3250); // the real drag-note timer fires while the Transcript pane is hidden
      const afterTimer = await page.evaluate(() => {
        const { box, view } = (window as any).hiddenTranscript;
        return { following: view.following, notes: box.querySelectorAll('.draft-selection-note').length };
      });
      const restored = await page.evaluate(() => {
        (document.getElementById('ctab-live') as HTMLElement).click();
        const { box, view, snapshot } = (window as any).hiddenTranscript;
        box.scrollTop = 200;
        view.render(snapshot); // same task: deliberately before the browser can deliver the restoration's scroll event
        return { following: view.following, top: box.scrollTop, max: box.scrollHeight - box.clientHeight };
      });
      assert.deepEqual(hiddenSelection, { following: false, hidden: true }, 'a Notes selection must not enable following against zero geometry');
      assert.deepEqual(afterTimer, { following: false, notes: 0 }, 'a note timer render must remove its note without changing following');
      assert.equal(restored.following, false);
      assert.equal(restored.top, 200, `the next poll must preserve 200, not jump to ${restored.max}`);
    } finally {
      await page.evaluate(() => {
        const test = (window as any).hiddenTranscript;
        test?.view.reset(); test?.box.remove(); delete (window as any).hiddenTranscript;
        document.getElementById('fix4-notes-text')?.remove(); getSelection()?.removeAllRanges();
      });
      await page.setViewportSize({ width: 1280, height: 860 });
    }
  });
  if (failures.length) throw new Error(failures.join('\n\n'));
}
