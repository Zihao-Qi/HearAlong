'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, systemPreferences, powerSaveBlocker, dialog, screen, session } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { locations } = require('./locations.cjs');
const { backgroundLabel, backgroundVisible, backgroundQuitText, miniVisible, serverExit, permissionAllowed, navigation } = require('./policy.cjs');
const { logger, logTail, availablePort, startServer, ServerSession } = require('./server.cjs');

let config;
try { config = locations(process.env, app.isPackaged); }
catch (error) { app.whenReady().then(() => { dialog.showErrorBox('HearAlong could not run', error.message); app.exit(1); }); }
if (config) launch();
function launch() {
  app.setName('HearAlong');
  app.setPath('userData', config.userData);
  if (config.testing) {
    // Never accept Chromium test switches from environment in a packaged app.
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  }
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  const log = logger(config);
  const api = new ServerSession(config.origin);
  let main, mini, server, tray, blocker, timer, pollBusy = false, live, background;
  let quitting = false, finished = false, askingQuit = false, failing = false, loaded = false, wasFrontmost = true;
  let focusCount = 0;
  const frontmost = () => Boolean(main?.isFocused());
  const preferences = () => ({ preload: config.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
    additionalArguments: [`--hearalong-origin=${config.origin}`] });
  const boundsFile = join(config.userData, 'window.json');
  function bounds() {
    try {
      const b = JSON.parse(readFileSync(boundsFile, 'utf8'));
      if (Number.isInteger(b.width) && b.width >= 640 && b.width <= 10000 && Number.isInteger(b.height) && b.height >= 480 && b.height <= 10000
        && screen.getAllDisplays().some(d => b.x >= d.workArea.x && b.y >= d.workArea.y && b.x < d.workArea.x + d.workArea.width && b.y < d.workArea.y + d.workArea.height)) return b;
    } catch { /* First run. */ }
    return { width: 1200, height: 800 };
  }
  function secure(window) {
    const wc = window.webContents;
    const navigate = (event, url) => {
      const decision = navigation(config.origin, url);
      if (decision !== 'allow') {
        event.preventDefault();
        if (decision === 'external') void shell.openExternal(url);
      }
    };
    wc.on('will-navigate', navigate);
    wc.on('will-redirect', navigate);
    wc.on('will-frame-navigate', event => navigate(event, event.url));
    wc.setWindowOpenHandler(({ url }) => {
      if (navigation(config.origin, url) === 'external') void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-prevent-unload', event => {
      if (quitting || dialog.showMessageBoxSync(window, {
        type: 'question', title: 'Leave this recording?', message: 'Leave while audio is being recorded?',
        detail: 'This recording stops now.', buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0,
      }) === 1) event.preventDefault(); // Electron: prevent the prevention, i.e. allow leaving.
    });
    wc.on('render-process-gone', (_event, details) => {
      if (!quitting && window === mini) setTimeout(() => { if (!quitting && mini && !mini.isDestroyed()) void mini.loadURL(config.origin + '/mini.html'); }, 2000);
      else if (!quitting) {
        log(`Main window stopped (${details.reason}); reloading.`);
        setTimeout(() => {
          if (!quitting && main && !main.isDestroyed()) {
            const reload = loaded ? main.loadURL(config.origin) : main.loadFile(config.starting);
            void reload.catch(error => log(`Main window reload failed: ${error.message}`));
          }
        }, 2000);
      }
    });
  }
  function makeMain() {
    main = new BrowserWindow({ ...bounds(), minWidth: 640, minHeight: 480, title: 'HearAlong',
      backgroundColor: '#f6f3ed', webPreferences: preferences() });
    secure(main);
    main.on('close', () => {
      try { writeFileSync(boundsFile, JSON.stringify(main.getNormalBounds())); } catch { /* Optional preference. */ }
    });
    main.on('closed', () => { main = null; void poll(); });
    main.on('focus', () => { mini?.hide(); void poll(); });
    main.on('blur', () => { void poll(); });
    if (loaded) void main.loadURL(config.origin);
    else void main.loadFile(config.starting);
    return main;
  }
  function open() {
    const window = main || makeMain();
    if (window.isMinimized()) window.restore();
    app.show(); window.show(); app.focus({ steal: true }); window.focus(); focusCount++;
  }
  function makeMini() {
    const area = screen.getPrimaryDisplay().workArea;
    mini = new BrowserWindow({ title: 'HearAlong', width: 360, height: 268, minWidth: 260, minHeight: 200,
      maxWidth: 640, maxHeight: 640, x: area.x + area.width - 376, y: area.y + 16,
      show: false, type: 'panel', focusable: false, acceptFirstMouse: true, skipTaskbar: true,
      webPreferences: preferences() });
    mini.setAlwaysOnTop(true, 'floating');
    mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    secure(mini);
    mini.on('close', event => { if (!quitting) { event.preventDefault(); mini.hide(); void sendMini('closed'); } });
    mini.webContents.on('did-fail-load', (_event, code) => {
      if (code !== -3 && !quitting) setTimeout(() => { if (!quitting && mini && !mini.isDestroyed()) void mini.loadURL(config.origin + '/mini.html'); }, 2000);
    });
    void mini.loadURL(config.origin + '/mini.html');
    return mini;
  }
  async function sendMini(action) {
    if (live?.session == null || quitting) return;
    try { await api.request('/api/live/mini', { session: live.session, action }); } catch { /* Poll retries/renews the session. */ }
  }
  function showBackground(status) {
    if (!backgroundVisible(status, Boolean(server))) { tray?.destroy(); tray = null; return; }
    if (!tray) {
      // A small template waveform, independent of packaging assets.
      const bitmap = Buffer.alloc(18 * 18 * 4);
      for (const [x, height] of [[1, 4], [5, 10], [9, 16], [13, 10], [16, 4]]) {
        for (let y = (18 - height) / 2; y < (18 + height) / 2; y++) {
          for (let dx = 0; dx < 2; dx++) bitmap[(y * 18 + x + dx) * 4 + 3] = 255;
        }
      }
      const image = nativeImage.createFromBitmap(bitmap, { width: 18, height: 18 });
      image.setTemplateImage(true); tray = new Tray(image); tray.setToolTip('HearAlong');
    }
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: backgroundLabel(status), enabled: false }, { label: 'HearAlong quits by itself when done.', enabled: false },
      { type: 'separator' }, { label: 'Open HearAlong', click: open }, { label: 'Quit HearAlong', click: () => app.quit() },
    ]));
  }
  async function poll() {
    if (!loaded || quitting || pollBusy) return;
    pollBusy = true;
    try {
      const previous = live?.session;
      live = await api.request('/api/live/window');
      if (live.session != null && !frontmost() && (previous !== live.session || wasFrontmost)) {
        // Away opens only once per recording, respecting manual close and Settings.
        await sendMini('away');
        if (previous !== live.session || !live.show) live = await api.request('/api/live/window');
      }
      if (miniVisible(live, frontmost())) {
        const window = mini || makeMini();
        if (!window.isVisible()) { window.showInactive(); void window.webContents.executeJavaScript('window.miniRefresh?.()').catch(() => {}); }
      } else mini?.hide();
      wasFrontmost = frontmost();
      background = await api.request('/api/helper/status');
      showBackground(background);
      const active = live.session != null || background.working;
      if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!active && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
    } catch { /* A transient failure is retried in 500 ms. */ }
    finally { pollBusy = false; }
  }
  async function stop(code = 0) {
    if (quitting) return;
    quitting = true; clearInterval(timer); tray?.destroy(); tray = null; mini?.hide();
    if (blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
    try { await server?.stop(); }
    finally {
      log('Helper quitting.'); finished = true;
      // Destroy after graceful server/page drain: no second beforeunload confirmation.
      main?.destroy(); mini?.destroy(); app.exit(code);
    }
  }
  async function fail(message) {
    if (failing || quitting) return;
    failing = true; log(`Helper error: ${message}`);
    // Keep the log on disk; redact the internal address from user-visible diagnostics.
    const details = logTail(config).replace(/https?:\/\/127\.0\.0\.1(?::\d+)?\S*/g, 'HearAlong').replace(/\b(?:HearAlong Helper|Helper)\b/g, 'HearAlong');
    await dialog.showMessageBox({ type: 'error', title: 'HearAlong could not run', message,
      detail: `Last lines of launcher.log:\n${details}`, buttons: ['OK'] });
    await stop(1);
  }
  async function requestQuit() {
    if (quitting || askingQuit) return;
    askingQuit = true;
    try {
      // Do not rely on a stale 500 ms snapshot for destructive decisions.
      let status;
      try { status = await api.request('/api/helper/status'); }
      catch { status = background || { working: true }; }
      if (status.working) {
        const wording = backgroundQuitText(status);
        const answer = await dialog.showMessageBox({ type: 'question', title: wording.title, message: wording.title,
          detail: wording.text, buttons: ['Keep running', 'Quit'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return;
      }
      await stop();
    } finally { askingQuit = false; }
  }
  app.on('second-instance', open);
  app.on('activate', () => { if (!quitting) open(); });
  app.on('window-all-closed', () => {}); // The server owns idle stop, not Electron's last-window rule.
  app.on('before-quit', event => { if (!finished) { event.preventDefault(); void requestQuit(); } });
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  app.whenReady().then(async () => {
    app.dock?.setIcon(config.icon);
    app.setAboutPanelOptions({ applicationName: 'HearAlong', applicationVersion: app.getVersion() });
    const ses = session.defaultSession;
    ses.setPermissionCheckHandler((wc, permission, origin, details) =>
      Boolean(wc && navigation(config.origin, wc.getURL()) === 'allow' && permissionAllowed(config.origin, permission, origin, details)));
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      let origin = '';
      try { origin = new URL(details.requestingUrl).origin; } catch { /* Deny malformed. */ }
      const allowed = navigation(config.origin, wc.getURL()) === 'allow' && permissionAllowed(config.origin, permission, origin, details);
      if (!allowed) { callback(false); return; }
      if (config.testing || process.platform !== 'darwin') callback(true);
      else systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    });
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    // Even subresources cannot load remote content; web links are handled by secure().
    ses.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try { const url = new URL(details.url); allowed = url.protocol === 'file:' || url.origin === config.origin; } catch { /* Deny. */ }
      callback({ cancel: !allowed });
    });
    const trusted = event => event.senderFrame === event.sender.mainFrame && navigation(config.origin, event.senderFrame.url) === 'allow'
      && (event.sender === main?.webContents || event.sender === mini?.webContents);
    ipcMain.handle('hearalong:microphone-status', event => {
      if (!trusted(event)) throw new Error('Not allowed');
      return config.testing ? 'granted' : process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'not-determined';
    });
    ipcMain.handle('hearalong:allow-microphone', event => {
      if (!trusted(event)) throw new Error('Not allowed');
      return config.testing || process.platform !== 'darwin' ? true : systemPreferences.askForMediaAccess('microphone');
    });
    ipcMain.handle('hearalong:microphone-settings', event => {
      if (!trusted(event)) throw new Error('Not allowed');
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    });
    ipcMain.on('hearalong:activate', event => { if (trusted(event)) open(); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'HearAlong', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: 'Open HearAlong', click: open }] },
    ]));
    makeMain(); log('Helper started directly.');
    try {
      await availablePort(config);
      server = startServer(config, log, (code) => {
        const decision = serverExit(code, quitting);
        if (decision === 'quit') void stop();
        if (decision === 'error') void fail('The server stopped unexpectedly.');
      });
      const deadline = Date.now() + 60000;
      while (!quitting && !failing && server.alive() && Date.now() < deadline) {
        try {
          if (await api.ready()) {
            loaded = true;
            if (main) await main.loadURL(config.origin);
            timer = setInterval(() => { void poll(); }, 500); await poll(); return;
          }
        } catch { /* Wait for owned server, never adopt another server. */ }
        await delay(500);
      }
      if (!quitting && !failing && server.alive()) await fail('The server did not answer within 60 s.');
    } catch (error) { await fail(`The server could not start: ${error.message}`); }
  }).catch(error => { void fail(error.message); });
  // No renderer debug/test IPC. Playwright can inspect the main process only in development.
  if (config.testing) module.exports.state = () => ({ live, background, quitting, focusCount, loaded, serverPid: server?.child.pid,
    miniVisible: mini?.isVisible() || false, frontmost: frontmost(), blocker, tray: Boolean(tray) });
}
