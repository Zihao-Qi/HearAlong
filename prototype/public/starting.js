// Shown by the service worker when the local server is not running. Asks the helper app to start it (macOS opens the helper for
// meetingassistant:// links; Chrome asks once whether to allow that), then loads the app as soon as the server answers.
const title = document.getElementById('title'), detail = document.getElementById('detail'), retry = document.getElementById('retry');
let timer, launchTimer;
function stop() { clearInterval(timer); clearInterval(launchTimer); }
function start() {
  stop();
  title.textContent = 'Starting HearAlong…';
  detail.textContent = 'This takes a few seconds. If Chrome asks whether to open HearAlong Helper, allow it (tick “Always allow” to skip this next time).';
  retry.hidden = true;
  const until = Date.now() + 60_000;
  const launch = () => { if (Date.now() < until) location.href = 'meetingassistant://start'; };
  launch();
  // A restarting helper may still be quitting when the first request arrives. Once it exits, a later request launches anew.
  launchTimer = setInterval(launch, 3000);
  timer = setInterval(async () => {
    if (Date.now() > until) {
      stop();
      title.textContent = 'HearAlong did not start';
      detail.innerHTML = 'Open <code>HearAlong Helper</code> from <code>prototype/dist</code>, or run <code>npm start</code> in <code>prototype</code>, then try again. Its log is <code>prototype/data/logs/launcher.log</code>.';
      retry.hidden = false;
      retry.focus(); return;
    }
    try { if ((await fetch('/', { cache: 'no-store' })).ok) { stop(); location.replace('/'); } } catch { /* not up yet */ }
  }, 1000);
}
retry.onclick = start;
window.addEventListener('pagehide', stop);
start();
