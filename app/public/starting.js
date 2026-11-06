// Development-only offline page. Wait for a manually started server; never launch a removed helper.
const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry');
let timer;
function stopTimers() { clearInterval(timer); }
function start() {
  stopTimers();
  title.textContent = 'HearAlong server is not running';
  detail.textContent = 'Start it with npm start from the app folder, then try again.';
  retry.hidden = true;
  const until = Date.now() + 60_000;
  timer = setInterval(async () => {
    if (Date.now() > until) {
      stopTimers();
      retry.hidden = false;
      retry.focus(); return;
    }
    try { if ((await fetch('/', { cache: 'no-store' })).ok) { stopTimers(); location.replace('/'); } } catch { /* not up yet */ }
  }, 1000);
}
retry.onclick = start;
window.addEventListener('pagehide', stopTimers);
start();
