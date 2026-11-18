// Agent Office service worker. scripts/build.mjs fills in the version and precache list
// and publishes this file as /sw.js; the development server never registers it.
//
// - Hash-named files under /assets/ never change, so they are served from the cache.
// - Pages come from the network whenever it is reachable, so sign-in and office data are
//   exactly as fresh as on the website. Offline, the last copy (or a notice) is shown.
// - API and MCP traffic is never cached.
const VERSION = '__VERSION__';
const CACHE = 'agent-office-' + VERSION;
const PRECACHE = __PRECACHE__;
const OFFLINE = './offline.html';

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key.startsWith('agent-office-') && key !== CACHE).map(key => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Only plain same-origin successes are kept: never a sign-in redirect or an error page.
const keepable = response => response && response.ok && response.type === 'basic' && !response.redirected;
function remember(request, response) {
  if (!keepable(response)) return;
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy));
}

self.addEventListener('fetch', event => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          remember(request, response);
          return response;
        })
        .catch(async () => (await caches.match(request, {ignoreSearch: true})) || caches.match(OFFLINE))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        hit =>
          hit ||
          fetch(request).then(response => {
            remember(request, response);
            return response;
          })
      )
    );
    return;
  }

  // Icons, the manifest and other small files: answer from the cache, refresh behind it.
  event.respondWith(
    caches.match(request).then(hit => {
      const refresh = fetch(request)
        .then(response => {
          remember(request, response);
          return response;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
