# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Build & test

- The Xcode project is `WillItRain/WillItRain.xcodeproj`, shared scheme `WillItRain` (targets: app, `WillItRainWidgets` extension, `WillItRainTests` unit tests hosted in the app).
- CI is `.github/workflows/ci.yml`: an iOS job (unsigned simulator build + headless `xcodebuild test` on macos-26, Xcode pinned via `DEVELOPER_DIR`) and a backend job (`npm ci && npm run typecheck && npm test` in `backend/`). Keep the Xcode pin in sync with the version the project needs; runner image contents are listed in actions/runner-images `macos-26-Readme.md`.
- Local headless verification (don't open Simulator.app unless the session is explicitly doing GUI capture work like the screenshot section below):
  `xcodebuild build-for-testing -project WillItRain/WillItRain.xcodeproj -scheme WillItRain -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` then `xcodebuild test-without-building ... -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`; shut the sim down afterwards with `xcrun simctl shutdown`.
- All four source folders (`WillItRain`, `WillItRainWidgets`, `Shared`, `WillItRainTests`) are file-system-synchronized groups in the pbxproj: a new `.swift` file dropped into one is compiled into every target that owns the folder (`Shared` belongs to both the app and the widget extension) with no project edit. Pure logic is tested by injecting the clock and stores (`ForecastMerge.merge(minute:hourly:now:)`, `PrecipitationPeriod.detect(in:)`, `RainForecast`'s `at:` readings, `NotificationSettings(defaults:)`, `NotificationService(deliver:)`); follow that pattern rather than reaching for `Date()` or `UserDefaults.standard` in new logic.
- WeatherKit's minute forecast is regional. `ForecastMerge` (iOS) and `nextHour.ts` (Worker) fall back to the hourly forecast from the hour containing now when it is absent, and an hourly reading stands for the whole hour it starts (`ChartDataPoint.span`); `RainForecast.hasMinuteForecast` is what the UI keys the "showing hourly" line on. Keep both fallbacks in step. Inside minute coverage a period that begins on the hourly reading right after the nowcast is `isConfirmed == false`: the hero line and charts show it, but `NotificationService` and `LiveActivityService` act only on `RainForecast.confirmedPeriods` (its onset is the moving nowcast horizon, so alerting on it re-announced one wet hour every poll), just as the Worker reads only `forecastNextHour` when it exists. Wet hours further out begin on whole readings and stay confirmed.
- The app's Info.plist is generated (`GENERATE_INFOPLIST_FILE=YES`): INFOPLIST_KEY_* build settings in the pbxproj are the source of truth (e.g. the portrait lock). `BuildProductTests` asserts on the merged plist of the built product — update those tests when changing those settings deliberately.
- `SourceFiles/` at the repo root is a stale copy of app sources; the compiled code lives under `WillItRain/`.

## Driving the iOS Simulator for screenshots

Two traps here have cost more than one session its captures. Both are documented
in the header of `WillItRain/Design/AppIcon/capture-icon-shots.sh` — read it
before writing any new tap coordinate.

- The Simulator window draws the device **rotated 180°** (status bar at the
  bottom of the window), at **0.31 screen points per device pixel**. Taps must
  be mirrored through the screen centre; `simctl io screenshot` is unaffected
  and still returns an upright frame, so the rotation is invisible in the
  captures and only corrupts clicks. Symptom: a tap silently lands on the
  wallpaper and drops the Home Screen into jiggle mode.
- The Dynamic Island collapses the instant a long press is released, so the
  expanded presentation must be screenshotted **while the press is held**.

The first Live Activity presented after an unlock also draws a one-off
"Allow Live Activities from …?" consent sheet over the card; burn it on a
throwaway activity before capturing.

## App icon

`WillItRain/Design/AppIcon/AppIcon.svg` is the source of truth. Every catalogue
PNG is regenerated from it at its own pixel size by `render_appicon.py` — never
rescale one PNG into another size. `verify_mark.py` checks that the SwiftUI
`AppIconMark` geometry still matches the SVG.

## Backend Worker

- `backend/` is a Cloudflare Worker with **no runtime npm dependencies**; `wrangler`,
  `typescript` and `vitest` are dev-only. Verify headlessly with `npm run typecheck`,
  `npm test`, and `npx wrangler deploy --dry-run`.
- **This account is on the Workers FREE plan, and that is what sets every cap.** One
  invocation gets 50 *external* subrequests, shared by the cron's WeatherKit fetches
  *and* its APNs pushes; Durable Object and KV calls are *internal* and come from a
  separate 1,000 bucket. `MAX_GRID_CELLS`, `PUSH_BUDGET_PER_INVOCATION` and
  `MAX_DEVICES_PER_CELL` in `backend/src/abuse.ts` are derived together from that one
  budget — read the arithmetic there before touching the cron schedule, the grid
  precision, or any of the three. (The WeatherKit quota is only a cross-check now:
  a full service uses 13% of it.) Per invocation is not the only ceiling: the same
  file counts the Free plan's *daily* allowances (100,000 KV reads, 1,000 writes,
  1,000 deletes, 1,000 lists, plus the Durable Objects' own meters), which is what
  sizes `MAX_TTL_MIGRATIONS_PER_TICK`, `MAX_DEVICE_REAPS_PER_TICK`,
  `DEVICE_RECORD_REFRESH_SECONDS` and `DEVICE_REWRITE_COOLDOWN_SECONDS` — and two of
  those daily KV buckets, writes and reads, do *not* fit at a full-fleet 15 x 20.
- The registration endpoints are **unauthenticated by construction**: the Worker URL
  ships in the iOS binary and an APNs token cannot be verified server-side. What
  bounds abuse is the gate in `abuse.ts` — per-client throttle, global cell cap,
  per-cell device cap, per-invocation push budget, per-device rewrite cooldown,
  record TTL — not authentication. App Attest is the eventual fix, not something
  in place.
- The gate's counters live in **Durable Objects** (`backend/src/durable.ts`), not KV:
  KV reads come from a colo-local cache with a 60-second floor, so a KV counter
  cannot see a sub-second burst. The wrangler migration must stay on
  `new_sqlite_classes` — `new_classes` is the Paid-only backend and would make the
  Worker undeployable here.
- A `device:` record's 45-day TTL is only safe because the client genuinely renews
  it: `ContentView` re-registers on cold launch, on `willEnterForeground` and after
  every successful weather poll, and `LocationService` re-registers past a 10 km
  move. Renewal takes both halves, though — the server skips a re-registration that
  changes nothing, so what actually resets the TTL is `DEVICE_RECORD_REFRESH_SECONDS`
  (7 days) forcing a write through. Break either half and the TTL becomes a silent
  alert outage on day 45.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
