# Gonna Rain? — Notification Testing Guide (temporary)

_Written 2026-07-24 for Release 2. Delete when done._

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

```bash
# Direct — forces a "rain in 10 min" push:
curl -X POST https://will-it-rain.albertwxu.workers.dev/test-rain \
  -H "Content-Type: application/json" \
  -d '{"token":"<your-token>","minutesUntilRain":10}'
#   -> {"ok":true,...} AND your phone buzzes  = works, production confirmed
#   -> {"error":"...BadDeviceToken..."}       = that token is stale/wrong env

# Full cron path for your location (only pushes if it detects rain within lead time):
curl -X POST https://will-it-rain.albertwxu.workers.dev/test-cron \
  -H "Content-Type: application/json" \
  -d '{"token":"<your-token>","lat":37.7749,"lon":-122.4194}'
```

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
