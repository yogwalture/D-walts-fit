/**
 * The member app's service worker.
 *
 * Deliberately modest. It caches the shell so the app opens on a bad
 * connection in a basement gym, and it does NOT cache anything from the
 * API: a cached membership expiry, or a class shown as having places when
 * it filled an hour ago, is worse than a spinner. Everything under /api
 * goes to the network or fails honestly.
 */
const SHELL = 'gym-shell-v1';
const SHELL_URLS = ['/my', '/my/classes', '/my/visits', '/my/payments', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve a stale answer about somebody's membership or a class with
  // places left. Those go to the network, and say so when they cannot.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && url.pathname.startsWith('/my')) {
          const copy = response.clone();
          caches
            .open(SHELL)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const offline = await caches.match('/offline');
        return offline ?? new Response('Offline', { status: 503 });
      }),
  );
});
