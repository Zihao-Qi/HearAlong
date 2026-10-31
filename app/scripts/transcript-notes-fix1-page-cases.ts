import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { gapPreviewKeyCases } from '../test/fixtures/gap-preview-keys.ts';

/** Gemini's spanning draft, plus pending handoff/selection and stable gap-bounded DOM identities. */
export async function checkGapFixesPage(page: Page, show: (snapshot: any) => Promise<void>, results: string[], out: string) {
  await page.locator('.draft-selection-note').waitFor({ state: 'detached' });
  const words = 'Please stack the blue crates beside the kiln before opening'.split(' ').map((text, i) => ({ text, startMs: 526000 + i * 240, endMs: 526240 + i * 240 }));
  const draft = { source: 'mic:fixture', speaker: 'Me', window: 'spanning', windowStartMs: 526000, coveredUntilMs: 528400,
    text: words.map(w => w.text).join(' '), words, behind: false };
  const gap = { atMs: 526960, fromWallMs: new Date(2031, 3, 9, 9, 23, 18).getTime(), toWallMs: new Date(2031, 3, 9, 9, 29, 40).getTime(), reason: 'sleep' };
  const base = { segments: [], captureGaps: [gap], labelled: true, drafts: [], pending: [] };
  const readRows = () => page.locator('#transcript .para p').allTextContents();
  const expected = ['Please stack the blue', 'Not recorded for 6 minutes, 9:23–9:29 AM: the Mac was asleep.', 'crates beside the kiln before opening'];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await show({ ...base, drafts: [draft] });
    assert.deepEqual(await readRows(), expected);
    const y = await page.locator('#transcript .para').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    assert.ok(y[0] < y[1] && y[1] < y[2]);
    await page.screenshot({ path: join(out, `spanning-draft-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await show({ ...base, drafts: [draft] });
  await show({ ...base, drafts: [{ ...draft, words: words.slice(4) }], segments: [
    { id: 'pre-gap:0', startMs: 526000, endMs: 526950, text: 'Please stack the blue', speaker: 'Me', revision: 0, edits: [] },
  ] });
  assert.equal(await page.locator('#transcript .para').nth(2).getAttribute('data-key'), 'post:mic:fixture:after:chunk:pre-gap',
    'an after-only hypothesis is unaffected and must use its ordinary M9a key');
  assert.deepEqual((await readRows()).map(s => s.trim()), expected);
  const pending = { ...draft, chunkId: 'spanning-final', cutMs: 529600 };
  const state = { ...base, pending: [pending] };
  await show(state);
  assert.deepEqual(await readRows(), expected);
  await page.evaluate(() => { (window as any).gapRunNodes = [...document.querySelectorAll('#transcript .para')]; });
  // A shorter/longer hypothesis retains both DOM nodes, not just the set of words.
  await show({ ...state, pending: [{ ...pending, words: words.slice(0, -1) }] });
  await show(state);
  assert.equal(await page.locator('#transcript .para').evaluateAll(nodes => nodes.every((n, i) => n === (window as any).gapRunNodes[i])), true);
  assert.deepEqual(await readRows(), expected);
  // Hold the after-gap preview during its final handoff, as M9a does with composed pending runs.
  await page.evaluate(() => new Promise<void>(resolve => {
    document.addEventListener('selectionchange', () => resolve(), { once: true });
    const row = document.querySelectorAll('#transcript .para')[2], range = document.createRange();
    range.selectNodeContents(row.querySelector('p')!); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    (window as any).heldGapRun = { row, html: row.outerHTML };
  }));
  const segments = [
    { id: 'spanning-final:0', startMs: 526000, endMs: 526950, text: 'Please stack the blue', speaker: 'Me', revision: 0, edits: [] },
    { id: 'spanning-final:1', startMs: 526960, endMs: 528400, text: 'crates beside the kiln before opening', speaker: 'Me', revision: 0, edits: [] },
  ];
  await show({ ...base, segments });
  assert.equal(await page.evaluate(() => {
    const held = (window as any).heldGapRun; return held.row.isConnected && held.row.outerHTML === held.html;
  }), true, 'selected preview is immutable through the final handoff');
  assert.deepEqual((await readRows()).map(s => s.trim()), expected, 'each word stays on its side of the gap exactly once while held');
  await page.evaluate(() => new Promise<void>(resolve => {
    document.addEventListener('selectionchange', () => resolve(), { once: true }); getSelection()!.removeAllRanges();
  }));
  await page.waitForFunction(() => !document.querySelector('#transcript .preview-text'));
  assert.deepEqual((await readRows()).map(s => s.trim()), expected);
  assert.equal(await page.locator('#transcript .preview-text').count(), 0);
  assert.equal(await page.locator('#transcript span[data-id]').count(), 2);
  results.push('fix 2: spanning draft/pending split at the gap at both widths; stable DOM keys and immutable selection through final handoff');
  const from = new Date(2031, 3, 9, 9, 23, 12).getTime();
  for (const reason of [null, 'sleep']) {
    await show({ ...base, captureGaps: [{ atMs: 0, fromWallMs: from, toWallMs: from + 18000, reason }] });
    assert.equal(await page.locator('.capture-gap p').textContent(), `Not recorded for 18 seconds at 9:23 AM${reason ? ': the Mac was asleep' : ''}.`);
  }
  results.push('fix 4: same-minute wording uses at, with and without sleep cause');
  for (const scenario of gapPreviewKeyCases()) {
    await show({ ...scenario.snapshot, labelled: true });
    const visible = () => page.locator('#transcript .para').evaluateAll(nodes => nodes.map(n =>
      n.classList.contains('capture-gap') ? 'GAP' : n.querySelector('p')!.textContent!.trim()));
    assert.deepEqual(await visible(), scenario.text, scenario.name);
    await page.evaluate(() => { (window as any).gapKeyNodes = new Map([...document.querySelectorAll('#transcript .para')].map(n => [(n as HTMLElement).dataset.key, n])); });
    await show({ ...scenario.snapshot, labelled: true });
    assert.deepEqual(await visible(), scenario.text, 'every owned word survives another poll');
    assert.equal(await page.locator('#transcript .para').evaluateAll(nodes => nodes.every(n =>
      (window as any).gapKeyNodes.get((n as HTMLElement).dataset.key) === n)), true, 'same first words retain their DOM nodes');
    results.push(`confirmation fix: ${scenario.name}`);
  }
}
