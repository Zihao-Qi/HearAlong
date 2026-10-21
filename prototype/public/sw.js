// The installed app (M7): when the window opens and the local server is not running yet, show "Starting…" (which asks the helper
// to start it) instead of Chrome's error page. Everything else goes to the server as usual; nothing of the app is cached.
const CACHE = 'starting-v2';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/starting.html', '/starting.css', '/starting.js', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match('/starting.html')) ?? Response.error()));
});
// The Starting page's own files come from the cache when the server is down.
self.addEventListener('fetch', event => {
  const path = new URL(event.request.url).pathname;
  if (event.request.mode === 'navigate' || !['/starting.css', '/starting.js'].includes(path)) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(path)) ?? Response.error()));
});
