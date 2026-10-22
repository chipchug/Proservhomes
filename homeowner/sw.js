const CACHE = 'proserv-hw-v1';
const SHELL = ['/homeowner/', '/homeowner/index.html', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Only cache same-origin non-API requests (skip Supabase / external calls)
  const url = e.request.url;
  const isExternal = !url.startsWith(self.location.origin);
  const isApi = url.includes('/rest/v1/') || url.includes('/auth/v1/') || url.includes('/functions/v1/') || url.includes('/storage/v1/');
  if (isExternal || isApi) return; // let the browser handle it normally
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
