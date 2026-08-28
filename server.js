const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '32kb' }));

// ── CORS (app is served from a different origin — GitHub Pages) ──
app.use((req, res, next) => {
  countRequest(req.path);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── VAPID setup ──
// Set these as environment variables on Render — do not hardcode.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'mailto:admin@example.com';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars. Run: npm run generate-vapid');
  process.exit(1);
}

webpush.setVapidDetails(CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── Simple JSON file storage ──
// NOTE: On Render's free tier the filesystem is ephemeral — it resets on
// redeploy or when the service spins down after inactivity. Fine for
// testing. For "don't lose subscriptions ever" reliability, attach a
// Render persistent disk (small paid add-on) and point DATA_DIR at it.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'nutrition-reminders.json');
const TZ_FILE = path.join(DATA_DIR, 'timezones.json');
const FIRED_FILE = path.join(DATA_DIR, 'fired-today.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// subscriptions.json shape: { "<userId>": { subscription: {...}, label: "Walter" } }
// schedules.json shape:     { "<userId>": [ { peptideName, doseLabel, time: "HH:MM", units } ] }
// fired-today.json shape:   { "<dateStr>": ["<userId>:<peptideName>:<time>", ...] }
// nutrition-reminders.json:  { "<userId>": { water:{enabled,intervalHours,startTime,endTime},
//                                            macro:{enabled,times:[]},
//                                            endOfDay:{enabled,time} } }
//
// NOTE ON PRIVACY BY DESIGN: this server stores WHEN to remind and nothing
// else. It never receives calories, macros, ounces, or any food name. The
// push payload it sends is a bare {type} trigger; the service worker on the
// phone reads that device's own numbers and writes the notification text.

// ── Routes ──

// Bump SERVER_VERSION whenever you deploy — hitting /health in a browser then
// tells you at a glance whether Render is actually running the new code or
// quietly still serving the old build.
// ── Memory instrumentation ────────────────────────────────────────────
// Render alerted on a memory-limit restart. Nothing in this file accumulates
// across ticks, so rather than guess at a leak we measure: sample RSS once a
// minute, keep a bounded ring of the last 12 hours, and expose it. A leak is a
// line that only climbs; GC is a sawtooth; a traffic spike is a flat line with
// one bump. The ring is fixed-length by construction so the instrument itself
// can never become the leak.
const MEM_SAMPLES_MAX = 720;          // 12h at one sample per minute
const memSamples = [];                // [{ t, rss, heapUsed }]
let memPeakRss = 0;
let memPeakAt = null;
const BOOT_TIME = Date.now();
const mb = b => Math.round((b / 1048576) * 10) / 10;

function sampleMemory() {
  const m = process.memoryUsage();
  if (m.rss > memPeakRss) { memPeakRss = m.rss; memPeakAt = new Date().toISOString(); }
  memSamples.push({ t: Date.now(), rss: m.rss, heapUsed: m.heapUsed });
  while (memSamples.length > MEM_SAMPLES_MAX) memSamples.shift();
}

// Request counting, to tell a traffic spike from a leak. Bucketed by KNOWN
// path only — an unknown path increments one shared counter, so a scanner
// hitting ten thousand random URLs can't grow this object.
const KNOWN_PATHS = new Set([
  '/health', '/api/subscribe', '/api/schedule', '/api/nutrition-reminders',
  '/api/test-push', '/api/test-nutrition-push',
  '/api/debug/nutrition', '/api/debug/schedule', '/api/debug/memory'
]);
const reqCounts = Object.create(null);
let reqTotal = 0;
function countRequest(p) {
  reqTotal++;
  const key = KNOWN_PATHS.has(p) ? p : 'other';
  reqCounts[key] = (reqCounts[key] || 0) + 1;
}

const SERVER_VERSION = 'v5-memory-instrumented';

app.get('/health', (req, res) => {
  const subs = readJSON(SUBS_FILE, {});
  const reminders = readJSON(REMINDERS_FILE, {});
  const now = new Date();
  res.json({
    ok: true,
    version: SERVER_VERSION,
    users: Object.keys(subs).length,
    nutritionReminderUsers: Object.keys(reminders).length,
    time: now.toISOString(),
    // Which clock the scheduler is actually reading. If this doesn't match the
    // wall clock where you are, reminders fire at the wrong hour.
    serverLocalTime: String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0'),
    serverTZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    serverUTCOffsetMinutes: -now.getTimezoneOffset(),
    // Memory. uptimeMinutes resetting to ~0 means it restarted on you.
    memoryMB: {
      rss: mb(process.memoryUsage().rss),
      heapUsed: mb(process.memoryUsage().heapUsed),
      heapTotal: mb(process.memoryUsage().heapTotal),
      external: mb(process.memoryUsage().external)
    },
    peakRssMB: mb(memPeakRss),
    peakAt: memPeakAt,
    uptimeMinutes: Math.round((Date.now() - BOOT_TIME) / 60000),
    requestsSinceBoot: reqTotal
  });
});

// Full memory picture: the trend line, the peak, and where traffic came from.
// This is the endpoint that answers "leak or spike".
app.get('/api/debug/memory', (req, res) => {
  const n = memSamples.length;
  const first = n ? memSamples[0] : null;
  const last = n ? memSamples[n - 1] : null;
  const spanMin = first && last ? Math.round((last.t - first.t) / 60000) : 0;
  const growthMB = first && last ? mb(last.rss - first.rss) : 0;

  // A leak climbs steadily. Compare the average of the oldest quarter of the
  // window against the newest quarter — noisy single samples can't fake it.
  const q = Math.max(1, Math.floor(n / 4));
  const avg = arr => arr.reduce((a, s) => a + s.rss, 0) / arr.length;
  const oldAvg = n ? avg(memSamples.slice(0, q)) : 0;
  const newAvg = n ? avg(memSamples.slice(-q)) : 0;
  const driftMB = n ? mb(newAvg - oldAvg) : 0;

  let verdict;
  if (spanMin < 60) verdict = `Only ${spanMin} min of samples — let it run a few hours, then check again.`;
  else if (driftMB > 40) verdict = `CLIMBING ${driftMB} MB across ${spanMin} min. That looks like a leak.`;
  else if (driftMB > 15) verdict = `Drifting up ${driftMB} MB across ${spanMin} min. Worth another look tomorrow.`;
  else verdict = `Flat (${driftMB} MB drift across ${spanMin} min). No leak visible — the restart was a spike or an undersized instance.`;

  res.json({
    verdict,
    currentRssMB: last ? mb(last.rss) : null,
    peakRssMB: mb(memPeakRss),
    peakAt: memPeakAt,
    driftMB,
    windowMinutes: spanMin,
    samples: n,
    uptimeMinutes: Math.round((Date.now() - BOOT_TIME) / 60000),
    requestsSinceBoot: reqTotal,
    requestsByPath: reqCounts,
    // Thinned to ~30 points so it's readable in a browser
    trend: memSamples
      .filter((_, i) => n <= 30 || i % Math.ceil(n / 30) === 0)
      .map(s => ({ at: new Date(s.t).toISOString().slice(11, 16), rssMB: mb(s.rss) }))
  });
});

// Save/replace a user's push subscription
app.post('/api/subscribe', (req, res) => {
  const { userId, subscription, label } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'userId and subscription required' });
  const subs = readJSON(SUBS_FILE, {});
  subs[userId] = { subscription, label: label || userId };
  writeJSON(SUBS_FILE, subs);
  res.json({ ok: true });
});

// Remove a user's subscription (they toggled notifications off)
app.post('/api/unsubscribe', (req, res) => {
  const { userId } = req.body;
  const subs = readJSON(SUBS_FILE, {});
  delete subs[userId];
  writeJSON(SUBS_FILE, subs);
  res.json({ ok: true });
});

// Store a user's dose schedule (for the cron to check against).
// Kept minimal for now — full app-side sync wiring comes next round.
app.post('/api/schedule', (req, res) => {
  const { userId, schedule, tz } = req.body;
  if (!userId || !Array.isArray(schedule)) return res.status(400).json({ error: 'userId and schedule[] required' });
  const schedules = readJSON(SCHEDULES_FILE, {});
  schedules[userId] = schedule;
  if (tz) {
    const tzs = readJSON(TZ_FILE, {});
    tzs[userId] = tz;
    writeJSON(TZ_FILE, tzs);
  }
  writeJSON(SCHEDULES_FILE, schedules);
  res.json({ ok: true, count: schedule.length });
});

// Store a user's nutrition reminder settings (times only — no food data).
app.post('/api/nutrition-reminders', (req, res) => {
  const { userId, reminders } = req.body;
  if (!userId || !reminders) return res.status(400).json({ error: 'userId and reminders required' });
  const all = readJSON(REMINDERS_FILE, {});
  all[userId] = reminders;
  writeJSON(REMINDERS_FILE, all);
  res.json({ ok: true });
});

// Diagnostics — open in a browser to see exactly what the scheduler sees.
app.get('/api/debug/nutrition', (req, res) => {
  const userId = req.query.userId;
  const all = readJSON(REMINDERS_FILE, {});
  const subs = readJSON(SUBS_FILE, {});
  const fired = readJSON(FIRED_FILE, {});
  if (!userId) return res.json({ error: 'add ?userId=... — known users: ' + Object.keys(all).join(', ') });

  const rem = all[userId] || null;
  const now = new Date();
  const nowMin = nowMinInZone(rem && rem.tz);
  const asHHMM = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

  // Every minute this user WOULD fire today, so you can see the grid.
  const schedule = [];
  for (let m = 0; m < 1440; m++) {
    for (const t of dueNutritionTriggers(rem, m)) schedule.push({ at: asHHMM(m), type: t.type });
  }

  res.json({
    userId,
    hasSubscription: !!subs[userId],
    hasReminders: !!rem,
    reminders: rem,
    userTimezone: (rem && rem.tz) || '(none sent — falling back to server clock)',
    serverUTC: now.toISOString(),
    serverLocalTime: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
    resolvedUserTime: asHHMM(nowMin),
    firingRightNow: dueNutritionTriggers(rem, nowMin).map(t => t.type),
    todaysFireSchedule: schedule,
    alreadyFiredToday: (fired[todayKey()] || []).filter(k => k.startsWith(userId + ':nutri:'))
  });
});

// What dose schedule does the server actually hold, and when would it fire?
app.get('/api/debug/schedule', (req, res) => {
  const userId = req.query.userId;
  const schedules = readJSON(SCHEDULES_FILE, {});
  const subs = readJSON(SUBS_FILE, {});
  const fired = readJSON(FIRED_FILE, {});
  if (!userId) return res.json({ error: 'add ?userId=... — known users: ' + Object.keys(schedules).join(', ') });

  const tz = getUserTz(userId);
  const nowMin = nowMinInZone(tz);
  const asHHMM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const sched = schedules[userId] || [];

  res.json({
    userId,
    hasSubscription: !!subs[userId],
    // If this is 0, the app never sent any dose times — which is why you'd
    // never receive a dose push, right or wrong.
    doseTimesOnFile: sched.length,
    schedule: sched,
    userTimezone: tz || '(none reported yet — open the app once)',
    serverUTC: new Date().toISOString(),
    resolvedUserTime: asHHMM(nowMin),
    firingRightNow: sched.filter(d => d.time === asHHMM(nowMin)).map(d => d.peptideName),
    alreadyFiredToday: (fired[todayKey()] || []).filter(k => k.startsWith(userId + ':') && !k.includes(':nutri:'))
  });
});

// Fire a nutrition reminder immediately, bypassing the schedule. Use this to
// test the notification itself without waiting for an interval to land.
app.post('/api/test-nutrition-push', async (req, res) => {
  const { userId, type } = req.body || {};
  const subs = readJSON(SUBS_FILE, {});
  const entry = subs[userId];
  if (!entry) return res.status(404).json({ error: 'No subscription for that userId' });
  const t = ['water', 'macro', 'endofday'].includes(type) ? type : 'water';
  const payload = JSON.stringify({ kind: 'nutrition', type: t, tag: 'nutri-test-' + t });
  try {
    await webpush.sendNotification(entry.subscription, payload);
    res.json({ ok: true, sent: t });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, statusCode: err.statusCode });
  }
});

