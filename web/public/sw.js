// Kosh service worker: makes the app open instantly and work offline.
// - Built assets (/assets/*) have hashed names, so they're cached forever.
// - Pages are fetched fresh when online, with the cached app shell as fallback.
// - API calls always go to the network; the app keeps its own data cache.
// - /auth/* (Google sign-in) redirects to other sites, so it's left alone too.
// - Push messages are vehicle reminders; tapping one opens the screen it's about.
const CACHE = 'kosh-v3'
// Papers kept for offline use (see src/lib/offline.ts); never cleared here.
const PAPERS = 'kosh-papers'
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== PAPERS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/_jobs/') || url.pathname === '/healthz') return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy))
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
    return
  }

  // Everything else (icons, manifest): serve cached, refresh in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
      return hit || fresh
    }),
  )
})

// ---- Reminders ----

self.addEventListener('push', (event) => {
  let n = { title: 'Kosh', body: '', url: '/due', tag: 'kosh' }
  try {
    n = { ...n, ...event.data.json() }
  } catch {}
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: n.url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          return w.focus().then((f) => (f && 'navigate' in f ? f.navigate(url) : undefined))
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
