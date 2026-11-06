'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const origin = process.argv.find(arg => arg.startsWith('--hearalong-origin='))?.slice('--hearalong-origin='.length);
const starting = process.argv.find(arg => arg.startsWith('--hearalong-starting='))?.slice('--hearalong-starting='.length);
// Sandboxed preloads cannot require node:url. This is its POSIX fileURLToPath
// conversion: reject non-local URLs/encoded separators, then decode the path.
function fileURLToPath(value) {
  const url = new URL(value);
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || /%2f/i.test(url.pathname)) throw new Error('Not a local file');
  return decodeURIComponent(url.pathname.replace(/%(?![\da-f]{2})/gi, '%25'));
}
function isStarting() { try { return fileURLToPath(location.href) === starting; } catch { return false; } }
if (process.isMainFrame && isStarting()) {
  // Keep startup actions private to this disk page, not the server's renderer.
  window.addEventListener('DOMContentLoaded', () => {
    const title = document.getElementById('title'), detail = document.getElementById('detail');
    const retry = document.getElementById('retry'), quitOther = document.getElementById('quit-other');
    function render(status) {
      title.textContent = status.message ? 'HearAlong could not start' : 'Starting HearAlong…';
      detail.textContent = status.message || 'This takes a few seconds.';
      retry.hidden = !status.message;
      quitOther.hidden = !status.canQuitOther;
      retry.disabled = quitOther.disabled = status.busy;
    }
    async function attempt(quit) {
      retry.disabled = quitOther.disabled = true;
      try { render(await ipcRenderer.invoke('hearalong:startup-retry', quit)); }
      catch { /* Successful startup navigates away and destroys this context. */ }
    }
    retry.onclick = () => { void attempt(false); };
    quitOther.onclick = () => { void attempt(true); };
    ipcRenderer.on('hearalong:startup-status', (_event, status) => render(status));
    void ipcRenderer.invoke('hearalong:startup-status').then(render);
  });
}
if (process.isMainFrame && location.origin === origin) {
  contextBridge.exposeInMainWorld('hearalong', Object.freeze({
    desktop: true,
    activate: () => ipcRenderer.send('hearalong:activate'),
    microphoneStatus: () => ipcRenderer.invoke('hearalong:microphone-status'),
    allowMicrophone: () => ipcRenderer.invoke('hearalong:allow-microphone'),
    openMicrophoneSettings: () => ipcRenderer.invoke('hearalong:microphone-settings'),
  }));
}
