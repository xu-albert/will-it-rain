# Gonna Rain? — Testing Guide

## Test scripts (start here)

Re-runnable harnesses. Prefer these over ad-hoc commands so regressions get
caught by a rerun rather than by a user.

```bash
cd backend && npm test          # typecheck + validator units + endpoint contracts
./scripts/test-live-activity.sh # build Debug, drive every Live Activity state
```

| Script | Covers |
|---|---|
| `backend/test/validate.test.mjs` | Token/coordinate/lead-time validators, incl. every real production device token |
| `backend/test/endpoints.test.sh` | `/test-*` stay authenticated; `/register` rejects bad input before writing KV |
| `scripts/test-live-activity.sh` | Rain vs wintry rendering across all three design states + the legacy-payload regression, in both presentations |
| `screenshots/take_screenshots.sh` | App Store screenshots |

**Live Activity gotchas the script encodes** (each cost real time to find):

- The scenario harness is behind `#if DEBUG`. A **Release** build strips it and
  the app launches normally while silently starting no activity. Build Debug.
- App `print()` does not reach most log wrappers — use
  `xcrun simctl launch --console-pty`.
- The compact island only renders while the app is **backgrounded**, so the
  script launches another app to take the foreground. It avoids Settings on
  purpose: Settings can land on an Apple Account sign-in sheet and put an email
  and password field into every screenshot.
- Scenario `BX` sends a payload with `precip` **absent**, standing in for a push
  from a Worker that predates the field. It must render exactly like `B`. If it
  renders as snow the default is inverted; if the card freezes, someone made the
  field non-optional and ActivityKit can no longer decode.
- The script runs **two passes**, because the two presentations need opposite
  things. The Dynamic Island needs the app backgrounded; the lock-screen card
  needs it foregrounded, via the app's DEBUG `-liveActivityCards A,B,C` screen.
  The real lock screen is unreachable from a script — `simctl` has no lock
  command and Simulator's Device ▸ Lock over osascript fails silently too often
  to trust. So the card renders in-app from the same views the widget uses
  (`Shared/LiveActivityCardViews.swift`). This matters because everything the
  wintry palette touches — the track, its glow, the ring around the "now" dot —
  appears **only** on the card. The island shows a glyph and a countdown.
- `simctl` cannot overwrite a screenshot that a *different* process created:
  macOS attaches a per-file access ACL (`com.apple.macl`) and the write fails
  with EPERM, which `ls` gives no hint of. The script unlinks each target first.

---

## Notification testing (Release 2)

_Written 2026-07-24._

## ⚠️ Read this first — the `--remote` gotcha

`wrangler kv key list --namespace-id <id>` **reads your LOCAL sim state, not
production**, so it returns `[]` even when production is full. **Always add
`--remote`.** This is what made it look like no devices were registered.

**Reality (checked from inside the Worker): registration works — ~15 devices are
registered in production.** Nothing is broken.

---

## Key facts

- **Worker:** `https://will-it-rain.albertwxu.workers.dev`, cron every 10 min.
- **KV namespace `DEVICES`:** `142615e17bc84dc7adbd9e64d0b29410`.
- **`APNS_ENV` is set as a Worker secret** (value not readable via CLI), and was
  **verified correct 2026-07-24**: `/test-rain` returned `ok:true` (APNs 200) for
  all 5 real registered device tokens, so pushes reach the right APNs host
  end-to-end.

---

## A. See registered devices (production)

```bash
cd backend
NS=142615e17bc84dc7adbd9e64d0b29410

# List device registrations (NOTE the --remote):
npx wrangler kv key list --remote --namespace-id $NS | grep '"name": "device:'

# Inspect one:
npx wrangler kv key get --remote "device:<paste-token>" --namespace-id $NS
#   -> { token, lat, lon, leadTimeMinutes, rainStartEnabled, rainEndEnabled, registeredAt }
```

## B. Confirm YOUR device is registered

