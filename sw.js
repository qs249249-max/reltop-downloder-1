/* =====================================================
   RELTOP DOWNLOADER — Service Worker
   Minimal app-shell caching so the UI can install and open
   offline. Deliberately does NOT cache /api/* calls or any
   downloaded video/audio files — those are always dynamic
   and must hit the network.
   ===================================================== */

const CACHE_VERSION = 'reltop-shell-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle simple same-origin GET requests; let everything else
  // (API calls, file downloads, cross-origin fonts/CDN scripts) go straight
  // to the network untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache

      // Cache-first for instant loads, refreshed in the background.
      return cached || networkFetch;
    })
  );
});
