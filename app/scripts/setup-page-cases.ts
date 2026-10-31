// Current setup contracts carried forward into ui-pass. All paths/models/permissions are fictional.
import assert from 'node:assert/strict';
import type { Browser } from 'playwright-core';
import { join } from 'node:path';
import { runSetupFix1Checks } from './setup-fix1-check.ts';
import { runSetupFix2Checks } from './setup-fix2-check.ts';
import { assertSetupFix1, assertSetupFix2 } from './setup-assertions.ts';

export async function checkSetupPage(browser: Browser, url: string, out: string) {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage(), errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/setup.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.goto(url + '/setup');
      await page.evaluate(async () => {
        const path = '/setup-ui.js';
        const { SetupUI } = await import(path);
        const ui = new SetupUI(document.getElementById('setup-rows'));
        ui.status = { seen: false, rows: [
          { id: 'speech', state: 'none', download: { state: 'idle' }, downloadTargetPath: '/fictional/download.gguf' },
          { id: 'ai', state: 'ready', mode: 'off' }, { id: 'ffmpeg', state: 'missing' },
        ] };
        ui.active = true; ui.render();
        const refresh = ui.refresh.bind(ui);
        ui.refresh = (...args: any[]) => { ui.lastContractRefresh = refresh(...args); return ui.lastContractRefresh; };
        Object.assign(window, { setupContract: ui, copiedCommands: [] });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => (window as any).copiedCommands.push(s) } });
      });
      const speech = page.locator('[data-setup-row="speech"]');
      const show = (change: object) => page.evaluate(async change => {
        const ui = (window as any).setupContract; await ui.lastContractRefresh; ui.choice = null;
        ui.status.rows[0] = { id: 'speech', state: 'none', download: { state: 'idle' }, downloadTargetPath: '/fictional/download.gguf', ...change };
        ui.render();
      }, change);
      assert.equal(await page.getByText('Recording needs Google Chrome').count(), 0);
      const copy = page.getByRole('button', { name: 'Copy brew install ffmpeg', exact: true });
      await copy.click(); await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).copiedCommands), ['brew install ffmpeg']);
      assert.equal(await page.getByRole('button', { name: 'Copied', exact: true }).textContent(), 'Copied');
      for (const [state, detail, label, action] of [
        ['scanning', 'Looking on this Mac…', null, null],
        ['none', 'None found. Parakeet:', 'Download', 'download'],
        ['downloading', '312 of 731 MB · about 1 min left', 'Pause', 'pause'],
        ['paused', 'Paused at 312 of 731 MB', 'Resume', 'download'],
        ['interrupted', 'Connection lost at 312 of 731 MB', 'Resume', 'download'],
        ['checking', 'Checking the file…', null, null],
        ['damaged', 'The file is damaged.', 'Download again', 'download'],
        ['noSpace', 'Not enough space. 831 MB needed.', 'Try again', 'download'],
        ['missing', 'The saved speech model is missing: absent.gguf', 'Download', 'download'],
      ] as const) {
        const snapshot = { state, missingPath: '/fictional/absent.gguf', download: { state, bytes: 312_000_000, total: 731_357_568, etaSeconds: 61, neededBytes: 831_357_568 } };
        await show(snapshot);
        if (state === 'none') assert.ok((await speech.innerText()).includes(detail));
        else assert.equal(await speech.locator('.su-detail').first().textContent(), detail);
        if (['downloading', 'paused', 'interrupted', 'checking'].includes(state)) assert.equal(await speech.getByRole('progressbar').count(), 1);
        if (label) {
          let release!: () => void;
          const held = new Promise<void>(r => { release = r; });
          let posted: unknown;
          await page.route(`**/api/setup/speech/${action}`, async route => {
            posted = route.request().postDataJSON(); await held; await route.fulfill({ json: {} });
          });
          await page.route('**/api/setup', async route => route.fulfill({ json: await page.evaluate(() => (window as any).setupContract.status) }));
          try {
            const requested = page.waitForRequest(r => r.url().endsWith(`/speech/${action}`));
            await speech.getByRole('button', { name: label, exact: true }).click(); await requested;
            assert.equal(await speech.getByRole('button', { name: label, exact: true }).isDisabled(), true);
            if (action === 'download') assert.deepEqual(posted, { use: true });
            release();
            await page.waitForFunction(() => !(window as any).setupContract.pendingActions.size);
            await page.evaluate(() => { const ui = (window as any).setupContract; clearTimeout(ui.timer); });
          } finally { release(); await page.unroute(`**/api/setup/speech/${action}`); await page.unroute('**/api/setup'); }
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: ${state} overflow`);
      }
      for (const [pending, detail] of [
        [{ applies: 'after recording', path: '/fictional/next.gguf' }, 'Change applies after recording · next.gguf'],
        [{ applies: 'between chunks', path: '/fictional/next.gguf' }, 'Loading the speech model…'],
      ] as const) {
        await show({ state: 'ready', label: 'Example speech', path: '/fictional/current.gguf', source: '~/Models', pending });
        assert.equal(await speech.locator('.su-detail').first().textContent(), detail);
      }
      // A long discovery list: keyboard open, fold/filter/empty filter, cancel and a successful picker.
      const models = Array.from({ length: 16 }, (_, i) => {
        const file = { path: `/fictional/model-${i}.gguf`, source: '~/Models', bytes: 100, fileType: 'Q8_0' };
        return { id: `model-${i}`, name: `Example speech ${String(i).padStart(2, '0')}`, streaming: true, sources: ['~/Models'], files: [file], chosenFile: file };
      });
      await page.route('**/api/setup/speech-models', route => route.fulfill({ json: { models, truncated: false } }));
      await show({ state: 'ready', label: 'Example speech 00', path: '/fictional/model-0.gguf', source: '~/Models' });
      await speech.getByRole('button', { name: 'Change', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Show all 16', exact: true }).waitFor();
      assert.equal(await page.locator('dialog .su-model-list .su-row').count(), 3);
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).focus();
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true);
      await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')), true);
      await page.getByRole('button', { name: 'Show all 16', exact: true }).click();
      await page.getByRole('searchbox').fill('speech 15'); assert.equal(await page.locator('dialog .su-model-list .su-row').count(), 1);
      await page.getByRole('searchbox').fill('not a model'); await page.getByText('No model matches', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Show fewer', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await speech.getByRole('button', { name: 'Change', exact: true }).evaluate(e => e === document.activeElement), true);
      let cancelled = true, ffFound = false;
      await page.route('**/api/setup/speech/choose-file', route => route.fulfill({ json: { cancelled } }));
      await page.route('**/api/setup', async route => {
        const state = await page.evaluate(() => (window as any).setupContract.status);
        if (ffFound) state.rows = state.rows.map((r: any) => r.id === 'ffmpeg' ? { id: 'ffmpeg', state: 'found' } : r);
        await route.fulfill({ json: state });
      });
      await speech.getByRole('button', { name: 'Change', exact: true }).click();
      await page.getByRole('button', { name: 'Choose…', exact: true }).click();
      assert.equal(await page.getByRole('dialog', { name: 'Speech model', exact: true }).count(), 1);
      cancelled = false; await page.getByRole('button', { name: 'Choose…', exact: true }).click();
      await page.getByRole('dialog', { name: 'Speech model', exact: true }).waitFor({ state: 'detached' });
      let used: unknown;
      await page.route('**/api/setup/speech/use', async route => { used = route.request().postDataJSON(); await route.fulfill({ json: {} }); });
      await speech.getByRole('button', { name: 'Change', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Show all 16', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.keyboard.type('speech 04'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Speech model', exact: true }).waitFor({ state: 'detached' });
      assert.deepEqual(used, { id: 'model-4' });
      // Closing the picker precedes its changed()/refresh completion. Do not mutate the next fixture while that reply
      // can still restore the previous AI row. This waits for the real owner refresh, not a rendering grace period.
      await page.evaluate(() => (window as any).setupContract.lastContractRefresh);
      for (const [state, text] of [
        ['reading', 'Reading Pi’s models…'], ['checking', 'Checking access…'], ['choose', 'Pi is signed in. Choose two models.'],
        ['not-installed', 'Pi is not installed. Run npm ci.'], ['unreadable', 'Couldn’t read Pi’s models.'],
        ['missing', 'Example missing model'], ['no-access', 'No access · Example missing model'],
        ['signed-out', 'Sign in with Pi in Terminal, then type /login — or add an API key with Choose models'],
      ]) {
        await page.evaluate(state => {
          const ui = (window as any).setupContract;
          ui.status.rows[1] = { id: 'ai', mode: 'cloud', state, detail: 'Example missing model', signInCommand: 'pi' }; ui.render();
        }, state);
        assert.equal(await page.locator('[data-setup-row="ai"] .su-detail').first().textContent(), text);
        if (['not-installed', 'unreadable'].includes(state)) {
          let release!: () => void;
          const gate = new Promise<void>(r => { release = r; });
          await page.route('**/api/setup/recheck', async route => { await gate; await route.fulfill({ json: {} }); });
          const row = page.locator('[data-setup-row="ai"]');
          try {
            await row.getByRole('button', { name: 'Check again', exact: true }).click();
            await row.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
            release(); await row.getByRole('button', { name: 'Check again', exact: true }).waitFor();
          } finally { release(); await page.unroute('**/api/setup/recheck'); }
        }
      }
      await page.getByRole('button', { name: 'Copy pi', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as any).copiedCommands), ['brew install ffmpeg', 'pi']);
      assert.equal(await page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Copied', exact: true }).count(), 1);
      await page.evaluate(() => { const ui = (window as any).setupContract; ui.status.rows[1] = { id: 'ai', mode: 'off', forcedOff: true }; ui.render(); });
      assert.equal(await page.locator('[data-setup-row="ai"] button').count(), 0);
      assert.equal(await page.locator('[data-setup-row="ai"] .su-detail').textContent(), 'Off for this start (MEETING_CLOUD=0).');
      // Large cloud catalogue and a server-side validation error are still current, now behind explicit consent.
      const aiModels = Array.from({ length: 320 }, (_, i) => ({ id: `example/example-${String(i).padStart(3, '0')}` }));
      await page.route('**/api/setup/ai/models?refresh=1*', route => route.fulfill({ json: { state: 'ok', models: aiModels, count: 320, providers: ['example'] } }));
      await page.route('**/api/setup/ai/keys?fresh=1', route => route.fulfill({ status: 503, json: { error: 'No keys in this fixture' } }));
      await page.evaluate(() => {
        const ui = (window as any).setupContract;
        ui.status.rows[1] = { id: 'ai', mode: 'cloud', state: 'ready', main: { id: 'example/example-001' }, quick: { id: 'example/example-002' } }; ui.render();
      });
      await page.locator('[data-setup-row="ai"]').getByRole('button', { name: 'Change', exact: true }).click();
      await page.locator('#su-ai-main').waitFor(); assert.equal(await page.locator('#su-pi-models option').count(), 320);
      await page.locator('#su-ai-main').fill('unknown');
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('#su-ai-main-error').isVisible(), true);
      await page.locator('#su-ai-main').fill('example/example-001'); await page.locator('#su-cloud-consent').check();
      await page.route('**/api/setup/ai', route => route.fulfill({ status: 400, json: { error: 'Pi doesn’t list example/example-001.' } }));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('alert').getByText('Pi doesn’t list example/example-001.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByRole('dialog').evaluate(e => e.scrollWidth > e.clientWidth), false);
      await page.keyboard.press('Escape');
      // Permission UI without ever requesting a real input device.
      for (const [mic, text] of [['granted', 'Allowed'], ['denied', 'Blocked. In Chrome, click the site controls beside the address, then allow Microphone.']]) {
        await page.evaluate(mic => { const ui = (window as any).setupContract; ui.mic = mic; ui.render(); }, mic);
        assert.equal(await page.locator('[data-setup-row="microphone"] .su-detail').textContent(), text);
      }
      await page.evaluate(() => {
        const audio = new AudioContext(), dest = audio.createMediaStreamDestination();
        (window as any).setupMicrophoneStream = dest.stream;
        (window as any).setupMicrophoneAudio = audio;
        navigator.mediaDevices.getUserMedia = async () => dest.stream;
        const ui = (window as any).setupContract; ui.mic = 'prompt'; ui.render();
      });
      await page.getByRole('button', { name: 'Allow', exact: true }).click();
      await page.getByText('Say something', { exact: true }).waitFor();
      await page.waitForFunction(() => (window as any).setupMicrophoneStream.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended'));
      assert.equal(await page.getByRole('meter', { name: 'Microphone level', exact: true }).count(), 0);
      let releaseRecheck!: () => void;
      const recheck = new Promise<void>(r => { releaseRecheck = r; });
      await page.route('**/api/setup/recheck', async route => { await recheck; ffFound = true; await route.fulfill({ json: {} }); });
      try {
        await page.locator('[data-setup-row="ffmpeg"]').getByRole('button', { name: 'Check again', exact: true }).click();
        await page.locator('[data-setup-row="ffmpeg"]').getByRole('button', { name: 'Checking…', exact: true }).waitFor();
        releaseRecheck(); await page.locator('[data-setup-row="ffmpeg"]').getByText('Found', { exact: true }).waitFor();
      } finally { releaseRecheck(); }
      await page.evaluate(async () => {
        const ui = (window as any).setupContract; clearTimeout(ui.timer);
        ui.status.rows[0] = { id: 'speech', state: 'ready', label: 'Example speech', path: '/fictional/speech.gguf', source: '~/Models', download: { state: 'idle' } };
        await ui.refresh(); await (window as any).setupMicrophoneAudio.close();
      });
      let idleReads = 0;
      page.on('request', r => { if (new URL(r.url()).pathname === '/api/setup') idleReads++; });
      await page.clock.install(); await page.clock.runFor(2200);
      assert.equal(idleReads, 0, 'idle setup does not poll');
      await page.evaluate(() => (window as any).setupContract.stop({ dispose: true }));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  // These independently isolated fixture drivers now run as part of the maintained UI suite, not a legacy entry point.
  // FIX1.3 retains required-speech recovery; its obsolete FFmpeg-required branches are not current behaviour.
  const previous = { out1: process.env.SETUP_FIX1_OUT, cases1: process.env.SETUP_FIX1_CASES, out2: process.env.SETUP_FIX2_OUT, cases2: process.env.SETUP_FIX2_CASES };
  try {
    process.env.SETUP_FIX1_OUT = join(out, 'setup-fix1');
    process.env.SETUP_FIX1_CASES = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15';
    await runSetupFix1Checks(assertSetupFix1);
    process.env.SETUP_FIX2_OUT = join(out, 'setup-fix2');
    process.env.SETUP_FIX2_CASES = '1,3,4,5,6,7,8,9';
    await runSetupFix2Checks(assertSetupFix2);
  } finally {
    for (const [name, value] of Object.entries({ SETUP_FIX1_OUT: previous.out1, SETUP_FIX1_CASES: previous.cases1, SETUP_FIX2_OUT: previous.out2, SETUP_FIX2_CASES: previous.cases2 })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}
