'use strict';
// Local macOS integration check, never CI. Only fake audio; never opens a user's browser.
const assert = require('node:assert/strict');
const playwright = require('playwright-core');
const { _electron } = playwright;
async function nativeFocus(page) {
  // Electron launch does not expose noDefaults. Disable focus emulation on Playwright's
  // own CDP session (a second session cannot undo it). Pinned playwright-core 1.64.0.
  const client = playwright._connection.toImpl(page).delegate._mainFrameSession._client;
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
const { cp, mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const executablePath = require('electron');
const output = process.argv[2];
if (process.platform !== 'darwin') throw new Error('Run this local check on macOS.');
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  assert.ok(![4318, 11434, 1234].includes(value)); return value;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
// Playwright's application close event is not proof that the OS process exited.
const electronChildren = new Set();
function ownElectron(child) { electronChildren.add(child); return child; }
async function exited(child) {
  await until(() => child.exitCode !== null || child.signalCode !== null, 'Electron OS process exit', 40000);
}
function closedElectron(application, options) {
  return Promise.all([application.waitForEvent('close', options), exited(application.process())]);
}
function frontPid() {
  return Number(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier"], { encoding: 'utf8' }).trim());
}
function finder() {
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder').firstObject.activateWithOptions(2)"], { stdio: 'ignore' });
}
(async () => {
  const root = await mkdtemp(join(tmpdir(), 'hearalong-desktop-check-'));
  const results = { cases: [], rootRemoved: false };
  let electron, owned = [], database;
  const passed = label => { results.cases.push(label); console.log('PASS', label); };
  try {
    for (const mode of ['conflict-known', 'conflict-unknown', 'conflict-stubborn', 'capture', 'recording', 'crash', 'renderer', 'idle']) {
      const scope = join(root, mode), home = join(scope, 'home'), data = join(scope, 'meetings');
      await mkdir(home, { recursive: true });
      const PORT = String(await port());
      let listener;
      if (mode.startsWith('conflict-')) {
        let executable = process.execPath;
        if (mode !== 'conflict-unknown') {
          executable = join(scope, 'HearAlong.app/Contents/MacOS/node');
          await mkdir(join(scope, 'HearAlong.app/Contents/MacOS'), { recursive: true });
          await cp(process.execPath, executable);
        }
        listener = ownElectron(spawn(executable, ['-e', `
          ${mode === 'conflict-stubborn' ? "process.on('SIGTERM', () => {});" : ''}
          require('node:net').createServer().listen(${PORT}, '127.0.0.1', () => console.log('ready'));
        `], { stdio: ['ignore', 'pipe', 'pipe'] }));
        await once(listener.stdout, 'data');
      }
      const env = { ...process.env, HOME: home, MEETING_DATA_DIR: data, PORT, HEARALONG_NODE: process.execPath,
        MEETING_CLOUD: '0', HEARALONG_DESKTOP_TEST: '1', HEARALONG_DESKTOP_TEST_HIDE_DOCK: mode === 'recording' ? '0' : '1',
        MEETING_IDLE_EXIT_S: mode === 'idle' ? '6' : '60',
        HEARALONG_DESKTOP_TEST_SETUP: ['idle', 'renderer', 'capture'].includes(mode) ? '1' : '0',
        ...(mode === 'capture' ? { HEARALONG_DESKTOP_TEST_CAPTURE: join(__dirname, 'fixture-capture.cjs'), HEARALONG_DESKTOP_TEST_CAPTURE_EVENTS: join(scope, 'capture-events.jsonl') } : {}),
        HF_HOME: join(scope, 'empty-hf'), XDG_CACHE_HOME: join(scope, 'cache'), XDG_CONFIG_HOME: join(scope, 'config') };
      delete env.ELECTRON_RUN_AS_NODE;
      electron = await _electron.launch({ executablePath, args: [__dirname], env, timeout: 30000 });
      ownElectron(electron.process());
      // Intercept native dialog and external-open APIs so checks cannot prompt or drive a real browser.
      await electron.evaluate(({ dialog, shell }) => {
        globalThis.checkDialogs = []; globalThis.checkExternal = []; globalThis.checkAnswer = 0;
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1); globalThis.checkDialogs.push(options);
          if (options.type === 'error') return new Promise(resolve => { globalThis.checkErrorDone = () => resolve({ response: 0 }); });
          return { response: globalThis.checkAnswer };
        };
        dialog.showMessageBoxSync = (...args) => { globalThis.checkDialogs.push(args.at(-1)); return globalThis.checkAnswer; };
        shell.openExternal = async url => { globalThis.checkExternal.push(url); };
      });
      const page = await electron.firstWindow();
      if (!listener) {
        const starting = await page.locator('h1').textContent();
        assert.equal(starting, 'Starting HearAlong…');
        assert.equal(await page.locator('p').textContent(), 'This takes a few seconds.');
      }
      if (listener) {
        await page.locator('#retry').waitFor({ state: 'visible' });
        if (mode === 'conflict-unknown') {
          assert.equal(await page.locator('#detail').textContent(), `Another program is using port ${PORT}, which HearAlong needs. Quit that program, then open HearAlong again.`);
          assert.equal(await page.locator('#quit-other').isHidden(), true);
          listener.kill('SIGTERM'); await exited(listener);
          await page.locator('#retry').click();
        } else {
          assert.equal(await page.locator('#detail').textContent(), 'Another copy of HearAlong is already running, so this one cannot start. Quit the other copy, then open HearAlong again.');
          await page.locator('#quit-other').click();
          if (mode === 'conflict-stubborn') {
            await until(async () => (await page.locator('#detail').textContent()).includes('has not freed the port'), 'ten-second timeout', 15000);
            assert.equal(await page.locator('#quit-other').isVisible(), true);
            assert.equal(await page.locator('#quit-other').isEnabled(), true);
            listener.kill('SIGKILL'); await exited(listener);
            await page.locator('#retry').click();
          } else await exited(listener);
        }
        await page.waitForURL(`http://127.0.0.1:${PORT}/`, { timeout: 30000 });
        await until(async () => { try { owned = [JSON.parse(await readFile(join(data, 'ready.json'), 'utf8')).pid, ...Object.values(JSON.parse(await readFile(join(data, 'descendants.json'), 'utf8')))]; return owned.length === 3; } catch { return false; } }, 'recovered descendants');
        assert.equal(await page.evaluate(() => Boolean(window.hearalongStartup)), false);
        const closed = closedElectron(electron);
        electron.process().kill('SIGTERM'); await closed; electron = null;
        await until(() => owned.every(pid => !alive(pid)), 'recovered server group cleanup');
        owned = []; passed(`${mode}: local error page, safe action, then normal startup`);
        continue;
      }
      await page.waitForURL(`http://127.0.0.1:${PORT}/${['idle', 'renderer', 'capture'].includes(mode) ? 'setup' : ''}`, { timeout: 30000 });
      await page.waitForFunction(() => window.hearalong?.desktop);
      // Playwright otherwise emulates focus, making document.hasFocus() unusable as native evidence.
      await nativeFocus(page);
      const serverPid = JSON.parse(await readFile(join(data, 'ready.json'), 'utf8')).pid;
      await until(async () => { try { owned = [serverPid, ...Object.values(JSON.parse(await readFile(join(data, 'descendants.json'), 'utf8')))]; return owned.length === 3; } catch { return false; } }, 'descendants');
      const inspect = () => electron.evaluate(({ app }) => process.mainModule.require(app.getAppPath() + '/main.cjs').state());
      passed(`${mode}: disk starting page then own server page`);
      if (mode === 'capture') {
        const events = async () => (await readFile(join(scope, 'capture-events.jsonl'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return ''; throw error;
        })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        await until(async () => (await events()).length === 1, 'capture started after server');
        let previous = (await inspect()).capturePid;
        owned.push(previous);
        assert.equal((await events())[0].group, serverPid);
        assert.equal((await events())[0].base, `http://127.0.0.1:${PORT}`);
        passed('capture starts after own server answers, with base/Origin/server group');
        for (const seconds of [1, 2, 4]) {
          const crashedAt = Date.now();
          process.kill(previous, 'SIGKILL');
          await until(async () => { const pid = (await inspect()).capturePid; return pid && pid !== previous; }, `capture restart ${seconds} s`);
          previous = (await inspect()).capturePid; owned.push(previous);
          assert.ok(Date.now() - crashedAt >= seconds * 1000 - 50);
          await until(async () => (await events()).filter(e => e.event === 'start').length === Math.log2(seconds) + 2, 'restart event');
        }
        passed('capture crash restarts with 1/2/4-second exponential backoff');
        const closed = closedElectron(electron);
        electron.process().kill('SIGTERM');
        await closed; electron = null;
        const recorded = await events();
        assert.deepEqual(recorded.slice(-2).map(e => [e.event, e.serverAlive]), [['term', true], ['drained', true]]);
        assert.ok(recorded.at(-1).at - recorded.at(-2).at >= 550);
        const log = await readFile(join(data, 'logs/launcher.log'), 'utf8');
        for (const seconds of [1, 2, 4]) assert.ok(log.includes(`Restarting audio capture in ${seconds} s.`));
        assert.ok(log.lastIndexOf('Audio capture exited (0).') < log.lastIndexOf('Server exited'));
        await until(() => owned.every(pid => !alive(pid)), 'capture/server cleanup');
        owned = []; passed('quit sends capture SIGTERM and waits for drain before stopping server');
        continue;
      }
      if (mode === 'renderer') {
        await page.waitForSelector('[data-setup-row="microphone"]');
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() !== 'HearAlong mini')?.webContents.forcefullyCrashRenderer());
        // Playwright permanently marks its Page crashed; inspect the recovered native WebContents instead.
        await until(async () => electron.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          if (!window || window.webContents.isLoading() || window.webContents.isCrashed()) return false;
          return window.webContents.executeJavaScript('Boolean(document.querySelector(\'[data-setup-row="microphone"]\'))');
        }).catch(() => false), 'reloaded main setup page');
        assert.equal((await inspect()).serverPid, serverPid);
        assert.match(await readFile(join(data, 'logs/launcher.log'), 'utf8'), /Main window stopped .*reloading/);
        const closed = closedElectron(electron);
        await electron.evaluate(({ app }) => app.quit());
        await closed; electron = null;
        await until(() => owned.every(pid => !alive(pid)), 'renderer recovery group cleanup');
        owned = []; passed('main renderer crash reloads without stopping the server; quit cleans group');
        continue;
      }
      if (mode === 'idle') {
        await page.waitForSelector('[data-setup-row="microphone"]');
        assert.equal(await page.locator('[data-setup-row="chrome"]').count(), 0);
        // Exercise native tray glue with a scripted helper status, not a real AI job.
        await electron.evaluate(({ app, BrowserWindow }) => {
          const Session = process.mainModule.require(app.getAppPath() + '/server.cjs').ServerSession;
          globalThis.checkRealRequest = Session.prototype.request;
          Session.prototype.request = function(path, body) {
            if (path === '/api/helper/status') return Promise.resolve({ pageOpen: BrowserWindow.getAllWindows().length > 0,
              working: true, kind: 'notes', label: 'Writing notes for Fictional review', title: 'Fictional review' });
            return globalThis.checkRealRequest.call(this, path, body);
          };
        });
        const closed = closedElectron(electron, { timeout: 30000 });
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await until(async () => (await inspect()).tray, 'background tray', 2500);
        assert.ok((await inspect()).blocker !== undefined);
        await electron.evaluate(({ app }) => app.quit());
        await until(async () => (await electron.evaluate(() => globalThis.checkDialogs)).some(d => d.message === 'Quit while notes are being written?'), 'background quit text', 2000);
        assert.equal((await inspect()).quitting, false);
        await electron.evaluate(({ app }) => {
          process.mainModule.require(app.getAppPath() + '/server.cjs').ServerSession.prototype.request = globalThis.checkRealRequest;
        });
        passed('scripted background status creates tray and suspension blocker; notes Quit asks and cancels');
        await closed; electron = null;
        await until(() => owned.every(pid => !alive(pid)), 'idle process group cleanup');
        owned = []; passed('first-run Setup redirect works; last window closes and server idle stop ends app/group');
        continue;
      }
      if (mode === 'crash') {
        process.kill(serverPid, 'SIGKILL');
        await until(async () => (await electron.evaluate(() => globalThis.checkDialogs)).some(d => d.message === 'The server stopped unexpectedly.'), 'crash error');
        const errors = await electron.evaluate(() => globalThis.checkDialogs);
        assert.match(errors.at(-1).detail, /Last lines of launcher.log/);
        assert.ok(!errors.at(-1).detail.includes('127.0.0.1'));
        assert.ok(!errors.at(-1).detail.includes('Helper'));
        const closed = closedElectron(electron);
        await electron.evaluate(() => globalThis.checkErrorDone());
        await closed; electron = null;
        await until(() => owned.every(pid => !alive(pid)), 'crash process group cleanup');
        owned = []; passed('server crash shows log-tail error then closes app and descendants');
        continue;
      }
      const prefs = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
      assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false);
      const denied = await page.evaluate(async () => {
        const result = {};
        for (const [key, constraints] of [['video', { video: true }], ['both', { audio: true, video: true }]]) {
          try { const stream = await navigator.mediaDevices.getUserMedia(constraints); stream.getTracks().forEach(t => t.stop()); result[key] = 'allowed'; }
          catch (error) { result[key] = error.name; }
        }
        const frame = document.createElement('iframe'); frame.src = '/mini.html';
        await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
        try { const stream = await frame.contentWindow.navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); result.subframeAudio = 'allowed'; }
        catch (error) { result.subframeAudio = error.name; }
        result.subframePreload = Boolean(frame.contentWindow.hearalong);
        frame.remove();
        result.notifications = await Notification.requestPermission();
        result.geo = (await navigator.permissions.query({ name: 'geolocation' })).state;
        return result;
      });
      assert.notEqual(denied.video, 'allowed'); assert.notEqual(denied.both, 'allowed');
      assert.notEqual(denied.subframeAudio, 'allowed'); assert.equal(denied.subframePreload, false);
      assert.equal(denied.notifications, 'denied'); assert.equal(denied.geo, 'denied');
      passed('sandbox and real non-audio permission denials');
      await page.evaluate(() => { location.href = 'https://example.invalid/blocked'; });
      await until(async () => (await electron.evaluate(() => globalThis.checkExternal)).length > 0, 'external navigation interception');
      assert.equal(page.url(), `http://127.0.0.1:${PORT}/`);
      await page.evaluate(() => { location.href = 'file:///tmp/fictional-refused.html'; });
      await delay(300); assert.equal(page.url(), `http://127.0.0.1:${PORT}/`);
      passed('off-origin and file navigation blocked; external http(s) delegated without opening browser');
      // Browser UI unchanged outside the app; exercise app-only setup text using the real SetupUI.
      const setup = await page.evaluate(async () => {
        const { SetupUI } = await import('/setup-ui.js');
        const ui = new SetupUI(document.createElement('div'));
        await ui.permissions(); ui.mic = 'prompt'; const prompt = ui.microphone().textContent;
        ui.mic = 'denied'; const denied = ui.microphone().textContent;
        return { prompt, denied };
      });
      assert.match(setup.prompt, /So HearAlong won’t ask in your first meeting/);
      assert.match(setup.denied, /Open Settings/);
      await page.evaluate(async () => {
        const headers = { 'Content-Type': 'application/json' };
        const settings = await fetch('/api/settings', { method: 'PUT', headers, body: JSON.stringify({ miniOpensItself: true }) });
        if (!settings.ok) throw new Error(await settings.text());
        const meeting = await (await fetch('/api/meetings', { method: 'POST', headers, body: JSON.stringify({ title: 'Fictional lantern review' }) })).json();
        localStorage.setItem('meeting-id', meeting.id);
      });
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#start') && !document.querySelector('#start').disabled);
      // File/device fakes can hang in Chromium's macOS audio service. A generated stream never opens a physical input.
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const audio = new AudioContext({ sampleRate: 16000 });
          const oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
          oscillator.connect(destination); oscillator.start(); await audio.resume();
          const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
          track.stop = () => { stop(); oscillator.stop(); void audio.close(); };
          return destination.stream; // Not connected to audio.destination: no sound through speakers.
        };
      });
      try {
        assert.equal(await page.locator('#start').isVisible(), true);
        assert.equal(await page.locator('#start').isEnabled(), true);
        // This case checks capture/lifecycle, not pointer routing. Native macOS occlusion can drop CDP mouse input.
        await page.evaluate(() => document.querySelector('#start').click());
        await page.locator('#start-mic').waitFor({ state: 'visible' });
        await page.evaluate(() => document.querySelector('#start-mic').click());
      }
      catch (error) {
        console.error('Recording UI diagnostic', await page.evaluate(() => ({ url: location.href, text: document.body.innerText,
          selected: localStorage.getItem('meeting-id'), start: document.querySelector('#start')?.outerHTML })));
        throw error;
      }
      await until(async () => (await inspect()).live?.session != null, 'recording');
      const started = Date.now();
      database = new DatabaseSync(join(data, 'meetings.sqlite'), { readOnly: true });
      await until(() => database.prepare('SELECT count(*) AS n FROM frames').get().n >= 2, 'saved frames');
      if (process.env.MEETING_DESKTOP_CHECK_SKIP_FOCUS !== '1') {
      await electron.evaluate(async ({ app, BrowserWindow }) => { await app.dock?.show(); app.show(); app.focus({ steal: true }); BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('/mini.html')).focus(); });
      try { await until(async () => (await inspect()).frontmost && frontPid() === electron.process().pid, 'HearAlong frontmost'); }
      catch (error) { console.error('Frontmost diagnostic', { state: await inspect(), frontPid: frontPid(), electronPid: electron.process().pid }); throw error; }
      assert.equal(await page.evaluate(() => document.hasFocus()), true);
      assert.equal((await inspect()).miniVisible, false);
      finder();
      try {
        await until(async () => !(await inspect()).frontmost && (await inspect()).miniVisible && frontPid() !== electron.process().pid, 'Finder front, mini visible');
      } catch (error) {
        console.error('Focus diagnostic', { state: await inspect(), frontPid: frontPid(), electronPid: electron.process().pid, pageFocus: await page.evaluate(() => document.hasFocus()), windows: await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), visible: w.isVisible(), focused: w.isFocused() }))) });
        throw error;
      }
      assert.equal(await page.evaluate(() => document.hasFocus()), false);
      const mini = electron.windows().find(p => p.url().endsWith('/mini.html')) || await electron.waitForEvent('window');
      await mini.waitForFunction(() => document.documentElement.dataset.host === 'native');
      await nativeFocus(mini);
      assert.equal(await mini.evaluate(() => document.hasFocus()), false);
      const nativeMini = await electron.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/mini.html'));
        return { top: w.isAlwaysOnTop(), spaces: w.isVisibleOnAllWorkspaces(), focusable: w.isFocusable(), visible: w.isVisible() };
      });
      assert.deepEqual(nativeMini, { top: true, spaces: true, focusable: false, visible: true });
      assert.equal(await mini.evaluate(async () => (await (await fetch('/api/live')).json()).mini.state), 'open');
      await delay(3000);
      assert.equal(frontPid() === electron.process().pid, false);
      assert.equal(await page.evaluate(() => document.hasFocus()), false);
      passed('another app in front: native mini visible, page unfocused, panel nonactivating/all-workspaces/always-on-top');
      await mini.evaluate(() => window.hearalong.activate());
      await until(async () => (await inspect()).frontmost && !(await inspect()).miniVisible, 'mini activate main');
      assert.equal(await page.evaluate(() => document.hasFocus()), true);
      passed('mini preload activates main; frontmost hides mini, native/page agree');
      } else {
        results.skipped = ['native focus/mini activation (desktop unavailable)'];
        console.log('SKIP', results.skipped[0]);
      }
      await page.evaluate(() => document.querySelector('#start-online').click());
      assert.equal(await page.locator('#call-tab').isHidden(), true);
      const before = (await inspect()).focusCount;
      const second = ownElectron(spawn(executablePath, [__dirname], { env, stdio: 'ignore' }));
      await new Promise((resolve, reject) => { second.once('error', reject); second.once('exit', code => code === 0 ? resolve() : reject(new Error(`Second launch ${code}`))); });
      await until(async () => (await inspect()).focusCount > before, 'single instance focus');
      passed('second launch focuses the first and exits without another server');
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().endsWith('/mini.html')).close());
      await until(async () => (await electron.evaluate(() => globalThis.checkDialogs)).some(d => d.buttons?.includes('Stay')), 'native beforeunload question');
      assert.ok(!(await page.isClosed()));
      passed('recording beforeunload asks native Leave/Stay; Stay preserves recording');
      await electron.evaluate(({ app }) => app.quit());
      await until(async () => (await electron.evaluate(() => globalThis.checkDialogs)).some(d => d.message === 'Quit while audio is being recorded?'), 'recording quit confirmation');
      assert.equal((await inspect()).quitting, false);
      passed('Quit while recording asks helper wording; Keep running cancels quit');
      await delay(Math.max(0, 20000 - (Date.now() - started)));
      const frames = database.prepare('SELECT sequence,startMs,samples FROM frames ORDER BY sequence').all();
      assert.ok(frames.length >= 19, `Saved ${frames.length} frames`);
      frames.forEach((frame, index) => assert.equal(frame.sequence, index));
      const gaps = database.prepare('SELECT * FROM capture_gaps').all();
      assert.deepEqual(gaps, []);
      results.frames = frames.length; results.gaps = gaps.length;
      passed('~20 seconds fake microphone: saved consecutive frames, zero capture gaps');
      assert.ok((await inspect()).blocker !== undefined);
      database.close(); database = null;
      const closed = closedElectron(electron);
      await electron.evaluate(({ app }) => { globalThis.checkAnswer = 1; app.quit(); });
      await closed; electron = null;
      await until(() => owned.every(pid => !alive(pid)), 'graceful stop process group cleanup');
      const log = await readFile(join(data, 'logs/launcher.log'), 'utf8');
      assert.match(log, /Server exited with status 0/); assert.match(log, /Helper quitting/);
      owned = []; passed('confirmed Quit drains recording, exits server gracefully, kills stubborn child/grandchild');
    }
  } finally {
    database?.close();
    if (electron) {
      const closed = closedElectron(electron, { timeout: 40000 });
      try {
        await electron.evaluate(({ app }) => { globalThis.checkAnswer = 1; globalThis.checkErrorDone?.(); app.quit(); });
        await closed;
      } catch {
        electron.process().kill('SIGKILL');
        await closed.catch(() => {});
      }
    }
    for (const child of electronChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited(child);
    }
    // Only owned fixture processes; never signal unrelated processes.
    for (const pid of owned) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    await until(() => owned.every(pid => !alive(pid)), 'final owned fixture cleanup');
    const remaining = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes(join(__dirname, 'node_modules/electron/dist/Electron.app')));
    assert.deepEqual(remaining, [], 'no Electron process from this worktree remains');
    results.electronProcessesRemaining = remaining.length;
    await rm(root, { recursive: true, force: true }); results.rootRemoved = true;
    if (output) await writeFile(output, JSON.stringify(results, null, 2));
  }
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error); process.exitCode = 1; });
