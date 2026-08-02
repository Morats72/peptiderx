// PeptideRx Service Worker
// Handles caching for offline use + push notification scheduling

const CACHE = 'peptiderx-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];

// ── Install: cache all assets ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ──
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push: show notification ──
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'PeptideRx';
  const options = {
    body: data.body || 'Time for your dose.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'peptiderx-dose',
    data: { url: data.url || './' },
    actions: [
      { action: 'log', title: '✓ Log Dose' },
      { action: 'snooze', title: '⏰ Snooze 15 min' }
    ],
    requireInteraction: true,
    vibrate: [200, 100, 200]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'snooze') {
    // Re-schedule for 15 min — send message to client
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        const msg = { type: 'SNOOZE', tag: e.notification.tag, minutes: 15 };
        clients.forEach(c => c.postMessage(msg));
        if (clients.length === 0) {
          return self.clients.openWindow('./?snooze=' + e.notification.tag);
        }
      })
    );
  } else {
    // Open app and focus
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        const existing = clients.find(c => c.url.includes(self.location.origin));
        if (existing) return existing.focus();
        return self.clients.openWindow('./');
      })
    );
  }
});

// ── Message from app (schedule local alarm) ──
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SCHEDULE_CHECK') {
    // Client is asking SW to ping back at the right time
    // We use the client-side setTimeout approach for local notifications
    // since Web Push requires a server for true push
    console.log('[SW] Schedule check received');
  }
});
