// DART Meadow Space — Service Worker
// Enables PWA installability and basic offline shell caching
const CACHE = 'dm-space-v1';
const SHELL = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // For the shell itself serve from cache; everything else passthrough
  if(e.request.mode === 'navigate'){
    e.respondWith(
      caches.match('/').then(r => r || fetch(e.request))
    );
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
