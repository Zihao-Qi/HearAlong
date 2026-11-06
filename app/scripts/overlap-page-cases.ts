import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { overlapLines, overlapText } from '../test/fixtures/overlap-turns.ts';

export async function checkOverlapPage(page: Page, mini: Page, show: (next: any) => Promise<void>, results: string[]) {
  const history = Array.from({ length: 35 }, (_, i) => ({ id: `overlap-history-${i}:0`, startMs: i * 3000, endMs: i * 3000 + 1000,
    revision: 0, edits: [], speaker: 'Me', source: 'mic:fictional', text: `Fictional garden note ${i} is finished.` }));
  const shifted = overlapLines.map(s => ({ ...s, edits: [], startMs: s.startMs + 110000, endMs: s.endMs + 110000 }));
  const state = (segments: typeof shifted) => ({ labelled: true, segments: [...history, ...segments], drafts: [], pending: [] });
  await show(state(shifted.slice(0, 2)));
  await page.locator('[data-key="chunk:mic-first"]').evaluate(n => { (window as any).overlapMe = n; });
  const selectors = ['[data-key="chunk:call-first"] p', '[data-key="call-first:0"] .final'];
  const held = [];
  for (const [i, target] of [page, mini].entries()) {
    const selected = target.locator(selectors[i]);
    await selected.scrollIntoViewIfNeeded();
    held.push(await selected.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      (window as any).overlapHeld = node;
      return { text: getSelection()!.toString(), y: range.getBoundingClientRect().top };
    }));
  }
  await show(state(shifted.slice(0, 2)));
  for (const [i, target] of [page, mini].entries()) held[i].y = await target.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top);
  await show(state(shifted));
  assert.equal(await page.locator('[data-key="chunk:mic-first"]').evaluate(n => n === (window as any).overlapMe), true, 'Me grows in the same DOM row');
  for (const [i, target] of [page, mini].entries()) {
    const actual = await target.evaluate(() => ({ text: getSelection()!.toString(), y: getSelection()!.getRangeAt(0).getBoundingClientRect().top,
      connected: (window as any).overlapHeld.isConnected }));
    assert.equal(actual.text, held[i].text, 'selection stays frozen while the earlier Me paragraph grows');
    assert.equal(actual.connected, true);
    assert.ok(Math.abs(actual.y - held[i].y) <= 1, `${i ? 'mini' : 'main'} overlap growth moved selected words ${actual.y - held[i].y}px`);
    await target.evaluate(() => getSelection()!.removeAllRanges());
  }
  await show(state(shifted));
  assert.deepEqual(await page.locator('#transcript .para:not(.capture-gap) p').allTextContents().then(xs => xs.slice(-2).map(s => s.trim())), overlapText);
  assert.deepEqual(await mini.locator('#m-scroll .final').allTextContents().then(xs => xs.slice(-2)), overlapText);
  results.push('PASS overlapping sentences: cross-chunk per-speaker growth, stable keys, selected later words and scroll anchor in main and mini');
}
