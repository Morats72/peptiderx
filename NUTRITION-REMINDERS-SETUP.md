# Nutrition Reminders — deploy notes

Three pieces. The app is already done; the other two need you.

---

## 1. `indextest.html` — DONE, just upload it

Already built. Settings → **Nutrition Reminders**.

---

## 2. `server.js` — replace the file on Render

The changes are **purely additive**. Nothing in the existing dose-reminder path
was touched — `checkAndFireDueDoses`, `/api/subscribe`, `/api/schedule`,
`/api/test-push` are all byte-for-byte what they were. What's new:

- `REMINDERS_FILE` constant
- `POST /api/nutrition-reminders` — stores reminder *times* per user
- `hhmmToMin()`, `dueNutritionTriggers()`, `checkAndFireNutritionReminders()`
- one added line inside the existing `cron.schedule('* * * * *')` block

**Worst case if it goes wrong:** dose reminders keep working, nutrition ones
don't fire. The two paths don't share state beyond the subscription list.

Deploy: replace `server.js`, commit, let Render redeploy. Check
`https://notifications-rq0q.onrender.com/health` comes back `{"ok":true}` after.

---

## 3. `sw.js` — DONE, replace the file

You sent me your `sw.js`, so this is merged and ready — no hand-editing.

Verified against your original, programmatically:

- `install`, `activate`, `notificationclick`, `message` — **byte-for-byte identical**
- Dose notifications — title, body, `✓ Log Dose` / `⏰ Snooze 15 min`, `requireInteraction`, `vibrate [200,100,200]` all unchanged
- Cache bumped `peptiderx-v3` → `peptiderx-v4` (required, or phones keep the old worker)

Two fixes came out of reading your real file:

1. **Icon paths.** My first draft used `/icon-192.png`. Yours are `./icon-192.png`
   — relative, because GitHub Pages serves from `/peptiderx/`. Absolute paths
   would have 404'd every notification icon. Now matches yours.
2. **`cache.put()` on POSTs.** The fetch handler cached every response,
   but `cache.put()` throws on POST requests, and there was no `.catch`. Every
   push-subscribe, schedule sync, reminder sync, and Open Food Facts call was
   raising an unhandled rejection. Harmless, but it buried real errors in the
   console. Now only GETs with an ok response get cached.

---

## How it actually works

The thing worth understanding: **the server never learns what you ate.**

    server (Render)                phone (service worker)
    ───────────────                ──────────────────────
    knows: reminder TIMES          knows: today's real numbers
    sends: {type:'water'}    ──▶   reads IndexedDB snapshot
           (no data at all)        writes "48 of 100oz · 12oz behind pace"
                                   shows the notification

Your food log never leaves the device. The numbers on the lock screen are true
as of the second the notification fires, not as of the last time a sync ran.

**Edge cases handled:**

- **App not opened today** — snapshot is stamped with its date. Stale means
  "Nothing logged yet today", never yesterday's numbers presented as today's.
- **Goal already hit** — shows a *silent* confirmation instead of buzzing.
  It can't show nothing at all: a push handler that displays no notification
  makes the browser post its own "site updated in the background" notice, which
  is worse than a quiet "you're good."
- **IndexedDB wedged or slow** — 1.5s timeout, then a generic fallback. A push
  handler that hangs on iOS produces that same junk notice.
- **Render wipes its disk** (ephemeral filesystem — the README warns about this)
  — the app re-pushes subscription, schedule, and reminder settings ~2.5s after
  every open. Worst case is "reminders resume next time you open the app,"
  not "reminders silently stopped and nobody noticed."

---

## Water pacing

The window has a start and an end, and the goal is meant to be **met by the
end**, not by midnight. Reminders fire on the interval measured from the start
(every 1.5h from 06:00 → 07:30, 09:00, 10:30 …) and stop at the end time.

Pace is `goal × elapsed / window`, so at 13:30 in a 06:00–20:00 window you
should be about halfway. More than 1 unit under and it says how far behind.

---

## Test checklist

1. Settings → Nutrition Reminders → set water every 1 hr, window covering now
2. Save, confirm the summary line in Settings reads back correctly
3. Log some water so you're partway to goal
4. Wait for the interval to land — notification should show your real numbers
5. Log past your goal, wait for the next one — should arrive silent, "goal hit"
6. Confirm dose reminders still fire normally
