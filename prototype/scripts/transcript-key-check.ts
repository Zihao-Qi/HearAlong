import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { transcriptRows, type TranscriptSnapshot } from '../public/transcript-view.js';

/** Check the model too: a duplicate key can overwrite a DOM node, hiding the collision from a DOM-only assertion. */
export function assertUniqueTranscriptKeys(snapshot: TranscriptSnapshot) {
  const keys = transcriptRows(snapshot).map(row => row.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate transcript row keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
}

export async function watchTranscriptKeys(page: Page) {
  await page.addInitScript(() => {
    const state = { observing: true, frames: 0, errors: [] as string[] };
    (window as any).transcriptKeyCheck = state;
    const tick = () => {
      if (!state.observing) return;
      const keys = [...document.querySelectorAll('#transcript .para')].map(n => (n as HTMLElement).dataset.key);
      if (keys.length) state.frames++;
      if (new Set(keys).size !== keys.length && state.errors.length < 5) state.errors.push(JSON.stringify(keys));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function finishTranscriptKeyCheck(page: Page) {
  const state = await page.evaluate(() => { const state = (window as any).transcriptKeyCheck; state.observing = false; return state; });
  assert.ok(state.frames > 0);
  assert.deepEqual(state.errors, [], 'every painted transcript has unique row keys, including held selections and growth rows');
  return `unique transcript keys on ${state.frames} row-bearing painted frames`;
}
