/* Service worker HiraKana Mastery Kayuki.
   Ganti angka VERSI kalau mau memaksa semua perangkat mengambil file baru. */
const VERSI = 'hirakana-v8';
const INTI = [
  './', 'index.html', 'manifest.webmanifest',
  'fonts/gothic.woff2', 'fonts/mincho.woff2', 'fonts/kyokasho.woff2', 'fonts/tangan.woff2', 'fonts/kuas.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'kayuki-config.js', 'kayuki-sync.js'            /* file portal; dilewati kalau belum ada di folder ini */
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSI)
      .then(c => Promise.allSettled(INTI.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('hirakana-') && k !== VERSI).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache dulu (cepat dan jalan offline), lalu diam-diam perbarui dari internet kalau ada.
   Permintaan ke domain lain (misal database portal) tidak disentuh. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSI).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') {
        const home = await cache.match('index.html');
        if (home) return home;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
