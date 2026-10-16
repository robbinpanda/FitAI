"use strict";
// Network-first shell cache: always try the server so deploys show up at once,
// fall back to the last copy only when offline. API responses are never cached.
const CACHE = 'jjf-shell-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match(request, {ignoreSearch: request.mode === 'navigate'}).then(hit => hit || new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>离线</title>'
    + '<p style="font:16px/1.7 sans-serif;padding:40px 24px;text-align:center">当前没有网络连接。<br>联网后刷新即可继续记录。</p>',
    {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}}))));
});
