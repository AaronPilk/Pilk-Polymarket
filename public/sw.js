// Offline shell for the home-screen app. Data comes from the network;
// the app keeps its own copy of the last sync, so the shell is all we cache.
const CACHE = 'pilk-bets-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/analytics.js', '/manifest.webmanifest', '/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;
  // Network first so new deploys land right away; cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && !res.redirected && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
