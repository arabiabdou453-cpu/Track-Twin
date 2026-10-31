// Keeps the citizen app's page available offline, so the call button still works without data.
const CACHE = 'report-v4';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/app', '/css/witness.css', '/app.webmanifest', '/mark.png']))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  const path = new URL(e.request.url).pathname;
  if (e.request.method !== 'GET' || !['/app', '/css/witness.css'].includes(path)) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(path)));
});
