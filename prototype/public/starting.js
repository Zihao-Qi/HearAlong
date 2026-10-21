// Shown by the service worker when the local server is not running. Asks the helper app to start it (macOS opens the helper for
// meetingassistant:// links; Chrome asks once whether to allow that), then loads the app as soon as the server answers.
const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry');
let timer;
function start() {
  clearInterval(timer);
  title.textContent = 'Starting HearAlong…';
  detail.textContent = 'This takes a few seconds. If Chrome asks whether to open HearAlong Helper, allow it (tick “Always allow” to skip this next time).';
  retry.hidden = true;
  location.href = 'meetingassistant://start';
  const until = Date.now() + 60_000;
  timer = setInterval(async () => {
    try { if ((await fetch('/', { cache: 'no-store' })).ok) { clearInterval(timer); location.replace('/'); return; } } catch { /* not up yet */ }
    if (Date.now() > until) {
      clearInterval(timer);
      title.textContent = 'HearAlong did not start';
      detail.innerHTML = 'Open <code>HearAlong Helper</code> from <code>prototype/dist</code>, or run <code>npm start</code> in <code>prototype</code>, then try again. Its log is <code>prototype/data/logs/launcher.log</code>.';
      retry.hidden = false;
      retry.focus();
    }
  }, 1000);
}
retry.onclick = start;
start();
