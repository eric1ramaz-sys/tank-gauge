const CACHE_NAME = 'tank-gauge-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=3',
  './engine.js?v=3',
  './vision.js?v=3',
  './weather.js?v=3',
  './charts.js?v=3',
  './app.js?v=3',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './qr_tank_gauge.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        ASSETS.map(asset =>
          fetch(new Request(asset, { cache: 'reload' })).then(resp => {
            if (resp && resp.ok) return cache.put(asset, resp);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Never hijack external API calls (Open-Meteo, postcodes.io, Gemini)
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(new Request(event.request.url, { cache: 'no-cache' }))
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('./index.html', clone));
          return response;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
