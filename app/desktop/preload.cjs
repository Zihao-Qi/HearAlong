'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const origin = process.argv.find(arg => arg.startsWith('--hearalong-origin='))?.slice('--hearalong-origin='.length);
if (process.isMainFrame && location.origin === origin) {
  contextBridge.exposeInMainWorld('hearalong', Object.freeze({
    desktop: true,
    activate: () => ipcRenderer.send('hearalong:activate'),
    microphoneStatus: () => ipcRenderer.invoke('hearalong:microphone-status'),
    allowMicrophone: () => ipcRenderer.invoke('hearalong:allow-microphone'),
    openMicrophoneSettings: () => ipcRenderer.invoke('hearalong:microphone-settings'),
  }));
}
