/* Moa service worker — app shell offline cache.
   Photos are cached by the app itself (Cache Storage "moa-media-v1");
   GitHub API calls are never intercepted here. */
const CACHE = 'moa-shell-v17';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/core.js',
  './js/github.js',
  './js/crypto.js',
  './js/queue.js',
  './js/zip.js',
  './js/whatsnew.js',
  './js/ai.js',
  './js/ai-labels.js',
  './js/media.js',
  './js/geo.js',
  './js/limits.js',
  './js/i18n.js',
  './js/strings.js',
  './vendor/pretendard/pretendardvariable-dynamic-subset.css',
  './vendor/exifr.umd.js',
  './vendor/leaflet/leaflet.js',
  './vendor/qrcode/qrcode.js',
  './vendor/leaflet/leaflet.css',
  './icons/icon.svg',
  './icons/tiles.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never picks up an old file
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('moa-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin only. Pages: network-first (deploys show immediately).
// Assets: cache-first with background refresh.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.includes('/vendor/transformers/') || url.pathname.endsWith('/ai-worker.js')) return; // AI files: only when turned on, straight from the network/HTTP cache

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});

// a "finished" notification: bring Moa back to the front
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
