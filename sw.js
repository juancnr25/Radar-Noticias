/* Radar · service worker. Sube CACHE_VERSION en cada cambio de la app. */
const CACHE_VERSION = 'radar-v1.1.2';
const SHELL = `${CACHE_VERSION}-shell`;
const DATOS = 'radar-datos';
const IMAGENES = 'radar-img';
const MAX_IMAGENES = 160;

const ARCHIVOS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'vendor/Readability.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.endsWith('-shell') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

async function recortarCache(nombre, max) {
  const c = await caches.open(nombre);
  const claves = await c.keys();
  for (let i = 0; i < claves.length - max; i++) await c.delete(claves[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Noticias: red primero, caché de respaldo
  if (url.pathname.endsWith('/data/noticias.json')) {
    e.respondWith((async () => {
      const clave = url.origin + url.pathname;
      try {
        const r = await fetch(req, { cache: 'no-store' });
        if (r.ok) (await caches.open(DATOS)).put(clave, r.clone());
        return r;
      } catch {
        const c = await caches.match(clave);
        return c || new Response('{"items":[]}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Imágenes externas: caché primero (para leer sin conexión)
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(IMAGENES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); recortarCache(IMAGENES, MAX_IMAGENES); }
        return r;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // App: caché primero, actualiza en segundo plano
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req, { ignoreSearch: true });
      const red = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) { e.waitUntil(red); return hit; }
      const r = await red;
      if (r) return r;
      if (req.mode === 'navigate') return c.match('index.html');
      return new Response('', { status: 504 });
    })());
  }
});
