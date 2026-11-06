'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const origin = process.argv.find(arg => arg.startsWith('--hearalong-origin='))?.slice('--hearalong-origin='.length);
const starting = process.argv.find(arg => arg.startsWith('--hearalong-starting='))?.slice('--hearalong-starting='.length);
if (process.isMainFrame && location.href === starting) {
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
