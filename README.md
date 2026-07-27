# PeptideRx

Personal peptide dose manager — Progressive Web App.

## Deploy to GitHub Pages

1. Create a new repo on GitHub named `peptiderx` (or whatever you want)
2. Push all files in this folder to the `main` branch
3. Go to repo Settings → Pages → Source: `main` branch, `/ (root)`
4. Your app will be live at `https://yourusername.github.io/peptiderx/`

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app — all UI, logic, and data |
| `manifest.json` | PWA manifest — enables "Add to Home Screen" |
| `sw.js` | Service worker — offline caching + push notifications |
| `notifications.js` | Notification engine — scheduling, permission, snooze |
| `icon-180.png` | Apple touch icon (home screen) |
| `icon-192.png` | Android / PWA icon |
| `icon-512.png` | Splash screen / store icon |

## iOS Setup (iPhone)

1. Open `https://yourusername.github.io/peptiderx/` in **Safari**
2. Tap Share → **Add to Home Screen** → Add
3. Open from home screen (must be from home screen for notifications to work)
4. Tap the **🔕 Off** button in the top bar → grant notification permission
5. Add dose times to your peptides — notifications fire at those times

## Notes

- Data is stored in localStorage on each device — not synced between phones
- Notifications require iOS 16.4+ and app must be opened from home screen
- Missed doses are auto-logged at midnight rollover