// Fire an immediate test push to a user — this is the one to hit first.
app.post('/api/test-push', async (req, res) => {
  const { userId, title, body } = req.body;
  const subs = readJSON(SUBS_FILE, {});
  const entry = subs[userId];
  if (!entry) return res.status(404).json({ error: 'No subscription for that userId' });

  const payload = JSON.stringify({
    title: title || 'PeptideRx test',
    body: body || 'If you see this, push is working end to end.',
    tag: 'test-push'
  });

  try {
    await webpush.sendNotification(entry.subscription, payload);
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('Push failed:', err.statusCode, err.body);
    if (err.statusCode === 410 || err.statusCode === 404) {
      delete subs[userId];
      writeJSON(SUBS_FILE, subs);
    }
    res.status(500).json({ ok: false, error: err.message, statusCode: err.statusCode });
  }
});

// ── Scheduler: checks every minute for doses due right now ──
function todayKey() {
  return new Date().toISOString().split('T')[0];
}
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function checkAndFireDueDoses() {
  const subs = readJSON(SUBS_FILE, {});
  const schedules = readJSON(SCHEDULES_FILE, {});
  const fired = readJSON(FIRED_FILE, {});
  const today = todayKey();
  fired[today] = fired[today] || [];

  for (const userId of Object.keys(schedules)) {
    const subEntry = subs[userId];
    if (!subEntry) continue;

    // Dose times are entered on the user's phone clock. This process runs on
    // Render in UTC, so reading our own clock fired an 08:00 dose at 03:00
    // their time. Resolve the current minute in THEIR zone instead.
    const nowMin = nowMinInZone(getUserTz(userId));
    const now = String(Math.floor(nowMin / 60)).padStart(2, '0') + ':' + String(nowMin % 60).padStart(2, '0');

    for (const dose of schedules[userId]) {
      if (dose.time !== now) continue;
      const fireKey = `${userId}:${dose.peptideName}:${dose.doseLabel || ''}:${dose.time}`;
      if (fired[today].includes(fireKey)) continue;

      const payload = JSON.stringify({
        title: `${dose.peptideName} due`,
        body: dose.units ? `${dose.doseLabel || 'Dose'} — pull to ${dose.units}` : (dose.doseLabel || 'Time to log this dose'),
        tag: fireKey
      });

      try {
        await webpush.sendNotification(subEntry.subscription, payload);
        fired[today].push(fireKey);
      } catch (err) {
        console.error(`Push failed for ${userId}:`, err.statusCode);
        if (err.statusCode === 410 || err.statusCode === 404) {
          delete subs[userId];
          writeJSON(SUBS_FILE, subs);
        }
      }
    }
  }

  // trim fired-today to just today + yesterday so the file doesn't grow forever
  for (const key of Object.keys(fired)) {
    if (key !== today) delete fired[key];
  }
  writeJSON(FIRED_FILE, fired);
}

