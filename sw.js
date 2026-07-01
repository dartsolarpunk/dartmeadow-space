// DART Meadow service worker
// Minimal by design: this exists primarily to satisfy browser installability
// criteria (Chrome requires an active service worker with a fetch handler to
// offer a real "Install app" / WebAPK instead of falling back to a plain
// bookmark shortcut). It also gives basic offline-shell caching for the app
// icon/shell so a re-launch after install doesn't need network first.

const CACHE_NAME = 'dartmeadow-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for everything, falling back to cache (and then to the
// cached shell) if offline. Deliberately simple — the game is asset-heavy
// (GLB models, audio) and we don't want to aggressively cache those and
// risk serving stale versions after an update.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match('/index.html'))
      )
  );
});
