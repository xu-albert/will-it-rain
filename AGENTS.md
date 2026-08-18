# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Build & test

- The Xcode project is `WillItRain/WillItRain.xcodeproj`, shared scheme `WillItRain` (targets: app, `WillItRainWidgets` extension, `WillItRainTests` unit tests hosted in the app).
- CI is `.github/workflows/ci.yml`: an iOS job (unsigned simulator build + headless `xcodebuild test` on macos-26, Xcode pinned via `DEVELOPER_DIR`) and a backend job (`npm ci && npm run typecheck && npm test` in `backend/`). Keep the Xcode pin in sync with the version the project needs; runner image contents are listed in actions/runner-images `macos-26-Readme.md`.
- Local headless verification (don't open Simulator.app unless the session is explicitly doing GUI capture work like the screenshot section below):
  `xcodebuild build-for-testing -project WillItRain/WillItRain.xcodeproj -scheme WillItRain -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` then `xcodebuild test-without-building ... -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`; shut the sim down afterwards with `xcrun simctl shutdown`.
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
- **Every distinct ~1.1 km grid cell costs ~4,383 WeatherKit calls a month, forever** —
  the cron fans out one fetch per cell, every 10 minutes, and Apple's allotment is
  500k/month. That arithmetic, and the hard cell ceiling it sets, live in
  `backend/src/abuse.ts` (`MAX_GRID_CELLS`). Read the comment there before changing
  the cron schedule, the grid precision, or the cap.
- The registration endpoints are **unauthenticated by construction**: the Worker URL
  ships in the iOS binary and an APNs token cannot be verified server-side. What
  bounds abuse is the gate in `abuse.ts` (per-client KV throttle + cell cap + record
  TTL), not authentication. App Attest is the eventual fix, not something in place.
- Workers KV serves reads from a colo-local cache with a 60-second floor, so a KV
  counter alone cannot stop a sub-second burst. `abuse.ts` puts an in-isolate counter
  in front of the KV one for exactly that case; don't remove it as redundant.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