// ── Nutrition reminders ──
// Water fires on an interval inside a waking window; macros fire at the times
// the user picked; the end-of-day summary fires once. All three send only a
// {type} trigger — the phone fills in the numbers.
function hhmmToMin(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// The user picks reminder times in THEIR local clock, but this process runs on
// Render — usually UTC. Reading our own getHours() would fire a 7am reminder at
// 2am their time. The app sends its IANA zone ('America/Chicago') with the
// settings, so resolve the current minute in that zone instead. Falls back to
// server-local only when no zone was sent.
// A user's zone can arrive on either sync. Look in the dedicated store first,
// then fall back to whatever the reminder settings carried.
function getUserTz(userId) {
  const tzs = readJSON(TZ_FILE, {});
  if (tzs[userId]) return tzs[userId];
  const rem = readJSON(REMINDERS_FILE, {})[userId];
  return (rem && rem.tz) || null;
}
// Intl.DateTimeFormat objects are expensive ICU allocations and this ran once
// per user per minute, forever. Cache one per zone — there are at most a
// handful of distinct zones, so the map is bounded in practice.
const tzFormatters = new Map();
function tzFormatter(tz) {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    });
    if (tzFormatters.size < 50) tzFormatters.set(tz, f);  // hard ceiling
  }
  return f;
}
function nowMinInZone(tz) {
  if (tz) {
    try {
      const s = tzFormatter(tz).format(new Date());
      const [h, m] = s.split(':').map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) return (h % 24) * 60 + m;
    } catch (e) { /* bad zone string — fall through */ }
  }
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function dueNutritionTriggers(rem, nowMin) {
  const out = [];
  if (!rem) return out;

  const w = rem.water || {};
  if (w.enabled) {
    const start = hhmmToMin(w.startTime), end = hhmmToMin(w.endTime);
    const step = Math.round((parseFloat(w.intervalHours) || 1.5) * 60);
    if (start !== null && end !== null && step > 0 && nowMin >= start && nowMin <= end) {
      // Fire on the interval measured from the start of the window. The first
      // one lands at start + step, not at start itself — no point nagging you
      // to drink the same minute the window opens.
      const elapsed = nowMin - start;
      if (elapsed > 0 && elapsed % step === 0) out.push({ type: 'water', slot: nowMin });
    }
  }

  const m = rem.macro || {};
  if (m.enabled && Array.isArray(m.times)) {
    for (const t of m.times) if (hhmmToMin(t) === nowMin) out.push({ type: 'macro', slot: t });
  }

  const e = rem.endOfDay || {};
  if (e.enabled && hhmmToMin(e.time) === nowMin) out.push({ type: 'endofday', slot: e.time });

  return out;
}

