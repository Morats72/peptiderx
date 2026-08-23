# PeptideRx — Project Notes
*Consolidated from chat history for local reference (Cowork / laptop use). Last updated 2026-08-19, app version v2.6.0.*

## What this is
A personal PWA (Progressive Web App) built for Walter Leininger (Fire Chief, Caledonia Fire Department) and his wife (Lieutenant, same department) to track peptide dosing — schedules, syringe draw calculations, dose logging, and a personal reference library. Single-file HTML app, no backend database, deployed to GitHub Pages. Data lives in localStorage on each phone (no cloud sync between Walter's and his wife's devices — each phone is independent).

**Live app:** https://morats72.github.io/peptiderx/
**Repo:** `peptiderx` (GitHub Pages, static hosting)
**Push notification server repo:** separate repo, deployed on Render — service name `notifications-rq0q` → `https://notifications-rq0q.onrender.com`

## Architecture
- `index.html` — the entire app (HTML/CSS/JS in one file). This is what gets pushed to the `peptiderx` repo.
- `sw.js` — service worker. Handles offline caching (network-first strategy) and push notification display/click handling.
- `manifest.json` — PWA manifest. `start_url` and `scope` must be relative (`./`) not absolute (`/`) since the site lives at a GitHub Pages subpath (`/peptiderx/`), not the domain root.
- Separate Node/Express server (`server.js` + friends) on Render — handles Web Push subscriptions and a per-minute cron that fires reminders. Talks to the app via `/api/subscribe`, `/api/schedule`, `/api/test-push`.

## Key design decisions
- **Full builds, not phased delivery** — Walter prefers getting the whole feature in one shot rather than incremental previews.
- **Local-first data** — dose schedules and logs stay in localStorage; the push server only ever holds subscription info + today's schedule times (peptide name, dose label, time, units), nothing about history or notes.
- **No cloud sync** — by design. Each phone is its own independent dataset.
- **Syringe defaults**: Walter personally uses 0.3ml insulin syringes, 3ml BAC water on 10mg vials. App supports 0.3ml / 0.5ml / 1.0ml syringes with size-appropriate graduation (5-unit steps on 0.3ml, 10-unit steps on 0.5ml/1.0ml).
- **Version string convention** — every deploy bumps `APP_VERSION` in the JS and shows it in Settings, specifically so Walter can confirm a push actually deployed (this became necessary after a few rounds of confusion about which file was actually live).

## App structure (tabs)
Dashboard · Upcoming · My Stack · Reference · Calculator · Log — five-tab bottom nav.

