/* Network-first for this site's own files (each cached individually, versioned cache name);
   cache-first for the pinned, immutable DuckDB-WASM files on jsDelivr so DuckDB also works offline.
   AI provider traffic and anything else cross-origin is never touched. */
const VERSION = 'askdata-v1';
const CDN = 'askdata-cdn-v1';
const FILES = ['./', './index.html', './styles.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './js/app.js', './js/llm.js', './js/data.js', './js/sqlguard.js', './js/nl.js', './js/chart.js', './js/agent.js', './js/report.js', './js/engine.js', './js/store.js', './js/webllm.js',
  './vendor/sqljs/sql-wasm.js', './vendor/sqljs/sql-wasm.wasm', './vendor/duckdb/duckdb-browser-eh.worker.js', './vendor/duckdb/duckdb-browser-mvp.worker.js',
  './samples/orders.csv', './samples/customers.csv', './samples/products.csv', './samples/saas_metrics.csv'];
const CDN_RE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+[a-z0-9.+-]*\//i; // exact-version URLs only (immutable)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    for (const file of FILES) { try { const res = await fetch(file, { cache: 'reload' }); if (res.ok) await cache.put(file, res); } catch (e) { /* one missing file must not break install */ } }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => { for (const k of await caches.keys()) if ((k.startsWith('askdata-v') && k !== VERSION) || (k.startsWith('askdata-cdn-') && k !== CDN)) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_RE.test(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (res.type === 'cors' || res.type === 'basic')) { try { await cache.put(req.url, res.clone()); } catch (e) { /* quota */ } }
      return res;
    })());
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try { const res = await fetch(req); if (res.ok && res.type === 'basic') await cache.put(req, res.clone()); return res; }
    catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return new Response('Offline: resource not cached', { status: 503, statusText: 'Offline' });
    }
  })());
});
