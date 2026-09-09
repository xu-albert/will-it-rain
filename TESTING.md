# Gonna Rain? — Test Plan

This is the project's comprehensive test plan, covering strategy, unit/integration/regression
coverage, manual and release procedures. It supersedes the informal scope of the original
`TESTING.md` (written 2026-07-24 as a one-off production-debugging runbook); that content is
preserved verbatim below as [Appendix A](#appendix-a-production-ops--notification-testing-runbook)
because it is still the correct procedure for its narrow purpose (inspecting/pruning production
KV, firing a real push, reading the abuse-gate symptom table) — it is not a test plan and this
document does not duplicate it.

Build/run/CI mechanics (scheme name, `xcodebuild` invocations, simulator traps, backend budget
arithmetic) live in [`AGENTS.md`](AGENTS.md) and are linked rather than repeated here.

## 1. Test strategy and the pyramid

Two independently-tested components share one repo: the **backend Worker** (`backend/`, stateless
HTTP + a 10-minute cron, tested with Vitest against in-memory KV/DO mocks) and the **iOS app**
(`WillItRain/`, tested with XCTest, hosted so it can assert on the real build product). There is no
shared test runner and no end-to-end harness that drives both together — the two sides are
integrated only by the DEVICE_TOKEN/HTTP contract, which is currently verified manually
([Appendix A](#appendix-a-production-ops--notification-testing-runbook), section C) rather than by
an automated contract test. See section 3 for what that leaves unguarded.

```
        ▲  Manual/exploratory (section 6): release-eve device pass, Live Activity states
       ╱ ╲ E2E (section 5): none automated — App Store Connect TestFlight is the closest thing
      ╱   ╲
     ╱     ╲ Integration/contract (section 3): abuse.test.ts drives the real fetch handler +
    ╱       ╲ real Durable Object classes over mocked KV; iOS has none against a live backend
   ╱─────────╲
  ╱  Unit      ╲ backend: abuse.ts, grid.ts (partial), nextHour.ts; iOS: ForecastMerge + period
 ╱   (§2)       ╲ detection, the alert gate, RainForecast readings, CLLocationManager, Info.plist
```

The backend pyramid is inverted relative to a typical service: there is effectively one large,
high-value integration suite (`abuse.test.ts`, 59 tests exercising `index.ts`'s real `fetch`
handler end-to-end, plus `cron-alerts.test.ts` through `scheduled()`) and very little narrow unit
coverage of the pure helper modules underneath it (`next-hour.test.ts` is the exception). The iOS
pyramid is the opposite problem — five small, genuinely unit-level suites and no
integration coverage of the services that talk to WeatherKit, APNs tokens, or the backend.

## 2. Unit tests

### What exists

| Area | File | Runner | Covers |
|---|---|---|---|
| Backend abuse gate | `backend/test/abuse.test.ts` | Vitest | Rate limiting, grid-cell/device caps, TTL/rewrite-cooldown logic, cron push-budget math, re-registration semantics, content-type validation — see the `describe()` list in section 4 |
| Backend cron alert gating | `backend/test/cron-alerts.test.ts` | Vitest | Who gets a rain-start / rain-end alert and when, through the real `scheduled()` with stubbed WeatherKit and APNs |
| Backend Live Activity payload | `backend/test/live-activity.test.ts` | Vitest | `precipFromForecast` (summary → `rain`/`wintry`), that every `liveactivity` push the cron sends carries `precip` and matching copy, the `/test-activity` endpoint (401/404/409/200, legacy no-`precip` payload, `end`), `/test-cron` `dryRun` diagnostics, and that all three `/test-*` routes 401 without `ADMIN_TOKEN` |
| Backend validators | `backend/test/validate.test.ts` | Vitest | Each predicate in `validate.ts` in isolation (token shapes, coordinate bounds, lead-time clamp, `asBoolean`, `secureEquals`) — synthetic tokens only |
| Backend test harnesses | `backend/test/kvMock.ts`, `backend/test/doMock.ts` | — | In-memory KV (with expiry + stale-read simulation) and a Durable Object namespace mock that runs the *real* `CoverageRegistry`/`RegistrationLimiter` classes, not stubs |
| Backend cron alerts | `backend/test/cron-alerts.test.ts` | Vitest | The real `scheduled()` handler with WeatherKit and APNs stubbed: which device is alerted at which minute (lead-time gate, 30-minute repeat suppression, per-device opt-outs, rain-end window), the hourly fallback where there is no minute forecast, and the terminal Live Activity update at the tick after a wet hour ends |
| Backend next-hour series | `backend/test/next-hour.test.ts` | Vitest | `nextHourMinutes`: a real `forecastNextHour` passes through untouched; otherwise the minute series synthesized from `forecastHourly`, starting one cron interval before now and bounded by the readings on hand |
| iOS forecast model | `WillItRain/WillItRainTests/RainForecastTests.swift` | XCTest | `PrecipitationIntensity.from(millimetersPerHour:)` thresholds and `Comparable` ordering, `PrecipitationPeriod.contains`, type icons, `PrecipitationType.isWintry` and the `.mixed` copy, and `RainForecast`'s time-dependent readings (current/next period, hero status copy, poll interval) at a given instant |
| iOS forecast merge | `WillItRain/WillItRainTests/ForecastMergeTests.swift` | XCTest | `ForecastMerge.merge(minute:hourly:now:)` at fixed instants and `PrecipitationPeriod.detect(in:)` on the merged series: which hourly reading is kept and how it is clipped, `hasMinuteForecast`, and which periods are `isConfirmed` (see section 4) |
| iOS alert gate | `WillItRain/WillItRainTests/NotificationServiceTests.swift` | XCTest | Every path through `NotificationService.evaluateAndSchedule` at explicit instants with delivery recorded and settings in an isolated `UserDefaults` suite: two-pass rain-start and rain-end confirmation, same-event suppression, rain resuming within the hour, quiet hours, opt-outs, hourly-only and unconfirmed-nowcast periods |
| iOS Live Activity payload | `WillItRain/WillItRainTests/RainActivityAttributesTests.swift` | XCTest | The `content-state` wire contract: a payload with no `precip` key decodes (the Optional-field guarantee) and renders as rain; `LAStyle.of` picks wintry only for `wintry`; the DEBUG scenarios carry the `precip` their codes promise (`BX` = none) |
| iOS Live Activity content | `WillItRain/WillItRainTests/LiveActivityServiceTests.swift` | XCTest | `LiveActivityService.makeState` per design state: which period types resolve to `precip: .wintry`, the wintry copy, and that every state the app builds carries `precip` |
| iOS location service | `WillItRain/WillItRainTests/LocationServiceTests.swift` | XCTest | `LocationService.currentLocation()` against a stubbed `CLLocationManager`, including the stuck-continuation regression (see section 4) |
| iOS build product | `WillItRain/WillItRainTests/BuildProductTests.swift` | XCTest | Generated `Info.plist` keys: portrait lock, bundle ID, display name, Live Activity entitlement flags, background task ID, location usage strings, version keys present, and the deployment floor (`MinimumOSVersion`) on the app and on the embedded widget appex, asserted equal so the two cannot drift apart |

### What is missing

- **Backend:** `weatherkit.ts` (WeatherKit REST parsing and the request it builds) and `apns.ts`
  (`sendRainAlert`/`sendRainEndAlert` payload shaping, APNs error-code handling — 410/BadDeviceToken
  — and response handling) have no unit tests of their own — `cron-alerts.test.ts` and
  `live-activity.test.ts` reach them only through the real `scheduled()` handler with WeatherKit and
  APNs stubbed (asserting on the request APNs would receive, not on how a non-200 reply is handled),
  and `abuse.test.ts`'s "cron fan-out budget" `describe` blocks test the *budget arithmetic*
  (`createPushBudget`, imported from `abuse.ts`). `validate.ts` (payload validation) is exercised
  only indirectly through `/register` HTTP calls, not with direct unit cases per validator.
- **iOS:** `WeatherService.swift` (WeatherKit fetch, `findPrecipitationPeriods`, precipitation-type
  mapping — including the `.mixed` → `.mixed` mapping this release adds; the minute/hourly merge
  itself is the pure `ForecastMerge.merge(minute:hourly:now:)`, covered together with
  `PrecipitationPeriod.detect(in:)` by `ForecastMergeTests.swift`; the WeatherKit-to-`ChartDataPoint`
  mapping that feeds them is not), `NotificationService`'s delivery, and `PushRegistrationService.swift`
  (token storage, `registerLocation`, Live Activity token register/unregister) have no unit tests.
  `LiveActivityService` is covered for `makeState` only; `sync` (ActivityKit start/update/end) is
  not. No view-level (`ViewInspector`-style or snapshot) tests exist for `ContentView`,
  `SettingsView`, `RainChartView`, or the widget/Live Activity views, so the wintry palette and the
  track geometry are checked by eye via `scripts/test-live-activity.sh` (section 6).

### Naming and location conventions

- Backend: one `*.test.ts` per concern under `backend/test/`, named for the thing under test
  (`abuse.test.ts`) rather than the source file 1:1 — a new `weatherkit.test.ts` /
  `apns.test.ts` per module is the natural split for the gap above. `describe()` blocks are named
  as plain-English scenarios ("the 250-registrations-in-0.47s flood"), not method names — keep
  this style, it is what makes the regression catalog in section 4 legible.
- iOS: one `XCTestCase` subclass per source file under test, named `<Subject>Tests.swift` in
  `WillItRain/WillItRainTests/`, hosted in the app target (required for `BuildProductTests` to see
  the real `Bundle.main`, and for `@testable import WillItRain` elsewhere).

### How to run

- Backend: `cd backend && npm test` (Vitest) or `npm run typecheck` for the TS gate. Both are
  npm-dependency-free at runtime (see [`AGENTS.md`](AGENTS.md)).
- iOS: `xcodebuild build-for-testing … && xcodebuild test-without-building …` per the headless
  invocation already documented in [`AGENTS.md`](AGENTS.md) ("Local headless verification") — do
  not repeat those flags here, that section is the source of truth.

## 3. Integration and contract tests

| Boundary | Real or mocked today | Notes |
|---|---|---|
| Worker HTTP handler (`index.ts`) ↔ KV | Real handler, mocked KV (`kvMock.ts`) | `abuse.test.ts` calls `worker.fetch(...)` directly — this is a real integration test of routing + validation + the abuse gate, just against an in-memory KV |
| Worker ↔ Durable Objects | Real handler, real DO classes, mocked DO runtime (`doMock.ts`) | Deliberately models single-instance-per-name and serialized delivery so the 250-concurrent-registration flood test exercises genuine interleaving |
| Worker ↔ WeatherKit REST | **Untested** | No fixture/contract test pins the WeatherKit response shape the Worker's cron parses; a schema change upstream would only surface in production `wrangler tail` logs |
| Worker ↔ APNs | Real handler, stubbed `fetch`; delivery verified manually | `cron-alerts.test.ts` and `live-activity.test.ts` assert on the exact request the Worker would send APNs (host path = token, `apns-push-type`, `content-state` body), so a payload-shape drift fails in CI. Whether APNs *accepts* it — and that a card on a real phone re-styles — still needs [Appendix A section C](#appendix-a-production-ops--notification-testing-runbook) / `scripts/test-activity-push.sh` with `ADMIN_TOKEN` and a live device |
| iOS app ↔ Worker (`/register`, `/register-activity`, `/unregister*`) | **Untested** | No iOS test mocks `PushRegistrationService`'s `URLSession` calls; no backend test simulates the exact payload shapes `PushRegistrationService.swift` sends. A shape drift on either side (e.g. a renamed JSON field) is caught by neither suite |
| iOS app ↔ WeatherKit | **Untested** | `WeatherService.swift` calls `WeatherKit.WeatherService.shared` directly with no protocol seam to inject a fake, unlike `LocationService`'s `CLLocationManager` stub pattern |
| iOS app ↔ APNs device token | Untested | Token capture (`storeToken`) and the resulting `/register` call are unverified together |

The backend's approach — run the real production code against a realistic in-memory
double of the *stateful* dependency (KV, DO) rather than mocking the code under test — is the
right pattern and should be extended to `weatherkit.ts` and `apns.ts` (inject a fake `fetch`,
assert on the request built and the response parsed) rather than reached for network mocking
libraries. The iOS side has no equivalent seam for `WeatherService` or `PushRegistrationService`
yet; `LocationService`'s subclassed-`CLLocationManager` stub (`LocationServiceTests.swift`) is the
existing precedent to follow when adding one.

## 4. Regression catalog

Built from `git log --oneline` fix commits and PRs. "Guarding test" names the test that would fail
if the bug came back; `UNGUARDED` means no such test exists today.

| Fix commit | Bug | Guarding test |
|---|---|---|
| `423acc9` fix(backend): bound registration abuse with DO caps and Free-plan budgets | Unauthenticated `/register` allowed unlimited grid-cell/device growth, spending the WeatherKit and APNs subrequest budget on abuse rather than real users | `abuse.test.ts` → `describe('the 250-registrations-in-0.47s flood')`, `describe('grid-cell cap')`, `describe('per-client rate limit')` |
| `0248bec` Move abuse gate to Durable Objects; rederive caps for Free plan | A KV-counter-based gate cannot see a sub-second burst (60s read floor) | `abuse.test.ts` via `doMock.ts`'s serialized-delivery model — the flood test would pass falsely against a naive KV counter |
| `78bdac1` Fix location continuation race | `LocationService.currentLocation()` could leave its `CheckedContinuation` unresumed forever under a specific delegate-callback ordering | `LocationServiceTests.swift` — the file's own header notes the test polls rather than awaits specifically so this hang fails instead of hanging CI |
| `8d7fd8f` Never defer cell moves, always unmute on re-register | A device moving to a new grid cell was silently held back by the same-cell settings-cooldown, leaving it unalerted after a real move | `abuse.test.ts` → `describe('re-registration')` |
| `55eec51` / `2393831` / `13856e4` (no-mistakes review series) Skip redundant writes, budget cron reaps, queue dead-token reaps | Free-plan KV daily write/delete allowances could be exhausted by redundant rewrites or unbounded reap loops | `abuse.test.ts` → `describe('registration records expire')`, `describe('the cron fan-out budget')` |
| `9eb05b2` fix(WillItRain): lock app to portrait and bump to 1.1.1 (6) | Regression risk: `GENERATE_INFOPLIST_FILE` merging could silently drop the orientation lock on a build-setting change | `BuildProductTests.testAppIsLockedToPortrait` |
| `a4f6392` Fix Apple Weather attribution to use apple.logo per guideline 5.2.5 | Non-compliant attribution risked App Store rejection under WeatherKit guideline 5.2.5 | **UNGUARDED** — no test asserts the attribution view renders `apple.logo`; only a manual screenshot (`screenshots/notifications/notification-copy-*.png`, per [Appendix A](#appendix-a-production-ops--notification-testing-runbook)) exists |
| `4d4fd90` fix Live Activity countdown overflow | Countdown arithmetic could overflow/underflow near the end of a rain window | **UNGUARDED** — no unit test on `RainActivityAttributes.ContentState` countdown math |
| `a75f28d` fix rain-status detection + server-side rain-end push | On-device rain-status detection and the server's rain-end push could disagree | **UNGUARDED** for the server side (no `apns.ts` test, per section 3); partially covered on-device via `RainForecastTests.swift`'s intensity tests, but not the specific detection bug |
| `d0f0452` Fix chart x-axis timestamps to show full h:mm format | Chart labels dropped the hour or minute component under certain timestamps | **UNGUARDED** — `RainChartView` has no tests |
| `14611e1` Fix chart touch offset, show rain duration, fix precip type mapping | Touch-position-to-data-point mapping and precip-type mapping were both wrong | **UNGUARDED** — no `WeatherService` precip-type-mapping test (the gap noted in section 2) |
| `01bbbf6` Fix background refresh by configuring Info.plist correctly | `BGTaskSchedulerPermittedIdentifiers` missing/wrong broke background refresh silently | `BuildProductTests.testBackgroundRefreshTaskRegistered` |
| `28d14a2` Fix push registration timing: wait for APNs token before registering | A race could register a device before its APNs token was captured | **UNGUARDED** — no `PushRegistrationService` test (per section 3) |
| fix: hourly fallback where WeatherKit has no minute forecast, and keep the hourly reading containing now + 1h (edge-case report finding 10) | The minute/hourly merge cut at a hard now + 1h: with no minute forecast the series began an hour out and the hole never closed (never "raining", no rain-start alert possible at any lead time, and the cron returned early on the same boundary); with minute data the hourly reading for the hour the minute data ends in was dropped (at 10:05, 11:00 fell and 12:00 was next) | `ForecastMergeTests.swift` (`testTheHourlyReadingContainingNowPlusOneHourIsKept`, `testLateInTheHourNoMinuteReadingIsLostToTheHourlyReading`, `testWithoutMinuteDataTheSeriesStartsAtTheHourContainingNow`, `testWithoutMinuteDataRainNextHourIsInsideTheLongestLeadTime`, `testALagSliverBetweenTheNowcastAndTheNextHourDoesNotConfirmIt`), `NotificationServiceTests.swift` → `testHourlyOnlyRainNextHourGoesThroughTheLeadTimeGate`, `testAWetHourTheNowcastHasNotReachedIsNotAlertedOnPollAfterPoll`, `testAWetHourFurtherOutStaysConfirmedUntilTheNowcastBordersItAndIsNeverAlertedOnUnseen`; backend `next-hour.test.ts` and `cron-alerts.test.ts` → `reach devices where WeatherKit has no minute forecast`, `end the activity at the tick after a wet hour ends` |
| 1.1.2 (hand-port of #8) Live Activity track alignment | The rail and its segments carried `.offset(y: 6)` inside the 16pt track frame, so the track ran 6pt *below* the "now" dot and the hour dots on every card (rain included) since 1.1 | **UNGUARDED** — a view-geometry fix with no snapshot test; checked by eye in M6 via `scripts/test-live-activity.sh` ("the rail runs through the dots") |
| 1.1.2 (hand-port of #8) Worker must send `precip` on every Live Activity push | `content-state` is a full replacement, so one push without `precip` reverts a snowing card to rain within a cron tick | `live-activity.test.ts` → `describe('the cron pushes precip on every Live Activity update')` → "never sends a Live Activity payload without precip"; TypeScript also refuses a `LiveActivityContentState` literal that omits it |
| 1.1.2 (hand-port of #8) `precip` must stay `Optional` on the widget side | A non-optional field makes ActivityKit fail to decode any push from an older Worker; the card freezes with no error | `RainActivityAttributesTests.testPayloadWithoutPrecipStillDecodesAndRendersAsRain`; on-device: `scripts/test-activity-push.sh` step 3 ("legacy") must leave the countdown ticking |
| 1.1.2 (hand-port of #8) WeatherKit `.mixed` mapped to rain | `WeatherService.precipitationType(from:)` sent `.mixed` down the `default: .rain` path, so wintry mix drew rain visuals and rain copy | `RainForecastTests.testMixedPrecipitationIsWintryAndHasItsOwnCopy`, `LiveActivityServiceTests.testEveryIcyTypeIsWintryAndRainIsNot`; the WeatherKit→model mapping itself is still **UNGUARDED** (no `WeatherService` seam, section 3) |

**Rule for future fixes:** every commit whose message starts `fix:`/`fix(...)` or is tagged
`hotfix` must add or extend a test in the same PR that fails on the pre-fix code, named for the
scenario (not the internal method), and recorded as a new row in this table. A fix that cannot be
covered by an automated test (e.g. it requires live APNs/WeatherKit) must instead add or update a
step in [section 6](#6-manual-and-exploratory-test-plan) and say so in the PR description — never
land a fix with no row here and no manual step.

## 5. End-to-end and UI tests

There is no automated E2E suite (no XCUITest target, no Playwright/Puppeteer-driven web
surface — the Worker has no UI). The closest thing to E2E today is manual: TestFlight builds plus
the [Appendix A](#appendix-a-production-ops--notification-testing-runbook) production push flow
(`/test-rain`, `/test-cron`, and `/test-activity` via `scripts/test-activity-push.sh`) against a
real device.

If UI automation is added, it needs:

- **Simulator:** iPhone 17 Pro (the CI/local convention already fixed by [`AGENTS.md`](AGENTS.md)). No other simulator has been validated against the Dynamic Island/Live Activity capture traps documented in `WillItRain/Design/AppIcon/capture-icon-shots.sh`.
- **Physical device (recommended, not required by CI):** Live Activity APNs delivery, background refresh, and Dynamic Island behavior are only fully representative on hardware; the simulator cannot receive real push notifications at all.
- **No browser targets** — the backend is a headless Worker API with no served UI.

This is listed as a backlog item in section 11, not implemented here, per the docs-only scope of
this PR.

## 6. Manual and exploratory test plan

Run before every TestFlight/App Store submission. Each scenario names its expected result; a
failure blocks the release.

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| M1 | Portrait lock | Rotate device/simulator to landscape while app is foregrounded | UI does not rotate (guards `9eb05b2`) |
| M2 | Cold-launch registration | Fresh install, grant location, background app immediately | `/register` fires with the real device token — confirm via [Appendix A section B](#appendix-a-production-ops--notification-testing-runbook) |
| M3 | Foreground re-registration | Bring app to foreground after being backgrounded >7 days worth of simulated time (or just confirm the call fires) | A re-registration call is made on `willEnterForeground` (per [`AGENTS.md`](AGENTS.md)'s TTL-renewal note) |
| M4 | Location-move re-registration | Move (or simulate location change) >10 km from the registered point | New registration lands in the new grid cell; old cell's alert stops (per `LocationService` re-registration rule in `AGENTS.md`) |
| M5 | Real push delivery | Run [Appendix A section C](#appendix-a-production-ops--notification-testing-runbook)'s `/test-rain` curl against your own registered token | Phone receives the push; payload matches `NotificationService.swift`'s expected format |
| M6 | Live Activity states, rain and wintry | Run `scripts/test-live-activity.sh` (Debug build; drives `-liveActivityScenario A,B,C,AS,BS,CS,BX` and the `-liveActivityCards` screen; see the harness notes below) | A/B/C render per `docs/design/live-activity/v3-final.png` (cyan, droplet); AS/BS/CS per `snow-mockup-v3.html` variant W1b (near-white track, white glow, snowflake in the island, app-icon badge unchanged); the rail runs *through* the "now" dot and hour dots on every card (guards the 1.1.2 track fix, section 4); **BX is pixel-identical to B with a ticking countdown**; no clipped/overflowing countdown text (guards `4d4fd90`) |
| M7 | Dynamic Island expanded capture | Long-press the Live Activity; screenshot **while the press is held** | Expanded presentation renders correctly — see the trap documented in `capture-icon-shots.sh` and `AGENTS.md`'s "Driving the iOS Simulator" section (collapses the instant the press releases) |
| M8 | First-unlock Live Activity consent sheet | Trigger the first Live Activity after a fresh unlock | "Allow Live Activities from …?" sheet appears and is dismissable without breaking the card underneath |
| M9 | Weekly forecast view | Open the weekly forecast from the main screen | Renders 7 days, no missing/duplicate days, matches VISION.md's framing of "the weekly view exists to frame the hour" |
| M10 | Attribution persistence | View every screen/state that shows weather data | Apple Weather attribution (`apple.logo`) is visible and legible in all states, per guideline 5.2.5 (guards `a4f6392` — currently the only guard for that fix, see section 4) |
| M11 | Notification copy review | Trigger a rain-start and a rain-end notification | Copy matches the reviewed strings in `screenshots/notifications/notification-copy-*.png` |
| M12 | Accessibility pass | See section 9 | — |
| M13 | Widget rendering | Add small and medium widgets to the Home Screen | Both render current forecast without truncation or placeholder data |
| M14 | Abuse-gate symptom spot-check | Deliberately trigger one 503 (`coverage_at_capacity` or `cell_at_capacity`) against a non-production or disposable registration | Response matches the symptom table in [Appendix A section G](#appendix-a-production-ops--notification-testing-runbook); confirms the gate is live in the deployed environment, not just in `abuse.test.ts` |
| M15 | Hourly-only forecast state | Set a custom simulator location (Features > Location > Custom Location…) in a country without next-hour precipitation on Apple's iOS feature-availability page, then background and foreground the app so it re-fetches | The line "Minute-by-minute forecast isn't available here; showing hourly" appears above the charts, there is no "Next Hour" chart section, the hourly chart starts at the hour containing now rather than an hour out, and the hero line reads off the hourly data (`ForecastMergeTests` guards the model — see the hourly-fallback row in section 4 — but nothing renders this state) |
| M16 | Server → Live Activity push | Start scenario `BS` on a Debug build on a real device, then run `scripts/test-activity-push.sh <device-token>` with `ADMIN_TOKEN` set (its header explains how to find both tokens) | Push 1 turns the card pale with a snowflake and "Snow incoming"; push 2 turns it cyan with "Rain incoming"; push 3 (no `precip` in the payload) renders as rain **and the countdown keeps ticking** — a frozen card there means the field went non-optional |
| M17 | WeatherKit summary still carries a condition | `backend/test/probe-weatherkit-summary.sh` with `ADMIN_TOKEN` (uses `/test-cron` `dryRun`, so no push and no device needed) | Every covered coordinate returns a non-null `summary` of lowercase bare nouns and a `precip`; uncovered coordinates return `summary: null`, `precip: "rain"`, no error. If `summary` ever goes absent for a covered location, snow renders as rain everywhere |

**Live Activity harness notes** (each of these cost real time to find; the scripts encode them,
this is why):

- The scenario harness and the `-liveActivityCards` screen are behind `#if DEBUG`. A **Release**
  build strips both and the app launches normally while silently starting no activity.
- App `print()` does not reach most log wrappers — the scripts use
  `xcrun simctl launch --console-pty`.
- The compact island only renders while the app is **backgrounded**, so the script launches a
  filler app to take the foreground. It avoids Settings on purpose: Settings can land on an
  Apple Account sign-in sheet and put an email and password field into every screenshot.
- The lock-screen card is where the whole wintry palette lives (track, glow, now-dot ring); the
  island shows only a glyph and a countdown. The real lock screen is unreachable from a script
  (`simctl` has no lock command), so the card renders in-app from the same views the widget uses
  (`Shared/LiveActivityCardViews.swift`) — everything inside the card is the widget's code, the
  system chrome around it is not.
- Scenario `BX` sends a payload with `precip` **absent**, standing in for a Worker that predates
  the field. If it renders as snow the default is inverted; if the card freezes, someone made the
  field non-optional and ActivityKit can no longer decode.
- `simctl` cannot overwrite a screenshot a *different* process created (a `com.apple.macl` ACL,
  failing with EPERM that `ls` gives no hint of); the script unlinks each target first.
- The script opens Simulator.app — it is GUI capture work in the sense of
  [`AGENTS.md`](AGENTS.md) "Driving the iOS Simulator" — and its captures land in the gitignored
  `screenshots/live-activity/`. Attach them to the PR; do not commit them.

## 7. Performance and load

| Budget | Value | Enforced by | Measured by |
|---|---|---|---|
| External subrequests per cron invocation (Free plan hard cap: 50) | 15 WeatherKit fetches + `PUSH_BUDGET_PER_INVOCATION` (34) APNs pushes ≤ 50 | `backend/src/abuse.ts` constants (`MAX_GRID_CELLS`, `PUSH_BUDGET_PER_INVOCATION`) | `abuse.test.ts` → `describe('the cron fan-out budget')`, `describe('a cron tick that wants more pushes than the plan allows')` — asserts the arithmetic, not a live invocation |
| Grid-cell capacity | `MAX_GRID_CELLS` = 15 | `abuse.ts` | `abuse.test.ts` → `describe('grid-cell cap')` |
| Devices per cell | `MAX_DEVICES_PER_CELL` = 20 | `abuse.ts` | Same suite |
| Per-client registration rate | `RATE_LIMIT_MAX_REQUESTS` (20) per `RATE_LIMIT_WINDOW_SECONDS` (600) | `abuse.ts` via Durable Object | `abuse.test.ts` → `describe('per-client rate limit')`, and the 250-in-0.47s flood test |
| Internal (KV/DO) subrequests per invocation | `INTERNAL_SUBREQUEST_CEILING` = 1,000, modeled by `INTERNAL_SUBREQUESTS_PER_TICK_FIXED` + per-device/per-push/per-reap constants | `abuse.ts` | Same suite; see [`AGENTS.md`](AGENTS.md) for the full derivation and why it must be re-run before touching the cron schedule or grid precision |
| Daily KV allowances (Free plan: 100k reads, 1k writes/deletes/lists) | Sized by `MAX_TTL_MIGRATIONS_PER_TICK` (5), `MAX_DEVICE_REAPS_PER_TICK` (2), `DEVICE_RECORD_REFRESH_SECONDS` (7d), `DEVICE_REWRITE_COOLDOWN_SECONDS` (5m) | `abuse.ts` | `abuse.test.ts` → `describe('registration records expire')`; no test currently sums a simulated day's worth of ticks against the 1,000-write/delete ceilings directly (see backlog, section 11) |
| WeatherKit quota | Cross-check only — a full service at these caps uses ~13% of quota | — | Not test-enforced; monitor via Apple's WeatherKit usage dashboard if this ever becomes the binding constraint |

There is no load test against a live deployment (`wrangler dev` or production) — all of the above
is verified as arithmetic/unit assertions against mocks, which is appropriate for a Free-plan
Worker where an actual load test would itself burn the scarce subrequest budget it's trying to
protect.

## 8. Security and privacy checks

| Concern | Status | Where |
|---|---|---|
| `/register`, `/register-activity` are unauthenticated by construction (Worker URL ships in the app binary; APNs tokens aren't server-verifiable) | Accepted, bounded by the abuse gate rather than auth | [`AGENTS.md`](AGENTS.md) "Backend Worker"; `abuse.test.ts` covers the gate |
| `/test-rain`, `/test-cron`, `/test-activity` (real-push, real-WeatherKit-quota debug endpoints) | Gated by `X-Admin-Token` against the `ADMIN_TOKEN` Worker secret | [Appendix A section C](#appendix-a-production-ops--notification-testing-runbook); `live-activity.test.ts` → `describe('/test-activity')` asserts all three return 401 on a missing or wrong header and fail closed when no `ADMIN_TOKEN` is configured |
| Secrets at rest | `APNS_ENV`, `ADMIN_TOKEN` are Wrangler secrets, not env vars or committed config; never written to this file (Appendix A explicitly says "never in this file") | `wrangler secret put` per Appendix A sections C, E |
| Device data at rest | KV stores lat/lon/token/settings with a 45-day TTL (`DEVICE_RECORD_TTL_SECONDS`); no PII beyond coordinates and an opaque device token | `backend/src/types.ts` `DeviceRegistration`; TTL behavior covered by `abuse.test.ts` → `describe('registration records expire')` |
| Input validation | `validate.ts` checks token format (64–128 hex), content-type | `abuse.test.ts` → `describe('content type')`; each validator in isolation in `validate.test.ts` (section 2) |
| Abuse limits (flood, per-client, per-cell) | Covered — see sections 4, 7 | `abuse.test.ts` |
| iOS location data | Only sent to this project's own Worker over HTTPS; no third-party analytics/tracking SDK present in `Package.swift`/project deps (confirm on any dependency addition) | Verify manually if dependencies change — not currently automated |
| App Transport Security | Default ATS (no exceptions found in Info.plist build settings) | Spot-check `INFOPLIST_KEY_*` in the pbxproj on release |

## 9. Accessibility

No automated accessibility tests exist (no `XCUIApplication` accessibility audit, no
`XCTAssert` against Dynamic Type/VoiceOver). Manual checks for the release checklist:

| Check | How |
|---|---|
| Dynamic Type | Set the simulator/device to the largest accessibility text size; confirm `RainStatusView`, `WeeklyForecastView`, and the Live Activity card (`RainLiveActivity.swift`) do not truncate or overlap |
| VoiceOver | Enable VoiceOver, swipe through `ContentView` and `SettingsView`; every control must have a label announced |
| Contrast | Check the drift-scatter icon and in-app color palette in both light and dark mode, especially the Live Activity's cyan rain-segment track against the lock-screen background (per the "wintry palette" work in git history, e.g. `47d0cf1`) |
| Reduce Motion | If `Animations/` contains any looping/parallax effect, confirm it respects `UIAccessibility.isReduceMotionEnabled` |

This is a real gap relative to sections 2–4: there is no regression guard for any of these, so an
accessibility regression is caught only if a human runs this table before release.

## 10. Release checklist

| Gate | CI-enforced today? | Where |
|---|---|---|
| Backend typecheck (`npm run typecheck`) | ✅ CI | `.github/workflows/ci.yml` backend job |
| Backend tests (`npm test`) | ✅ CI | Same |
| iOS unsigned simulator build | ✅ CI | `.github/workflows/ci.yml` iOS job |
| iOS unit tests (headless, iPhone 17 Pro) | ✅ CI | Same |
| `xcodebuild ... build-for-testing` / `test-without-building` locally before pushing | Manual (recommended) | [`AGENTS.md`](AGENTS.md) "Build & test" |
| `npx wrangler deploy --dry-run` | Manual (recommended), not in CI | [`AGENTS.md`](AGENTS.md) "Backend Worker" |
| Manual scenarios (section 6) | ❌ Manual only | This document |
| Accessibility pass (section 9) | ❌ Manual only | This document |
| App Store submission checklist (below) | ❌ Manual only | This document |
| Regression catalog reviewed for new UNGUARDED rows on this release's fixes (section 4) | ❌ Manual only | This document |

### App Store submission checklist

- [ ] `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` bumped in the pbxproj (currently 1.1.2 / 7)
      and matches the intended release notes.
- [ ] **Worker deployed before the build reaches users** whenever the release changes
      `LiveActivityContentState` (1.1.2 adds `precip`). `content-state` is a full replacement, so
      an older Worker's next cron tick strips the new field and, for 1.1.2, turns a snowing card
      cyan within ten minutes. Deploying is a human decision, never an agent's.
- [ ] `BuildProductTests` green on the actual archive configuration, not just Debug/simulator
      (Info.plist merging can differ by configuration).
- [ ] Deployment floor unchanged since the last release, or the listing's "Requires iOS …" line
      and the release notes say so — raising it drops devices that could install the previous
      build. The floor is `IPHONEOS_DEPLOYMENT_TARGET`, set at the project level in the pbxproj
      with no per-target overrides; guarded by `BuildProductTests`.
- [ ] WeatherKit attribution present and correct in every weather-showing state (M10) — guideline
      5.2.5 was a prior rejection risk (`a4f6392`).
- [ ] Live Activity / Dynamic Island entitlements present (`NSSupportsLiveActivities`,
      `NSSupportsLiveActivitiesFrequentUpdates`) — guarded by `BuildProductTests`.
- [ ] Location usage strings (`NSLocationWhenInUseUsageDescription`,
      `NSLocationAlwaysAndWhenInUseUsageDescription`) present and accurately describe the
      lock-screen-alert use case — guarded by `BuildProductTests`, but wording accuracy needs a
      human read.
- [ ] Background refresh task ID registered — guarded by `BuildProductTests`.
- [ ] Portrait lock intact — guarded by `BuildProductTests`.
- [ ] App icon catalogue regenerated from `AppIcon.svg` via `render_appicon.py` if the icon
      changed, and `verify_mark.py` passes (per [`AGENTS.md`](AGENTS.md) "App icon").
- [ ] Backend deployed and `/test-rain`, `/test-cron` confirmed working against the release
      build's registered tokens ([Appendix A section C](#appendix-a-production-ops--notification-testing-runbook)).
- [ ] Junk/placeholder KV registrations pruned if they're occupying grid-cell capacity
      ([Appendix A section F](#appendix-a-production-ops--notification-testing-runbook)).
- [ ] Screenshots/App Store listing copy reflect the current notification wording
      (`screenshots/notifications/notification-copy-*.png`).
- [ ] Accessibility pass (section 9) completed for this release.
- [ ] Known-gaps list in [Appendix A](#appendix-a-production-ops--notification-testing-runbook)
      reviewed — confirm nothing there became release-blocking.

## 11. Gaps and prioritized backlog

Ordered by risk × how cheap the fix is; effort is rough.

| Priority | Gap | Risk if unaddressed | Effort |
|---|---|---|---|
| P0 | No unit tests for `apns.ts` (payload shaping, APNs error-code handling: 410/BadDeviceToken paths) | A regression in dead-token cleanup or payload shape ships undetected until production logs show it — this is exactly the class of bug section 4 already lists as UNGUARDED twice | S–M: inject a fake `fetch`, assert request/response handling per status code |
| P0 | No unit tests for `weatherkit.ts` | An upstream WeatherKit schema change silently breaks forecasts; no fixture pins the expected shape | S: fixture-based parse test |
| P1 | No `PushRegistrationService`/`WeatherService` tests on iOS (no protocol seam for `WeatherKit.WeatherService.shared` or `URLSession`) | Same class of silent breakage as above, client-side; also leaves `28d14a2`'s timing fix and `14611e1`'s precip-type mapping fix unguarded | M: introduce a protocol seam (same pattern as `LocationServiceTests.swift`'s `CLLocationManager` subclass) |
| P1 | No test for `PrecipitationPeriod.detect(in:)` or the chart-data-point pipeline | Chart/period-detection regressions (two of which already happened: `d0f0452`, `14611e1`) have no guard | S–M |
| P2 | No 401-without-`X-Admin-Token` test for `/test-rain`/`/test-cron` | A future refactor could accidentally leave the debug endpoints open, burning WeatherKit/APNs quota | S: add to `abuse.test.ts` |
| P2 | No `validate.test.ts` isolating each validator | Validation bugs are only caught through full-HTTP integration tests, making failures harder to localize | S |
| P2 | No snapshot/geometry test for the Live Activity views | The 1.1.2 track-alignment fix (section 4) and the wintry palette are checked only by eye in M6 | M: a `ImageRenderer`-based snapshot of `LockScreenActivityView` per scenario in the app-hosted test target |
| P2 | No test simulating a full day's cron ticks against the 1,000 daily KV write/delete ceilings | A schedule or cap change could pass the per-invocation test yet still blow the daily budget (the exact multi-bucket risk `AGENTS.md` calls out) | M |
| P3 | No accessibility or Dynamic Type automation | Regressions caught only by the manual pass (section 9) | M–L: `XCUIApplication` accessibility audit as a start |
| P3 | No E2E/XCUITest automation of the manual scenarios in section 6 | Every release depends on a human running every section 6 scenario by hand | L: would need simulator/device time explicitly out of scope for this PR's no-GUI constraint |
| P3 | No automated contract test for the iOS↔Worker JSON payload shape | A field rename on either side is caught only by manual testing or production failure | M: a schema shared or asserted on both sides |

## 12. Running everything headlessly, in one place

`./scripts/test-headless.sh` runs all of the below in order (`backend` or `ios` as its argument
runs one half); it is also the `commands.test` of `.no-mistakes.yaml`, so the no-mistakes test
step runs this rather than an exploratory agent. It picks a shut-down iPhone 17 Pro by UDID,
boots it, waits, tests, and shuts it down again. The individual commands, for reference:

```bash
./scripts/test-headless.sh            # backend + iOS
./scripts/test-headless.sh backend    # npm ci, typecheck, vitest, wrangler deploy --dry-run
./scripts/test-headless.sh ios        # build-for-testing, then test-without-building on iPhone 17 Pro
```

The script boots a shut-down `iPhone 17 Pro` by UDID, waits for it to settle, and shuts that one
device down afterwards; its header documents the simulator traps it works around. It is also what
the no-mistakes test step runs (`.no-mistakes.yaml`). The raw `xcodebuild` invocation stays in
[`AGENTS.md`](AGENTS.md) "Build & test".

CI runs the backend and iOS jobs automatically on every push/PR to `main`
(`.github/workflows/ci.yml`); everything else in sections 5, 6, 9, and the App Store checklist in
section 10 is manual today, per the backlog in section 11.

---

## Appendix A: Production Ops & Notification Testing Runbook

_Written 2026-07-24 for Release 2. This is the original `TESTING.md` in full, preserved as
operational reference (see the note at the top of this document for why it is kept rather than
replaced)._

### ⚠️ Read this first — the `--remote` gotcha

`wrangler kv key list --namespace-id <id>` **reads your LOCAL sim state, not
production**, so it returns `[]` even when production is full. **Always add
`--remote`.** This is what made it look like no devices were registered.

**Reality (checked from inside the Worker): registration works — ~15 devices are
registered in production.** Nothing is broken.

---

### Key facts

- **Worker:** `https://will-it-rain.albertwxu.workers.dev`, cron every 10 min.
- **KV namespace `DEVICES`:** `142615e17bc84dc7adbd9e64d0b29410`.
- **`APNS_ENV` is set as a Worker secret** (value not readable via CLI), and was
  **verified correct 2026-07-24**: `/test-rain` returned `ok:true` (APNs 200) for
  all 5 real registered device tokens, so pushes reach the right APNs host
  end-to-end.

---

### A. See registered devices (production)

```bash
cd backend
NS=142615e17bc84dc7adbd9e64d0b29410

# List device registrations (NOTE the --remote):
npx wrangler kv key list --remote --namespace-id $NS | grep '"name": "device:'

# Inspect one:
npx wrangler kv key get --remote "device:<paste-token>" --namespace-id $NS
#   -> { token, lat, lon, leadTimeMinutes, rainStartEnabled, rainEndEnabled,
#        registeredAt, renewedAt }
#   registeredAt is first-seen and never restamped (the cron ranks cells by it);
#   renewedAt is the last write, i.e. when the 45-day TTL was last reset (section G).

# A Live Activity push token is a key of its own, not a field on the record above:
npx wrangler kv key get --remote "activity:<paste-token>" --namespace-id $NS
```

### B. Confirm YOUR device is registered

There are several device tokens (old reinstalls each make a new one). To find
*your current* one:

1. Run the app from Xcode on your phone and watch the console for:
   `[Push] Stored device token: <hex>`  ← that hex is your token.
2. Confirm it's in KV:
   ```bash
   npx wrangler kv key get --remote "device:<that-hex>" --namespace-id $NS
   ```

### C. Fire a real end-to-end push to your phone

**All three test endpoints require the `X-Admin-Token` header.** They send real
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
# Add "dryRun":true to get the derived `precip` and raw `summary` back with no
# push — backend/test/probe-weatherkit-summary.sh wraps this (section 6, M16).

# Content-state push at a running Live Activity (/test-activity): driven by
# scripts/test-activity-push.sh, whose header covers finding both tokens
# (section 6, M15). Its `end` event also clears the stored activity token.
```

#### Dead token cleanup (automatic since 2026-07-27)

The cron no longer keeps pushing to tokens APNs has rejected:

- **410 Unregistered** → the device record is deleted, but at most
  `MAX_DEVICE_REAPS_PER_TICK` (2) devices are dropped per cron tick, because the
  Free plan allows 1,000 KV deletes a day. Beyond that the token is queued in the
  CoverageRegistry, skipped by the push loop so it costs no further pushes, and
  reaped by a later tick — `[APNs] Reap budget exhausted` and
  `[Cron] … still queued for deletion` say so in `wrangler tail`.
- **BadDeviceToken** → a strike counter (`apnsfail:<token>`, 24h TTL). The
  device is dropped on the 5th strike. It is deliberately not 1, because a
  wrong `APNS_ENV` makes *every* device return BadDeviceToken, and a single
  bad tick must not be able to wipe the whole device list. The app re-registers
  on every foreground, so an over-eager delete heals itself.
- A rejected **Live Activity** push clears only that device's `activity:` key,
  leaving the device registered for ordinary rain alerts.

### D. Watch the Worker live

```bash
cd backend
npx wrangler tail
#   then trigger a test or wait for the :00/:10/:20 cron — you'll see
#   [Cron]/[Register] logs and any APNs errors in real time.
```

### E. (Optional) set APNS_ENV explicitly

```bash
cd backend
npx wrangler secret put APNS_ENV      # type:  production
npx wrangler deploy
```

---

### Where the copy lives
- **Server push:** `backend/src/apns.ts` — `sendRainAlert`, `sendRainEndAlert`.
- **On-device:** `WillItRain/WillItRain/Services/NotificationService.swift`.
- Current wording preview: `screenshots/notifications/notification-copy-*.png`.

### F. Prune junk registrations (run when convenient)

Production KV has 5 placeholder tokens (`realtest`, `test123`, `test456`,
`test789`, `testABC`) and 2 simulator tokens (160-hex — APNs always rejects
those). They add error-log noise once rain hits their grid, and because they are
the oldest records in KV the cron ranks their cells ahead of every real user's
(`selectCellsWithinCap`), so at `MAX_GRID_CELLS` = 15 they can hold up to 7 of
the 15 slots.

**Delete them straight from KV — `/unregister` cannot.** That endpoint validates
with `isValidDeviceToken` (64–128 hex characters), so all seven are rejected with
`400 Invalid or missing token`: the placeholders are 8 characters and non-hex,
and the simulator tokens are 160 hex characters, over the maximum.

```bash
NS=142615e17bc84dc7adbd9e64d0b29410

# List what is there (NOTE the --remote):
npx wrangler kv key list --remote --namespace-id $NS | grep '"name": "device:'

# Then delete each junk one by key:
npx wrangler kv key delete --remote --namespace-id $NS "device:realtest"
```

`/unregister` remains the right tool for a real 64-hex device token.

### G. Registration limits (the abuse gate)

`/register` and `/register-activity` are unauthenticated, so they are bounded
rather than trusted. The limits all live in `backend/src/abuse.ts`; the counters
behind them live in Durable Objects (`backend/src/durable.ts`), because Workers
KV cannot count a sub-second burst.

| Symptom while testing | Cause | What to do |
|---|---|---|
| `415 unsupported_media_type` | body sent without `Content-Type: application/json` | send the header (the curls in this file all do) |
| `429 rate_limited` + `Retry-After` | more than 20 registrations from your IP in 10 minutes | wait out `retryAfterSeconds` |
| `503 coverage_at_capacity` | the request would open a **new** grid cell and the service already covers `MAX_GRID_CELLS` (15) | delete junk `device:` keys from KV (section F — not `/unregister`), or re-run the subrequest arithmetic in `abuse.ts` before raising the cap |
| `503 cell_at_capacity` | that one grid cell already holds `MAX_DEVICES_PER_CELL` (20) devices | unregister a device in that cell, or raise the cap after re-running the arithmetic |
| `200` but `wrangler kv key get` shows the OLD lead time / toggles | a same-cell settings change inside the 5-minute rewrite cooldown | wait 5 minutes and re-send, or change the coordinates too — a cell change is never deferred |
| `503 storage_unavailable` + `Retry-After: 60` | KV threw while reading the caller's existing record, so the write was refused rather than risk overwriting it | transient — check `wrangler tail` for the KV error; the caller's stored registration is untouched and still live |
| `200` from `/register-activity` but the `activity:` key still shows the old `activityUpdatedAt` | the same activity token was re-submitted, and an identical token is never rewritten | expected; a new or changed token is always written immediately |

**The two capacity 503s clear the caller's existing registration.** That is
deliberate: a user who moves into an area the service cannot cover should get
*no* alerts, not alerts for where they used to live. Re-register once capacity
frees up. `storage_unavailable` is the exception — it clears nothing, precisely
because the whole point of that refusal is to avoid touching stored state it
could not read.

The caps are set by the Workers **Free** plan's 50-external-subrequests-per-invocation
budget, which the cron shares between one WeatherKit fetch per cell and up to two
APNs pushes per notified device — 15 + `PUSH_BUDGET_PER_INVOCATION` (34) ≤ 50. The
cron logs `[Cron] Grid-cell cap hit` if it has to skip cells, and
`[Cron] Push budget exhausted` if it runs out of pushes; both are `console.error`,
so `wrangler tail` shows them.

Device records expire 45 days after their last write, and the app re-registers on
cold launch, on every foreground, and after every successful weather poll — so
this only reaps records nothing is renewing. A repeat registration that changes
nothing is **not** rewritten (it would spend the Free plan's 1,000 KV writes a day
on nothing); a record older than 7 days is rewritten regardless, which resets the
TTL with weeks to spare.

A registration that changes only *settings* (`leadTimeMinutes`, `rainStartEnabled`,
`rainEndEnabled`) within the same grid cell is also held back for up to 5 minutes
after the last write, for the same budget reason. It returns `200` with the grid
key the record still has, and self-heals on the next registration — which the app
issues after every successful weather poll. **A move to a different grid cell is
never held back**: it is written immediately, because a device alerted for the
cell it left is exactly the silent break the gate exists to prevent.

**Records written before this shipped had no expiry at all**, and KV cannot add
one after the fact; the cron rewrites up to 5 such records per tick until they all
have one. The section-F placeholder and simulator tokens are included in that, so
they will carry a TTL and expire 45 days later — delete them from KV (section F)
if you want the slots and the error-log noise back sooner.

### Known gaps (Release 2 follow-ups)
- Server push says "in your area" (no city name) — backend stores only lat/lon.
  Add `locationName` to the `/register` payload to name the city.
- ~~Server can't tell rain vs snow~~ — fixed in 1.1.2. It reads
  `forecastNextHour.summary[].condition` (confirmed live 2026-07-27, see the spec in
  `docs/superpowers/specs/2026-07-27-wintry-live-activity-design.md`). Caveat: Apple's summary
  applies a higher confidence bar than our own minute-level detection (Belfast showed
  precipitation at chance 0.31 while the summary still said `clear`), so very light snow can
  render as rain. Deliberate fallback. A wintry value has still never been observed in the
  wild; `probe-weatherkit-summary.sh` (M16) is how to check.
- Cron reads only the next ~hour, so it can't warn earlier than ~75 min out.
