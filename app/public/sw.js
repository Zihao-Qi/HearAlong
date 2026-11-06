// The installed app (M7): when the window opens and the local server is not running yet, show "Starting…" (which asks the helper
// to start it) instead of Chrome's error page. Everything else goes to the server as usual; nothing of the app is cached.
// The packaged server embeds a self-contained migration page here. A changed sw.js
// replaces starting-v2 through the normal update check, even with an existing registration.
const OFFLINE_PAGE = '';
const CACHE = 'starting-v2';
self.addEventListener('install', event => {
  if (OFFLINE_PAGE) { event.waitUntil(self.skipWaiting()); return; }
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/starting.html', '/starting.css', '/starting.js', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => OFFLINE_PAGE || k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () => OFFLINE_PAGE
    ? new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
    : (await caches.match('/starting.html')) ?? Response.error()));
});
// The Starting page's own files come from the cache when the server is down.
self.addEventListener('fetch', event => {
  const path = new URL(event.request.url).pathname;
  if (OFFLINE_PAGE || event.request.mode === 'navigate' || !['/starting.css', '/starting.js'].includes(path)) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(path)) ?? Response.error()));
});
