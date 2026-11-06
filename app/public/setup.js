import { SetupUI, setupRequest } from '/setup-ui.js';
import { startPageSession, endPageSession } from '/page-session.js';

startPageSession();

if (!window.hearalong?.desktop) navigator.serviceWorker?.register('/sw.js').catch(() => {});
const open = document.getElementById('open-app'), error = document.getElementById('setup-error');
const upgrade = !window.hearalong?.desktop && document.documentElement.dataset.chromeUpgrade;
const showError = e => {
  error.hidden = !e && !upgrade;
  error.textContent = e?.message.replace(/'/g, '’') ?? (upgrade || '');
  if (upgrade) error.setAttribute('role', e ? 'alert' : 'status');
};
if (upgrade) showError(null);
const ui = new SetupUI(document.getElementById('setup-rows'), {
  onStatus(status) {
    const speech = status.rows.find(r => r.id === 'speech');
    open.disabled = speech.state !== 'ready' || !!speech.pending;
  },
  onError: showError,
});
open.onclick = async () => {
  open.disabled = true;
  try {
    await setupRequest('/api/setup/seen', 'POST'); ui.stop({ dispose: true });
    await endPageSession(); location.assign('/');
  } catch (e) { startPageSession(); await ui.start(); showError(e); }
};
window.addEventListener('pagehide', () => ui.stop({ dispose: true }));
window.addEventListener('pageshow', () => { if (!ui.active) void ui.start(); });
void ui.start();
