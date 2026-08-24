// PeptideRx Service Worker
// Handles caching for offline use + push notification scheduling

// v4: nutrition reminders. The cache name MUST change or installed phones keep
// running the old worker and never pick up the new push handler.
const CACHE = 'peptiderx-v4';
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

// ── Fetch: network-first, cache as offline fallback ──
// Cache-first was serving stale index.html/JS forever after the first
// load — a new deploy on GitHub Pages was invisible to the installed
// app until the cache was manually cleared. Network-first means every
// load checks for the latest version first; the cache only kicks in
// when there's no connection.
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only GETs with a real response are cacheable. cache.put() throws on
        // POST ("Request method 'POST' is unsupported"), and every POST we make
        // — push subscribe, schedule sync, reminder sync, Open Food Facts —
        // was raising an unhandled rejection here. Harmless but noisy, and it
        // buried real errors in the console.
        if (e.request.method === 'GET' && res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE)
            .then(cache => cache.put(e.request, resClone))
            .catch(() => { /* opaque/uncacheable response — skip it */ });
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ══════════════════════════════════════════════════════════════════════
// Nutrition reminders — the numbers are composed HERE, on the phone
// ══════════════════════════════════════════════════════════════════════
// The push server never learns what you ate. It sends a contentless
// {kind:'nutrition', type:'water'|'macro'|'endofday'} trigger; this worker
// reads today's totals out of IndexedDB on this device and writes the
// notification text itself. Nothing about your food log leaves the phone,
// and the numbers are true as of the moment the notification fires.

function readTodaySnapshot() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Never let a wedged database hang the push event. iOS shows a useless
    // "site was updated in the background" notice if this handler stalls.
    setTimeout(() => done(null), 1500);
    try {
      const req = indexedDB.open('peptiderx', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('today')) db.createObjectStore('today');
      };
      req.onerror = () => done(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction('today', 'readonly');
          const get = tx.objectStore('today').get('snapshot');
          get.onsuccess = () => { done(get.result || null); db.close(); };
          get.onerror = () => { done(null); db.close(); };
        } catch (err) { done(null); }
      };
    } catch (err) { done(null); }
  });
}

function localDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hhmmToMin(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function n1(x) { return Math.round(x * 10) / 10; }

// Returns { title, body, quiet }. `quiet` means show it silently rather than
// buzz — used when the goal is already met. It can't return nothing at all: a
// push that shows no notification makes the browser post its own junk notice.
function buildNutritionNotification(type, snap) {
  const stale = !snap || snap.date !== localDateStr();

  if (type === 'water') {
    if (stale) return { title: 'Water check', body: 'Nothing logged yet today — start with a glass.', quiet: false };
    const goal = snap.goals.water || 0, have = snap.totals.water || 0, unit = snap.goals.waterUnit || 'oz';
    if (!goal) return { title: 'Water check', body: have + unit + ' logged today', quiet: false };
    if (have >= goal) return { title: 'Water goal hit', body: have + ' of ' + goal + unit + " — you're good", quiet: true };
    // Pace against the window so the goal lands by its end time, not midnight.
    const start = hhmmToMin((snap.water || {}).startTime), end = hhmmToMin((snap.water || {}).endTime);
    const d = new Date(), nowMin = d.getHours() * 60 + d.getMinutes();
    let behind = '';
    if (start !== null && end !== null && end > start && nowMin > start) {
      const expected = Math.round(goal * Math.min(1, (nowMin - start) / (end - start)));
      if (have < expected - 1) behind = ' · ' + (expected - have) + unit + ' behind pace';
    }
    return { title: 'Water check', body: have + ' of ' + goal + unit + behind, quiet: false };
  }

  if (type === 'macro') {
    if (stale) return { title: 'Protein check', body: 'Nothing logged yet today', quiet: false };
    const goal = snap.goals.protein || 0, have = snap.totals.protein || 0;
    if (!goal) return { title: 'Protein check', body: n1(have) + 'g so far today', quiet: false };
    if (have >= goal) return { title: 'Protein goal hit', body: n1(have) + ' of ' + goal + 'g — done', quiet: true };
    return { title: 'Protein check', body: n1(have) + ' of ' + goal + 'g', quiet: false };
  }

  if (type === 'endofday') {
    if (stale) return { title: 'End of day', body: 'Nothing logged today', quiet: false };
    const short = [];
    const g = snap.goals, t = snap.totals;
    if (g.protein && t.protein < g.protein) short.push('Protein ' + n1(t.protein) + '/' + g.protein + 'g');
    if (g.cal && t.cal < g.cal) short.push('Calories ' + t.cal + '/' + g.cal);
    if (g.carbs && t.carbs < g.carbs) short.push('Carbs ' + n1(t.carbs) + '/' + g.carbs + 'g');
    if (g.fat && t.fat < g.fat) short.push('Fat ' + n1(t.fat) + '/' + g.fat + 'g');
    if (g.water && t.water < g.water) short.push('Water ' + t.water + '/' + g.water + (g.waterUnit || 'oz'));
    if (!short.length) return { title: 'All goals hit', body: 'Good day. Nothing short.', quiet: true };
    return { title: 'End of day', body: short.join(' · '), quiet: false };
  }
  return null;
}

// ── Push: show notification ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = {}; }

  // Nutrition reminder: compose the text from this phone's own numbers.
  if (data && data.kind === 'nutrition') {
    e.waitUntil((async () => {
      let n;
      try {
        const snap = await readTodaySnapshot();
        n = buildNutritionNotification(data.type, snap);
      } catch (err) { n = null; }
      if (!n) n = { title: 'PeptideRx', body: 'Tap to check in on your day', quiet: false };
      return self.registration.showNotification(n.title, {
        body: n.body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: data.tag || ('peptiderx-nutrition-' + (data.type || 'x')),
        data: { url: './', kind: 'nutrition', type: data.type },
        // Deliberately lighter-touch than a dose: no requireInteraction, no
        // action buttons. A water nudge shouldn't camp on the lock screen the
        // way a due dose should.
        renotify: !n.quiet,
        silent: !!n.quiet,
        vibrate: n.quiet ? undefined : [100, 50, 100]
      });
    })());
    return;
  }

  // ── Dose notification: unchanged from v3 ──
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
