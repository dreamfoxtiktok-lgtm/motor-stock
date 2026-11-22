const CACHE_NAME = 'motor-stock-v25';  // ⚠ INCREMENTAR a cada novo deploy
const ASSETS = [
  '/index.html',
  '/manifest.json',
  '/lib/chart.umd.min.js',
  '/lib/exceljs.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/inter-latin.woff2',
  '/fonts/inter-latin-ext.woff2',
  '/fonts/sharetechmono-latin.woff2',
  '/vendor/firebase/firebase-app.js',
  '/vendor/firebase/firebase-firestore.js',
  '/vendor/firebase/firebase-auth.js'
];

self.addEventListener('install', e => {
  // Instalação TOLERANTE: um arquivo que falhe (404/rede) não derruba o SW
  // inteiro (addAll é atômico; allSettled cacheia o que der certo).
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => Promise.allSettled(ASSETS.map(u => c.add(u))))
  );
  // NÃO chama skipWaiting aqui: o SW novo fica em "waiting" para o app avisar o
  // usuário ("nova versão disponível") e só assumir quando ele tocar em Atualizar.
});

// O app pede a troca (postMessage 'SKIP_WAITING') quando o usuário aceita atualizar.
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  // só cacheia GET; POST (Functions) nunca vai pro cache
  if (request.method !== 'GET') return;
  // NÃO cachear chamadas às Functions nem ao Firebase — sempre rede
  if (request.url.includes('/api/') ||
      request.url.includes('gstatic.com') ||          // SDK do Firebase: vai DIRETO à rede (o SW interceptando causava 503)
      request.url.includes('firestore.googleapis.com') ||
      request.url.includes('firebaseio.com') ||
      request.url.includes('googleapis.com')) {
    return; // deixa passar direto pra rede
  }

  // NAVEGAÇÃO (abrir o app — inclusive o PWA INSTALADO): tenta a rede para
  // pegar a versão mais nova; se a rede falhar (offline/instável), entrega a
  // tela inicial em cache. Isso evita o erro "Não é possível acessar esse site"
  // quando o app instalado é aberto sem rede ou com conexão instável.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then(r => r || caches.match(request))
      )
    );
    return;
  }

  // demais recursos: cache primeiro, rede como fallback
  e.respondWith(caches.match(request).then(r => r || fetch(request)));
});
