// Service Worker: アプリ本体をキャッシュしてオフライン起動を可能にする。
// 更新時は CACHE のバージョンを上げる。
const CACHE = 'pocket-eda-v0.3.2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/core/project.js',
  './js/core/storage.js',
  './js/core/autosave.js',
  './js/core/events.js',
  './js/modules/registry.js',
  './js/ui/viewport.js',
  './js/core/history.js',
  './js/schematic/geom.js',
  './js/schematic/symbols.js',
  './js/schematic/connectivity.js',
  './js/schematic/model.js',
  './js/schematic/render.js',
  './js/schematic/editor.js',
  './js/library/footprints.js',
  './js/library/parts.js',
  './js/library/importer.js',
  './js/library/library.js',
  './js/library/view.js',
  './js/library/jlcsearch.js',
  './js/netlist/netlist.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('pocket-eda-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 同一オリジンのGETはキャッシュ優先（無ければネットから取得してキャッシュ）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      throw err;
    }
  })());
});
