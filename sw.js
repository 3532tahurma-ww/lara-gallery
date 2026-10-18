// Bump VERSION on every deploy so clients pick up the new app shell.
const VERSION = 'v7';
const SHELL_CACHE = `lg-shell-${VERSION}`;
const RUNTIME_CACHE = 'lg-runtime';
const IMG_CACHE = 'lg-images';
const SHARE_CACHE = 'lg-share';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE, IMG_CACHE, SHARE_CACHE];
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(req));
    return;
  }
  // The local dev server's mock API must always hit the network.
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Photos are stored under unique names, so a cached copy never goes stale.
  const isLocalPhoto = url.origin === location.origin && url.pathname.includes('/photos/');
  if (url.hostname.endsWith('githubusercontent.com') || isLocalPhoto) {
    e.respondWith(cacheFirst(req, IMG_CACHE));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
  } else if (url.origin === location.origin) {
    e.respondWith(req.mode === 'navigate' ? networkFirst(req) : staleWhileRevalidate(req, SHELL_CACHE));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch {
    return (await cache.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || network;
}

// Android "Share → Lara Gallery": stash files, then let the page upload them.
async function handleShare(req) {
  const form = await req.formData();
  const files = form.getAll('photos').filter((f) => f instanceof File);
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all(files.map((f, i) => cache.put(
    `./__shared/${i}`,
    new Response(f, { headers: { 'content-type': f.type, 'x-name': encodeURIComponent(f.name) } })
  )));
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
