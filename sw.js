/* Кэш оболочки приложения: работает без интернета, кроме подписи через sigex.kz и связи с сервером журнала */
const CACHE = 'instr-v0.3';
const FILES = ['./', 'index.html', 'app.js', 'sigex.js', 'ezhi.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // API сервера, журнал и администрирование не кэшируются (когда приложение раздает сам сервер журнала)
  const rel = u.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (/^(api|journal|admin)(\/|$)/.test(rel)) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
