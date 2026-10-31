// Surviving setup contracts, shared by the current UI check and the focused fixture drivers.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export async function assertSetupFix2(page: Page, id: number, facts: Record<string, any> = {}) {
  switch (id) {
    case 1:
      assert.equal(await page.locator('[data-setup-row="speech"] .su-detail').innerText(),
        `Parakeet 0.6B · ~/.cache/huggingface/…/parakeet-unified-en-0.6b-gguf${facts.shape === 'snapshot' ? '/model.gguf' : ''} (Pi Voice) · recordings use about 230 MB an hour, kept 1 day`); break;
    case 3:
      assert.equal(await page.locator('dialog [role="alert"]').innerText(), facts.kind === 'invalid' ? 'This file isn’t a speech model.' : facts.kind === 'other' ? 'Example picker failed.' : 'Couldn’t open this file.'); break;
    case 4:
      assert.deepEqual(facts.outcomes, [{ role: 'speech', open: 0, focused: true }, { role: 'ai', open: 0, focused: true }]); break;
    case 5:
      assert.equal(await page.getByRole('button', { name: 'Other options', exact: true }).count(), 1);
      assert.equal(await page.locator('[data-setup-row="speech"] .su-button.primary').count(), 1); break;
    case 6:
      for (const copy of await page.locator('[data-copy-command]').all()) { const box = await copy.boundingBox(); assert.ok(box && box.width >= 44 && box.height >= 44, 'every Copy target is at least 44 × 44 px'); }
      break;
    case 7: {
      const input = page.locator('#su-ai-main'), ids = (await input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
      assert.deepEqual(ids, facts.state === 'env' ? ['su-ai-main-environment'] : facts.state === 'invalid' ? ['su-ai-main-error'] : []);
      for (const id of ids) assert.equal(await page.locator(`#${id}`).isVisible(), true);
      assert.equal(await page.locator('#su-ai-quick').getAttribute('aria-describedby'), null, 'valid Quick has no hidden-hint description'); break;
    }
    case 8:
      assert.doesNotMatch(await page.locator('#setup-rows').innerText(), /'/, 'new visible setup prose uses curly apostrophes'); break;
    case 9:
      assert.equal(await page.locator('dialog .su-model-list .su-row .su-title').innerText(), 'None found');
      assert.equal(await page.locator('dialog .su-model-list .su-row .su-detail').innerText(), 'Looked in Pi Voice, the Hugging Face cache and MEETING_MODEL_PATH'); break;
  }
}

export async function assertSetupFix1(page: Page, id: number, facts: Record<string, any> = {}) {
  switch (id) {
    case 1:
      assert.equal(facts.idle, false, 'setup must keep the server alive beyond grace + idle');
      assert.ok(facts.heartbeats >= 3, 'setup sends X-Page heartbeats'); break;
    case 2:
      assert.equal(facts.count, 4, 'four cached rows visible before held response');
      assert.match(facts.missing, /Install it in Terminal/); assert.equal(facts.missingVisible, true);
      assert.equal(await page.locator('#setup-settings .su-row:visible').count(), 4, 'keep cached rows on a failed first refresh');
      assert.equal(await page.locator('.settings-nav [data-section="setup"]').getAttribute('aria-current'), 'page'); break;
    case 3:
      assert.deepEqual(facts, { 'model-action': true, 'model-focus': true }, 'action completion and foreground repair clear Speech off after discovering a model'); break;
    case 4:
      assert.equal(facts.firstError, false, 'one transient busy failure is silent');
      assert.equal(facts.secondError, true, 'two consecutive busy failures show an error');
      assert.equal(facts.reads, 7, 'busy polling recovers after six failed responses');
      assert.deepEqual(facts.times.slice(1).map((t: number, i: number) => t - facts.times[i]), [1000, 2000, 4000, 8000, 10000, 10000]);
      assert.equal(await page.locator('#fix1-error').isVisible(), false, 'success clears the error');
      assert.equal(facts.staleState, 'ready', 'late busy response cannot overwrite a newer ready snapshot'); break;
    case 5:
      assert.equal(await page.locator('#setup-settings .su-meter').count(), 0, 'late permission response must not restart the meter');
      assert.equal(await page.evaluate(() => (window as any).delayedMicStream.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended')), true); break;
    case 6:
      assert.equal(typeof facts.speech.downloadTargetPath, 'string', 'download target is present after restart, even when transfer is idle');
      assert.match(await page.locator('[data-setup-row="speech"] .su-detail').innerText(), / · downloaded · recordings use about 230 MB an hour, kept 1 day$/);
      assert.equal(await page.locator('dialog .su-choice .su-in-use').count(), 1); break;
    case 7:
      for (const width of [1280, 390]) assert.deepEqual(facts[width], { Download: true, Pause: true, Resume: true, 'Download again': true, 'Try again': true, 'Check again': true, Allow: true });
      break;
    case 8:
      assert.equal(await page.getByRole('link', { name: 'Open in Chrome' }).evaluate(e => e.closest('[data-setup-row]')?.getAttribute('data-setup-row')), 'chrome');
      assert.equal(await page.getByRole('link', { name: 'Open in Chrome' }).evaluate(e => e === document.activeElement), true); break;
    case 9:
      assert.doesNotMatch((await page.locator('.su-detail').allInnerTexts()).join('\n'), /\/private\/var|\/Users\/example|Hugging Face cache/);
      assert.match(await page.locator('[data-setup-row="speech"] .su-detail').innerText(), /^Whisper base · cache · no live preview · recordings use about 230 MB an hour, kept 1 day$/); break;
    case 10: {
      const text = await page.locator('[data-setup-row="speech"] .su-detail').innerText();
      assert.equal(text, 'Parakeet 0.6B · ~/.cache/huggingface/…/speech/parakeet-unified-en-0.6b-Q8_0.gguf (Pi Voice) · recordings use about 230 MB an hour, kept 1 day');
      assert.equal(text.split('parakeet-unified-en-0.6b-Q8_0.gguf').length - 1, 1); break;
    }
    case 11: {
      const row = page.locator('#setup-settings [data-setup-row="speech"]');
      assert.match(await row.innerText(), /Couldn’t switch to Example broken\. Still using Example current\./);
      const error = await row.locator('.su-switch-error').innerText(); assert.ok(error.length <= 120); assert.doesNotMatch(error, /\n|\s+at\s|\.ts:\d|\.gguf\.pids/);
      assert.equal(await row.locator('.su-error').count(), 0, 'calm row, not a red stack trace');
      const errorBox = await row.locator('.su-switch-error').boundingBox(); assert.ok(errorBox && errorBox.height <= 22, 'technical error occupies one visual line'); break;
    }
    case 12:
      assert.equal(await page.locator('dialog .su-model-list .su-in-use').count(), 0, 'downloaded model excluded from On this Mac');
      assert.equal(await page.locator('dialog .su-in-use').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Show all 4', exact: true }).count(), 1); break;
    case 13: {
      const use = await page.locator('dialog .su-model-list .su-button').first().boundingBox(), current = await page.locator('dialog .su-choice .su-in-use').boundingBox();
      assert.ok(use && current); assert.ok(Math.abs(use.width - current.width) <= 0.5, 'In use has Use button width');
      assert.ok(Math.abs(use.x + use.width - current.x - current.width) <= 0.5, 'In use and Use have the same right edge'); break;
    }
    case 14:
      assert.equal(await page.locator('dialog .su-count').innerText(), 'From Pi · 1 model from 1 provider'); break;
    case 15: {
      assert.equal(await page.getByText('Model choices are set by the environment for this start.', { exact: true }).count(), 0);
      const hint = page.getByText('Set by the environment.', { exact: true }), save = page.getByRole('button', { name: 'Save', exact: true });
      assert.equal(await hint.count(), 1); assert.equal(await save.isDisabled(), true);
      assert.equal(await page.locator('#su-ai-main').inputValue(), 'example/main');
      assert.equal(await page.locator('#su-ai-main').evaluate((e: HTMLInputElement) => e.readOnly), true);
      assert.equal(await save.getAttribute('aria-describedby'), await hint.getAttribute('id')); assert.equal(await save.getAttribute('title'), await hint.innerText()); break;
    }
  }
}
