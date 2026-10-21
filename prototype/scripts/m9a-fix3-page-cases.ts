import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { active, pending, source, words } from '../test/fixtures/m9a-handoff.ts';

/** Accepted review scenarios against the real app page and its ordinary snapshot polling. */
export async function checkFix3Page(page: Page, show: (snapshot: any) => Promise<void>, results: string[]) {
  await page.waitForTimeout(3100); // let the preceding drag check's grace period finish
  const failures: string[] = [];
  const speech = () => page.locator('#transcript .para:not(.capture-gap) p').allTextContents().then(xs => xs.join(' ').trim().replace(/\s+/g, ' '));
  const check = async (name: string, body: () => Promise<void>) => {
    try { await body(); results.push(`PASS ${name}`); }
    catch (error) { failures.push(`${name}: ${(error as Error).message}`); }
    finally { await page.mouse.up(); await page.evaluate(() => getSelection()?.removeAllRanges()); await page.waitForTimeout(50); }
  };
  await check('fix 3 A: off-bottom selection release pauses following and exposes Jump; Jump resumes at the true bottom', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ id: `follow${i}:0`, source, startMs: i * 3000, endMs: i * 3000 + 1000,
      text: `Line ${i} is a completed final transcript sentence in the meeting.`, revision: 0, edits: [] }));
    const replay = { positionMs: 0, durationMs: 999999, baseMs: 0, speed: 1 };
    await show({ segments: lines, drafts: [], pending: [], replay });
    await page.locator('#jump').evaluate((n: HTMLElement) => n.click());
    const point = await page.locator('[data-key="chunk:follow28"] p').boundingBox(); assert.ok(point);
    await page.mouse.move(point.x + 10, point.y + 12); await page.mouse.down();
    await page.mouse.move(point.x + 210, point.y + 12, { steps: 8 }); await page.mouse.up();
    const held = await page.evaluate(() => ({ text: getSelection()!.toString(), top: document.getElementById('transcript')!.scrollTop }));
    assert.ok(held.text.length > 3);
    const arriving = Array.from({ length: 8 }, (_, i) => ({ ...lines[0], id: `follow${30 + i}:0`, startMs: (30 + i) * 3000,
      endMs: (30 + i) * 3000 + 1000, text: `New final line ${30 + i} arrives below the reader.` }));
    const draft = { ...active(0, 0), window: 'follow-preview', windowStartMs: 150000, coveredUntilMs: 151000,
      words: [{ text: 'latest-preview', startMs: 150100, endMs: 150300 }] };
    await show({ segments: [...lines, ...arriving.slice(0, 5)], drafts: [draft], pending: [], replay });
    assert.deepEqual(await page.evaluate(() => ({ text: getSelection()!.toString(), top: document.getElementById('transcript')!.scrollTop })), held);
    await page.evaluate(() => getSelection()!.removeAllRanges()); await page.waitForTimeout(150);
    assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), held.top, 'release must not jump');
    assert.equal(await page.locator('#jump').isVisible(), true, 'the newest text is off-screen, so Jump cannot be hidden');
    assert.equal(await page.locator('#jump').textContent(), 'Jump to live ↓');
    await show({ segments: [...lines, ...arriving], drafts: [draft], pending: [], replay });
    assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), held.top, 'further arrivals must not preserve a hidden following gap');
    await page.locator('#jump').click();
    const gap = () => page.locator('#transcript').evaluate(n => n.scrollHeight - n.clientHeight - n.scrollTop);
    assert.ok(await gap() < 2);
    assert.equal(await page.locator('#jump').isHidden(), true);
    // With no backlog, clearing another selection should keep real following, not a remembered distance.
    await page.evaluate(() => {
      const text = document.querySelector('span[data-id="follow37:0"]')!.firstChild!, range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, 5); getSelection()!.addRange(range);
    });
    await page.evaluate(() => getSelection()!.removeAllRanges()); await page.waitForTimeout(100);
    await show({ segments: [...lines, ...arriving], drafts: [{ ...draft, words: [...draft.words, { text: 'newest', startMs: 151100, endMs: 151300 }] }], pending: [], replay });
    assert.ok(await gap() < 2, 'near-bottom release follows the actual bottom on the next render');
  });

  await check('fix 3 B/D: a held post-cut row stays immutable beside one temporary growth row, then merges at the anchor', async () => {
    const state = { segments: [], drafts: [active(3, 6)], pending: [pending('growth-c1', 0, 3)] };
    await show(state);
    assert.equal(await page.locator('#transcript .para[data-kind="active"]').count(), 1);
    assert.equal(await speech(), 'one two three four five six');
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById('transcript')!);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await page.waitForTimeout(100); // capture the applied native selection, after its selectionchange render
    const held = await page.evaluate(() => {
      const row = document.getElementById('live-draft')!, range = getSelection()!.getRangeAt(0);
      (window as any).heldGrowth = { row, html: row.outerHTML, start: range.startContainer, end: range.endContainer,
        startOffset: range.startOffset, endOffset: range.endOffset };
      const state = { holding: true, observing: true, frames: 0, errors: [] as string[] };
      (window as any).growthFrames = state;
      const tick = () => {
        if (!state.observing) return;
        const text = [...document.querySelectorAll('#transcript .para:not(.capture-gap) p')].map(n => n.textContent).join(' ').trim().replace(/\s+/g, ' ');
        if (!['one two three four five six', 'one two three four five six seven'].includes(text)) state.errors.push(text);
        if (state.holding && (!row.isConnected || row.outerHTML !== (window as any).heldGrowth.html)) state.errors.push('held row changed');
        state.frames++; requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return { key: (row as HTMLElement).dataset.key, y: row.getBoundingClientRect().top,
        top: document.getElementById('transcript')!.scrollTop, text: getSelection()!.toString() };
    });
    const growing = { ...state, drafts: [{ ...active(3, 6), coveredUntilMs: 7000,
      words: [...words.slice(3), { text: 'seven', startMs: 6100, endMs: 6300 }] }] };
    for (let poll = 0; poll < 2; poll++) {
      await show(growing);
      assert.deepEqual(await page.locator('#transcript .para[data-kind="active"] p').allTextContents(), ['four five six', 'seven']);
      assert.equal(await page.locator('#transcript .para[data-key^="growth:"]').count(), 1);
      assert.equal(await page.evaluate(() => {
        const old = (window as any).heldGrowth, range = getSelection()!.getRangeAt(0);
        return old.row.isConnected && old.row.outerHTML === old.html && range.startContainer === old.start && range.endContainer === old.end
          && range.startOffset === old.startOffset && range.endOffset === old.endOffset;
      }), true, 'the held row and its selection endpoints must not change');
      assert.equal(await page.evaluate(() => getSelection()!.toString()), held.text);
      assert.equal(await speech(), 'one two three four five six seven');
      assert.ok(Math.abs(await page.locator('#live-draft').evaluate(n => n.getBoundingClientRect().top) - held.y) <= 1);
      assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), held.top);
    }
    await page.evaluate(() => { (window as any).growthFrames.holding = false; getSelection()!.removeAllRanges(); });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#transcript .para[data-kind="active"]').count(), 1);
    assert.equal(await page.locator('#transcript .para[data-key^="growth:"]').count(), 0);
    assert.equal(await page.locator('#live-draft .preview-text').textContent(), 'four five six seven');
    assert.equal(await page.locator('#live-draft').getAttribute('data-key'), held.key);
    assert.equal(await page.locator('#live-draft').evaluate(n => n === (window as any).heldGrowth.row), true, 'merge back into the original DOM node');
    assert.ok(Math.abs(await page.locator('#live-draft').evaluate(n => n.getBoundingClientRect().top) - held.y) <= 1, 'merge must stay at the anchor');
    assert.equal(await page.locator('#transcript').evaluate(n => n.scrollTop), held.top, 'selection clear must not jump');
    assert.equal(await speech(), 'one two three four five six seven');
    const frames = await page.evaluate(() => { const state = (window as any).growthFrames; state.observing = false; return state; });
    assert.ok(frames.frames > 0); assert.deepEqual(frames.errors, [], 'every painted frame shows each word once');
  });

  await check('fix 3 D: selecting older-18 never hides tentative-20 or older-22 in other composed runs', async () => {
    const older = { ...pending('held-older', 0, 16), committedUntilMs: 24000, coveredUntilMs: 24000,
      words: [{ text: 'older-18', startMs: 18100, endMs: 18300 }, { text: 'older-22', startMs: 22100, endMs: 22300 }] };
    const newer = { ...pending('held-newer', 16, 24), committedUntilMs: 16400, coveredUntilMs: 20300,
      words: [{ text: 'stable-16', startMs: 16100, endMs: 16300 }, { text: 'tentative-20', startMs: 20100, endMs: 20300 }] };
    const segments = [17000, 19000].map((startMs, i) => ({ id: `held-anchor${i}:0`, source: 'tab:anchors', startMs, endMs: startMs + 300,
      text: i ? 'right' : 'left', revision: 0, edits: [] }));
    const state = { segments, drafts: [], pending: [older, newer] };
    const expected = 'stable-16 left older-18 right tentative-20 older-22';
    await show(state); assert.equal(await speech(), expected);
    const selected = await page.evaluate(() => {
      const range = document.createRange(), left = document.querySelector('span[data-id="held-anchor0:0"]')!.firstChild!,
        right = document.querySelector('span[data-id="held-anchor1:0"]')!.firstChild!;
      range.setStart(left, 0); range.setEnd(right, right.textContent!.length);
      getSelection()!.addRange(range);
      const row = [...document.querySelectorAll('#transcript .para')].find(n => n.querySelector('p')?.textContent === 'older-18')!;
      (window as any).heldRun = { row, html: row.outerHTML, left, right };
      return { text: getSelection()!.toString(), y: range.getBoundingClientRect().top };
    });
    await show(state);
    assert.equal(await speech(), expected, 'unchanged snapshots must not make unselected runs disappear');
    assert.equal(await page.evaluate(() => {
      const old = (window as any).heldRun, range = getSelection()!.getRangeAt(0);
      return old.row.isConnected && old.row.outerHTML === old.html && range.startContainer === old.left && range.endContainer === old.right;
    }), true);
    assert.equal(await page.evaluate(() => getSelection()!.toString()), selected.text);
    assert.ok(Math.abs(await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top) - selected.y) <= 1);
    await page.evaluate(() => getSelection()!.removeAllRanges()); await page.waitForTimeout(100);
    assert.equal(await speech(), expected);
  });

  const shortDraft = { segments: [], drafts: [active(0, 1)], pending: [] };
  const drag = async () => {
    const rect = await page.locator('#live-draft .preview-text').boundingBox(); assert.ok(rect);
    await page.mouse.move(rect.x + 2, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 14, rect.y + rect.height / 2, { steps: 5 });
    return rect;
  };
  const note = () => page.locator('.draft-selection-note');
  await check('fix 3 F: inline drag note survives a queued render and lasts 3 seconds after release', async () => {
    await show(shortDraft);
    const height = await page.locator('#live-draft').evaluate(n => n.getBoundingClientRect().height);
    const rect = await drag();
    assert.equal(await note().textContent(), 'Still being written: select it in a few seconds');
    const inline = await note().evaluate(n => getComputedStyle(n).display);
    const noteHeight = await page.locator('#live-draft').evaluate(n => n.getBoundingClientRect().height);
    const box = await page.locator('#transcript').boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + 8, rect.y + rect.height / 2);
    const outside = await note().count();
    await page.mouse.move(rect.x + 14, rect.y + rect.height / 2);
    await show({ ...shortDraft, drafts: [active(0, 2)] }); // a new hypothesis arrives while the drag still holds the DOM
    await page.mouse.up();
    assert.equal(await note().count(), 1, 'pointer-up render must not wipe the note');
    assert.equal(outside, 0, 'the note is quiet while the pointer leaves grey text');
    assert.equal(inline, 'inline');
    assert.ok(Math.abs(noteHeight - height) <= 1, 'a short inline note must not add a row');
    await show({ ...shortDraft, drafts: [active(0, 3)] });
    assert.equal(await note().count(), 1, 'live revisions during the 3-second grace period keep the note');
    await page.waitForTimeout(3200);
    assert.equal(await note().count(), 0);
  });
  await check('fix 3 F: drag note expires without any new words', async () => {
    await show(shortDraft); await drag(); await page.mouse.up();
    assert.equal(await note().count(), 1);
    await page.waitForTimeout(3200);
    assert.equal(await note().count(), 0, 'no further transcript revision is needed to remove the note');
  });
  if (failures.length) throw new Error(failures.join('\n\n'));
}