async function checkAndFireNutritionReminders() {
  const subs = readJSON(SUBS_FILE, {});
  const reminders = readJSON(REMINDERS_FILE, {});
  const fired = readJSON(FIRED_FILE, {});
  const today = todayKey();
  fired[today] = fired[today] || [];

  for (const userId of Object.keys(reminders)) {
    const subEntry = subs[userId];
    if (!subEntry) continue;

    const rem = reminders[userId];
    const nowMin = nowMinInZone(rem && rem.tz);

    for (const trig of dueNutritionTriggers(rem, nowMin)) {
      const fireKey = `${userId}:nutri:${trig.type}:${trig.slot}`;
      if (fired[today].includes(fireKey)) continue;

      // Deliberately contentless. The service worker supplies the real text.
      const payload = JSON.stringify({ kind: 'nutrition', type: trig.type, tag: fireKey });

      try {
        await webpush.sendNotification(subEntry.subscription, payload);
        fired[today].push(fireKey);
      } catch (err) {
        console.error(`Nutrition push failed for ${userId}:`, err.statusCode);
        if (err.statusCode === 410 || err.statusCode === 404) {
          delete subs[userId];
          writeJSON(SUBS_FILE, subs);
        }
      }
    }
  }
  writeJSON(FIRED_FILE, fired);
}

cron.schedule('* * * * *', () => {
  sampleMemory();
  checkAndFireDueDoses().catch(err => console.error('Scheduler error:', err));
  checkAndFireNutritionReminders().catch(err => console.error('Nutrition scheduler error:', err));
});

// A bad/oversized body is a scanner, not an incident. Answer it and move on —
// don't dump a stack trace into the logs every time one shows up.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Body too large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  sampleMemory();   // baseline at boot, so /health is useful before the first tick
  console.log(`PeptideRx push server listening on ${PORT}`);
});