There are several device tokens (old reinstalls each make a new one). To find
*your current* one:

1. Run the app from Xcode on your phone and watch the console for:
   `[Push] Stored device token: <hex>`  ← that hex is your token.
2. Confirm it's in KV:
   ```bash
   npx wrangler kv key get --remote "device:<that-hex>" --namespace-id $NS
   ```

## C. Fire a real end-to-end push to your phone

**Both test endpoints now require the `X-Admin-Token` header.** They send real
pushes and spend real WeatherKit quota, and the Worker URL is extractable from
the shipped app, so they can't stay open. Without a correct header they return
`401`. The secret lives in the Worker as `ADMIN_TOKEN` — set it with
`npx wrangler secret put ADMIN_TOKEN` and keep the value in your password
manager (never in this file).

```bash
export ADMIN_TOKEN='<the-secret>'

# Direct — forces a "rain in 10 min" push:
curl -X POST https://will-it-rain.albertwxu.workers.dev/test-rain \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"token":"<your-token>","minutesUntilRain":10}'
#   -> {"ok":true,...} AND your phone buzzes  = works, production confirmed
#   -> {"error":"...BadDeviceToken..."}       = that token is stale/wrong env
#   -> {"error":"Unauthorized"} (401)         = missing/wrong X-Admin-Token

# Full cron path for your location (only pushes if it detects rain within lead time):
curl -X POST https://will-it-rain.albertwxu.workers.dev/test-cron \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"token":"<your-token>","lat":37.7749,"lon":-122.4194}'
```

### Dead token cleanup (automatic since 2026-07-27)

The cron no longer keeps pushing to tokens APNs has rejected:

- **410 Unregistered** → the device record is deleted immediately.
- **BadDeviceToken** → a strike counter (`apnsfail:<token>`, 24h TTL). The
  device is dropped on the 5th strike. It is deliberately not 1, because a
  wrong `APNS_ENV` makes *every* device return BadDeviceToken, and a single
  bad tick must not be able to wipe the whole device list. The app re-registers
  on every foreground, so an over-eager delete heals itself.
- A rejected **Live Activity** push clears only `activityToken`, leaving the
  device registered for ordinary rain alerts.

## D. Watch the Worker live

```bash
cd backend
npx wrangler tail
#   then trigger a test or wait for the :00/:10/:20 cron — you'll see
#   [Cron]/[Register] logs and any APNs errors in real time.
```

## E. (Optional) set APNS_ENV explicitly

```bash
cd backend
npx wrangler secret put APNS_ENV      # type:  production
npx wrangler deploy
```

---

## Where the copy lives
- **Server push:** `backend/src/apns.ts` — `sendRainAlert`, `sendRainEndAlert`.
- **On-device:** `WillItRain/WillItRain/Services/NotificationService.swift`.
- Current wording preview: `screenshots/notifications/notification-copy-*.png`.

## F. Prune junk registrations (run when convenient)

Production KV has 5 placeholder tokens (`realtest`, `test123`, `test456`,
`test789`, `testABC`) and 2 simulator tokens (160-hex — APNs always rejects
those). Harmless, but they add error-log noise once rain hits their grid:

```bash
NS=142615e17bc84dc7adbd9e64d0b29410
# list tokens, then for each junk one:
curl -X DELETE https://will-it-rain.albertwxu.workers.dev/unregister \
  -H "Content-Type: application/json" -d '{"token":"<junk-token>"}'
```

## Known gaps (Release 2 follow-ups)
- Server push says "in your area" (no city name) — backend stores only lat/lon.
  Add `locationName` to the `/register` payload to name the city.
- Server can't tell rain vs snow (WeatherKit `forecastNextHour` has no type) —
  only the on-device path is type-aware.
- Cron reads only the next ~hour, so it can't warn earlier than ~75 min out.
- Stale device tokens accumulate; add 410-Gone cleanup in the APNs path later.
