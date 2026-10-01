// DART Meadow service worker — the DART Engine's delivery layer.
//
// Every trip across the network costs time, so each kind of file takes the
// shortest safe path:
//   • versioned or immutable files (ui/*.js?v=…, pinned CDN builds such as
//     three@0.185.0, fonts) never change under the same address: they come
//     straight from the device after the first download (cache-first);
//   • the game's own unversioned assets (models, images, scripts without a
//     version) load from the device at once and are refreshed in the
//     background for next time (stale-while-revalidate), so an update still
//     arrives without ever making the player wait for it;
//   • the page itself and anything live (GitHub, sign-in, payments, APIs)
//     always goes to the network first, so saves and updates are never stale;
//   • audio/video streams (range requests) pass straight through.
// It also keeps the app installable and playable offline once visited.

const CACHE_NAME = 'dartmeadow-engine-v7';
const SHELL_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const LIVE = /api\.github\.com|githubusercontent\.com\/.*\/(contents|git)|firebase|googleapis\.com\/(identitytoolkit|securetoken)|script\.google\.com|stripe\.com|allorigins/;
const IMMUTABLE = /[?&]v=\d|@\d+\.\d+\.\d+|fonts\.gstatic\.com|\/static\/fonts\//;
const ASSET = /\.(glb|gltf|png|jpe?g|webp|svg|ico|js|css|json|woff2?|ttf|wasm|bin|ktx2)(\?|$)/i;

function put(req, res) {
  if (res && (res.ok || res.type === 'opaque') && res.status !== 206) {
    const copy = res.clone();
    caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range') || req.destination === 'video' || req.destination === 'audio') return;   // streams
  const url = req.url;
  if (LIVE.test(url)) return;   // live data: straight to the network, never cached here

  // the page: network first, the cached shell offline
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((r) => put(req, r)).catch(() => caches.match(req).then((c) => c || caches.match('/index.html'))));
    return;
  }
  // immutable: device first
  if (IMMUTABLE.test(url)) {
    event.respondWith(caches.match(req).then((c) => c || fetch(req).then((r) => put(req, r))));
    return;
  }
  // our own assets: device now, refreshed in the background
  if (ASSET.test(url)) {
    event.respondWith(caches.match(req).then((c) => {
      const net = fetch(req).then((r) => put(req, r)).catch(() => c || Response.error());
      if (c) { event.waitUntil(net.catch(() => {})); return c; }
      return net;
    }));
    return;
  }
  // everything else: network first, cache as a fallback
  event.respondWith(fetch(req).then((r) => put(req, r)).catch(() => caches.match(req).then((c) => c || Response.error())));
});
