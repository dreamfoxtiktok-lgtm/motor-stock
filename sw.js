const CACHE_NAME = 'motor-stock-v6';   // ⚠ INCREMENTAR a cada novo deploy
const ASSETS = [
  '/index.html',
  '/manifest.json',
  '/lib/chart.umd.min.js',
  '/lib/xlsx.full.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  // só cacheia GET; POST (Functions) nunca vai pro cache
  if (request.method !== 'GET') return;
  // NÃO cachear chamadas às Functions nem ao Firebase — sempre rede
  if (request.url.includes('/api/') ||
      request.url.includes('firestore.googleapis.com') ||
      request.url.includes('firebaseio.com') ||
      request.url.includes('googleapis.com')) {
    return; // deixa passar direto pra rede
  }
  // demais recursos: cache primeiro, rede como fallback
  e.respondWith(caches.match(request).then(r => r || fetch(request)));
});
