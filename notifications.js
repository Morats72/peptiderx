// PeptideRx — Notification Engine
// Handles permission, scheduling, snooze, and daily alarm setup

const NOTIF_KEY = 'prx_notif_prefs';

// ── Register service worker ──
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[PeptideRx] SW registered');
    return reg;
  } catch (err) {
    console.warn('[PeptideRx] SW registration failed:', err);
    return null;
  }
}

// ── Request notification permission ──
async function requestNotifPermission() {
  if (!('Notification' in window)) {
    showToast('Notifications not supported on this browser');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    showToast('Notifications blocked — enable in iOS Settings > Safari');
    return false;
  }
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ── Get notification preference ──
function getNotifPrefs() {
  try { return JSON.parse(localStorage.getItem(NOTIF_KEY)) || { enabled: false, scheduledAlarms: [] }; }
  catch { return { enabled: false, scheduledAlarms: [] }; }
}
function saveNotifPrefs(prefs) {
  localStorage.setItem(NOTIF_KEY, JSON.stringify(prefs));
}

// ── Show a local notification (via SW) ──
async function showLocalNotif(title, body, tag) {
  if (Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: tag || 'peptiderx',
    requireInteraction: true,
    vibrate: [200, 100, 200],
  });
}

// ── Build today's alarm schedule from peptide stack ──
function buildTodayAlarms(peptides) {
  const alarms = [];
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  peptides.forEach(p => {
    if (!p.active) return;
    // Check if due today (simplified — full logic in main app)
    const freq = p.freq || 1;
    for (let i = 0; i < freq; i++) {
      const timeStr = p.times && p.times[i];
      if (!timeStr) continue; // skip if no time set
      const [hh, mm] = timeStr.split(':').map(Number);
      const alarmTime = new Date(now);
      alarmTime.setHours(hh, mm, 0, 0);
      if (alarmTime > now) {
        alarms.push({
          peptideId: p.id,
          name: p.name,
          dose: p.dose,
          doseIdx: i,
          time: alarmTime,
          tag: `${p.id}_${i}_${todayStr}`,
          label: freq > 1 ? `Dose ${i + 1}` : '',
        });
      }
    }
  });

  // Sort by time
  alarms.sort((a, b) => a.time - b.time);
  return alarms;
}

// ── Schedule all alarms for today using setTimeout ──
// (Works when app is open or in background on iOS 16.4+ add-to-homescreen)
let _scheduledTimers = [];

function clearScheduledAlarms() {
  _scheduledTimers.forEach(t => clearTimeout(t));
  _scheduledTimers = [];
}

function scheduleAlarms(peptides) {
  clearScheduledAlarms();
  const prefs = getNotifPrefs();
  if (!prefs.enabled || Notification.permission !== 'granted') return;

  const alarms = buildTodayAlarms(peptides);
  if (!alarms.length) return;

  alarms.forEach(alarm => {
    const msUntil = alarm.time - new Date();
    if (msUntil < 0) return;
    const t = setTimeout(async () => {
      const label = alarm.label ? ` (${alarm.label})` : '';
      await showLocalNotif(
        `💉 ${alarm.name}${label}`,
        `${alarm.dose} mcg — time for your dose.`,
        alarm.tag
      );
    }, msUntil);
    _scheduledTimers.push(t);
    console.log(`[PeptideRx] Alarm set: ${alarm.name} in ${Math.round(msUntil/60000)} min`);
  });

  console.log(`[PeptideRx] ${alarms.length} alarm(s) scheduled for today`);
}

// ── Snooze handler (message from SW) ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'SNOOZE') {
      const ms = (e.data.minutes || 15) * 60 * 1000;
      setTimeout(async () => {
        await showLocalNotif(
          '💉 Snoozed Reminder',
          'Your snoozed dose is ready.',
          e.data.tag + '_snooze'
        );
      }, ms);
      showToast('Snoozed 15 min ⏰');
    }
  });
}

// ── Reschedule at midnight for next day ──
function scheduleMidnightReschedule(peptides) {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 30, 0); // 00:00:30 next day
  const msUntilMidnight = midnight - now;
  setTimeout(() => {
    scheduleAlarms(peptides);
    scheduleMidnightReschedule(peptides);
  }, msUntilMidnight);
}

// ── Init — call this on app load ──
async function initNotifications(peptides) {
  const reg = await registerSW();
  if (!reg) return;

  const prefs = getNotifPrefs();
  if (prefs.enabled && Notification.permission === 'granted') {
    scheduleAlarms(peptides);
    scheduleMidnightReschedule(peptides);
  }
}

// ── Toggle notifications on/off ──
async function toggleNotifications(peptides) {
  const prefs = getNotifPrefs();
  if (prefs.enabled) {
    // Turn off
    clearScheduledAlarms();
    prefs.enabled = false;
    saveNotifPrefs(prefs);
    updateNotifButton(false);
    showToast('Notifications off');
  } else {
    // Turn on — request permission first
    const granted = await requestNotifPermission();
    if (!granted) return;
    prefs.enabled = true;
    saveNotifPrefs(prefs);
    scheduleAlarms(peptides);
    scheduleMidnightReschedule(peptides);
    updateNotifButton(true);
    const count = buildTodayAlarms(peptides).length;
    showToast(count ? `Notifications on — ${count} alarm${count>1?'s':''} set today` : 'Notifications on — add dose times to enable alarms');
  }
}

function updateNotifButton(enabled) {
  const btn = document.getElementById('notif-toggle-btn');
  if (!btn) return;
  btn.textContent = enabled ? '🔔 On' : '🔕 Off';
  btn.style.background = enabled ? 'var(--green-light)' : 'var(--blue-light)';
  btn.style.color = enabled ? 'var(--green)' : 'var(--blue)';
}

function getNotifStatus() {
  const prefs = getNotifPrefs();
  return prefs.enabled && Notification.permission === 'granted';
}
