// These constants are injected from the production output, never from API responses.
const precache: string[] = /* EKO_PRECACHE */ [];
const shell: string[] = /* EKO_SHELL */ [];
const cacheName = `eko-pwa-${/* EKO_VERSION */ 'development'}`;
type WorkerEvent = { waitUntil(work: Promise<unknown>): void; request: Request; respondWith(response: Promise<Response>): void };
const worker = globalThis as unknown as {
  location: Location;
  clients: { claim(): Promise<void> };
  addEventListener(type: string, callback: (event: WorkerEvent) => void): void;
};
const assetUrls = new Set(shell.map(file => new URL(file, worker.location.origin).href));
const isAsset = (url: string) => assetUrls.has(url);

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    for (const file of precache) {
      const request = new Request(new URL(file, worker.location.origin), { cache: 'reload', credentials: 'omit' });
      const response = await fetch(request);
      if (!response.ok || response.redirected) throw new Error('Shell asset unavailable');
      await cache.put(request, response);
    }
  })());
  // Leave updates waiting until existing clients close; never reload a signing flow.
});
worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('eko-pwa-') && name !== cacheName) await caches.delete(name);
    }
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) if (!isAsset(request.url)) await cache.delete(request);
    await worker.clients.claim();
  })());
});
worker.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // A closed asset allowlist keeps /v1, legacy APIs, OG images and all mutations
  // network-only, including cross-origin requests and old poisoned cache entries.
  if (request.method !== 'GET' || url.origin !== worker.location.origin ||
      /^(?:\/v1|\/v2|\/api)(?:\/|$)/.test(url.pathname) ||
      /(?:^|\/)og(?:\/|$)|\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname) && !isAsset(url.href)) {
    event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
    return;
  }
  if (isAsset(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(new Request(request, { cache: 'reload', credentials: 'omit' }));
      if (response.ok && !response.redirected) await cache.put(request, response.clone());
      return response;
    })());
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(new Request(request, { cache: 'no-store' })); }
      catch {
        const cache = await caches.open(cacheName);
        const response = await cache.match(new URL('/index.html', worker.location.origin).href);
        if (response) return response;
        return new Response('You\'re offline. Approvals need a connection.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
});
