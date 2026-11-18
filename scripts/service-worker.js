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
const APP_PAGES = new Set(['/index.html', '/office.html', '/embed.html']);

function appPage(href) {
  const url = new URL(href);
  const page = url.pathname === '/' ? '/index.html' : url.pathname;
  return url.origin === self.location.origin && APP_PAGES.has(page) ? page : null;
}

async function install() {
  // The first navigation takes place before a service worker controls the page.
  const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  const pages = new Set(windows.map(client => appPage(client.url)).filter(Boolean));
  if (pages.has('/index.html')) pages.add('/embed.html');
  const cache = await caches.open(CACHE);
  const requests = [...PRECACHE, ...pages].map(
    path => new Request(new URL(path, self.location.href), {redirect: 'error'})
  );
  await cache.addAll(requests);
  await self.skipWaiting();
}

self.addEventListener('install', event => event.waitUntil(install()));

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
async function fetchAndRemember(request, key = request) {
  const response = await fetch(request);
  if (key && response.ok && response.type === 'basic' && !response.redirected) {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(key, response.clone());
    } catch {
      // A full or unavailable cache must still allow the online response through.
    }
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;

  if (request.mode === 'navigate') {
    const page = appPage(request.url);
    event.respondWith(
      fetchAndRemember(request, page).catch(async () => (page && (await caches.match(page))) || caches.match(OFFLINE))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then(hit => hit || fetchAndRemember(request)));
    return;
  }

  // Icons, the manifest and other small files: answer from the cache, refresh behind it.
  const refresh = fetchAndRemember(request);
  event.waitUntil(refresh.catch(() => {}));
  event.respondWith(caches.match(request).then(hit => hit || refresh));
});