- **Dashboard** — Today's Doses (Due/Done/Active tappable stat boxes, each opens a full peptide detail card matching My Stack), Due Today list grouped by AM/PM, Recent Log.
- **Upcoming** — forward-looking schedule, day-by-day.
- **My Stack** — full peptide list, expandable cards showing current dose, syringe units, vial/BAC, doses left, schedule, cycle progress bar, notes. Pause / Resume / Complete / Edit / Delete actions live here.
- **Reference** — personal peptide reference library (62 entries, alphabetized, sourced from Walter's merged multi-source PDF compilation). Search + category filter. Back-to-index link on each entry.
- **Calculator** — reconstitution calculator with animated syringe visual (numbers now sit inside the barrel directly on the tick marks, not in a separate row below).
- **Log** — month/week/list views of dose history. Unlog (undo) any entry. Export to CSV or PDF (print-dialog based, no external library — keeps it offline-capable). Clear Log lives in Settings only, not here.
- **Settings** (gear icon, top right) — Push Notifications (enable/test), Keep Screen Awake (Screen Wake Lock API), Export Dose Log, Clear Log (Danger Zone), app version footer.

## Scheduling engine
Four (now five) schedule types per peptide:
- **Daily** — every day.
- **Days of Week** — pick specific weekdays.
- **Every N Days** *(added 2026-08-19)* — fixed interval, e.g. "every 6 days" for the LT's protocol. Dose lands on the start date, then every N days after. Has its own progress bar ("Day 3 of 6 — 3 days to go").
- **On/Off Cycle** — X days/weeks on, Y days/weeks off, repeating.
- **As Needed** — no schedule, logged manually.

Peptides also support: titration/escalating dose steps, doses-per-day (1-4x with individual time pickers), vial tracking with auto-decrement and doses-left warnings, and Pause/Complete states (Pause keeps all data and is resumable; Complete is the "rotation's done" terminal state — both stop the peptide from counting as due).

## Known bugs fixed (worth knowing if something regresses)
- **Evening rollover bug** — `todayStr()` originally used `.toISOString()` which returns UTC date, not local. In Central time this made the app think a new day had started around 7 PM, wiping "done" marks and logging outstanding doses as missed hours early. Fixed by computing date from local `getFullYear/getMonth/getDate`. This bug's pattern (UTC vs. local date) has bitten multiple functions over time — always use local-date computation for anything comparing "today" against stored dates.
- **Server timezone bug** — the Render push server defaults to UTC; had to explicitly compute "now" in `America/Chicago` via `Intl.DateTimeFormat` rather than trusting the server's raw `Date()`.
- **Early-log still notifying** — logging a dose early didn't cancel the scheduled push because the schedule sync to the server never excluded already-logged doses, and nothing re-synced after logging. Fixed both: schedule builder now skips checked/skipped doses, and every log/skip/unlog action re-syncs immediately.
- **Service worker caching stale versions** — original `sw.js` was cache-first with no network check, so deploys were invisible until a manual cache-clear. Switched to network-first (try network, fall back to cache only if offline).
- **GitHub Pages subpath issues** — several absolute paths (`/manifest.json`, `/icon-180.png`, manifest's `start_url`/`scope`) broke because the site isn't at the domain root. All fixed to relative paths.
- **Duplicate apple-touch-icon tags** — one embedded base64 (always works), one file-path based (broke on subpath) — iOS preferred the broken one. Removed the redundant tag.
- **Syringe visual orientation** — needle is on the right, so the fill/scale should anchor at 0 near the needle and grow toward the plunger (left) as dose increases — was originally backwards.
- **savePeptide silently un-pausing peptides** — editing any field on a paused/completed peptide was resetting `active:true` unconditionally on every save. Fixed to preserve existing status.

## Push notification setup (for reference if it needs debugging)
- VAPID keys generated once via `npm run generate-vapid` in the server repo, public key baked into `index.html`, both keys set as Render environment variables (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CONTACT_EMAIL` — must be `mailto:...` format).
- Render free tier sleeps after ~15 min idle — the per-minute cron won't fire while asleep. Worth revisiting (paid always-on tier, or an uptime pinger) if reminders start feeling unreliable.
- `data/*.json` on Render's free tier is ephemeral (wiped on redeploy/sleep cycle) — fine for now, would need a persistent disk or real DB if reliability becomes critical.

## Reference library provenance
The 62-entry peptide reference (mechanism of action, dosing by source, stacking/cautions, side effects, cycling notes) was compiled separately across several sessions from ~13 source documents (Ryan Veller's "Peptide Mastery," IronGorillas Underground Handbook, Jay Campbell sources, Brandon Vaughn's "Peptides 201," Ben Greenfield's guide, Research Peptides guide, Tailor Made Compounding, Scendere, LVLUP, Protide Health, and others). A parallel deliverable — a formatted PDF with hyperlinked index/category pages — was also built from the same source material; that's a separate artifact from the in-app reference tab but shares the same underlying data. A dated correction (Aug 9, 2026) fixed a 5-Amino-1MQ dosing entry that had merged oral and injectable routes without distinguishing them (100-500x dosing difference) — worth remembering as an example of the kind of error to watch for when future source material gets merged in.

## Source conversations (for deep history if ever needed)
- **This chat** (2026-08-19 → ongoing) — push notification server build-out, timezone/caching bug fixes, Due/Done/Active detail cards, syringe orientation + graduation fixes, pause/complete, CSV/PDF export, Every-N-Days scheduling.
- **"Peptides: essential knowledge before use"** — https://claude.ai/chat/b9363a28-d9cb-44e4-aa61-b9d3ea37670b — main PWA build session, ended at v2.4.5 after hitting the 100-image upload limit.
- **"Peptide reference document build"** — https://claude.ai/chat/17868e17-8518-4024-9b4d-2ca3f943faba — the 62-entry reference PDF compilation project.
- Earlier build history referenced but not directly searched: original app scaffold, per the second chat's summary, around 2026-07-26.

## Open items / things to revisit
- LT's push notification subscription — confirm it's live and tested on her phone specifically (separate subscription from Walter's).
- Render free-tier reliability (sleep/cron gap) — decide whether to upgrade or add an uptime pinger.
- Titration step doses are still mcg-only (the mcg/mg toggle only applies to the main dose field, by design/scope choice).
