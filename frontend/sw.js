// Service Worker pour Patrimoine Crypto
// Stratégie : cache-first pour les ressources statiques, network-first pour les API
const CACHE_NAME = 'patrimoine-crypto-v3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Pour les API (CoinGecko, alternative.me) : network-first avec fallback cache
  if (url.hostname.includes('coingecko') || url.hostname.includes('alternative.me') || url.hostname.includes('cryptopanic')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          // Cache la réponse pour fallback
          const respClone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Pour le reste : cache-first
  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});
