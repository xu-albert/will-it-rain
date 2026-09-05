# Wintry Live Activity — design spec

**Date:** 2026-07-27
**Release:** 1.1.2 (build 7) — written for 1.1.1, but 1.1.1 (6) shipped from
`main` without this work, so it lands one release later.
**Branch:** originally `release-1.1.1-wintry-live-activity` (PR #8, head
`cfc09c6`), hand-ported onto `main` in 2026-09 rather than merged. The rendered
mockup PNGs and the simulator captures referenced below (`snow-mockup-v*.png`,
`screenshots/live-activity/*.png`, ~6 MB) were deliberately left on PR #8 and
are not in this tree; the `.html` mockups are, and render the same thing.

## Problem

The Live Activity renders rain visuals no matter what is falling. During snow the
user sees a cyan track and a droplet glyph; only the wording changes ("Snowing
now", "Flurries").

The cause is structural, not cosmetic: `RainActivityAttributes.ContentState`
carries no precipitation type, so the widget extension cannot know. The app knows
— `LiveActivityService.makeState` already branches on `.snow` for copy — but that
knowledge never crosses into the extension.

## Decisions

**Two visual treatments, not five.** Rain keeps today's cyan. Snow, sleet, hail,
and mixed share one "wintry" look. The visual fork is binary, so the data that
drives it should be too.

**W1b** is the chosen palette — an essentially white track with a white glow
and the blue tint pulled almost out. Selected over eight explored options; all
are archived in `docs/design/live-activity/snow-mockup-v{1,2,3}.html` with
the alternatives intact so the decision can be revisited without rebuilding
them. (The earlier picks, B2 then B3, are preserved there too.)

| Role | Rain (unchanged) | Wintry (W1b) |
|---|---|---|
| Track gradient | `#54C3F5` → `#38ADE7` | `#FFFFFF` → `#DCE8F0` |
| Glow | `#54C3F5` | `#FFFFFF` |
| Now-dot ring | `white @ 22%` | `#B0CBE0 @ 75%` |
| Time flag | `#9DDCFF` | `#EAF4FF` |
| Compact / countdown | `#CFEEFF` | `#E8F4FC` |
| Keyline tint | `#54C3F5` | `#FFFFFF` |
| Glyph | `drop.fill` | `snowflake` |

One row there is function, not taste:

*Now-dot ring* — in the "falling now" state the track segment starts at 0,
directly beneath the white "now" dot. With a near-white track the two whites
merge, so the ring has to carry the separation. `#B0CBE0` is deep enough to
divide them while still reading as ice rather than as a dark outline.

The header badge is not in that table because it no longer carries the
treatment at all: since #10 (1.1.1) it is the app icon itself (`AppIconTile`),
the activity's identity rather than its weather, and it stays the same on a
wintry card. The original spec tinted it with the track gradient and swapped
the glyph colour to `#12233B` so a white snowflake would not vanish on a
near-white badge; that concern went away with the badge.

Measured on the rendered mockups, W1b's track sits ~10 luminance points above
the earlier B3 pick at the same sample points (245 vs 236 at 25% along).

### Track alignment fix (found while verifying W1b on a real render)

The rail and its segments carried `.offset(y: 6)` inside a 16pt frame whose
ZStack already centres its children on y=8, putting the track's centre at y=14
while the "now" dot and the hour dots sat at y=8. Measured on an iPhone 16 Pro
screenshot: dot centre y=1520.5px, track centre y=1538.5px — 18px at 3×, exactly
6pt. So the track hung below the dots instead of running through them.

This shipped in 1.1 and affects rain equally; the fix removes the offset and is
worth taking in 1.1.1 for two reasons beyond fidelity to the mockups:

1. It is the premise of the now-dot ring decision above. W1b was chosen by
   comparing HTML mockups in which the dot sits *inside* the track. On device
   they barely grazed, so the case the ring exists to handle was not actually
   occurring — the palette had been picked against a situation the app never
   rendered.
2. The hour dots had the same 6pt drift, so on the intermittent card they
   floated above the bursts they annotate.

Verified after the change: dot centre and track centre differ by 0.0px on both
the rain and wintry cards.

## Data model

Add to `Shared/RainActivityAttributes.swift`:

```swift
enum Precip: String, Codable { case rain, wintry }
```

and one field on `ContentState`:

```swift
var precip: Precip?
```

A dedicated two-case enum rather than sharing the app's `PrecipitationType`
because: it matches the actual visual fork; it keeps the APNs payload small
(4KB ceiling); and it spares the Worker from modelling WeatherKit's taxonomy —
it sends the literal string `"rain"` or `"wintry"`.

**The field must be `Optional`.** Swift's synthesized `Codable` throws on a
missing key even when a property has a default; only `Optional` decodes absence.
A non-optional would make ActivityKit fail to decode any payload from a Worker
that predates the field, and the activity would silently stop updating — no
error, just a frozen card. `nil` renders as rain, matching today's behaviour.

## Server changes are load-bearing, not optional

`content-state` is a **full replacement, not a merge**. If the app sets `wintry`
and the Worker's next cron tick pushes a state without `precip`, the field
decodes as `nil` and the card reverts to rain visuals — within 10 minutes, during
the exact snowstorm the feature exists for.

So the Worker must send `precip` in the same release. Required changes:

1. `types.ts` — add `precip` to `LiveActivityContentState`; model
   `forecastNextHour.summary[].condition`.
2. `index.ts` — derive `precip` and include it in both the rain-start and
   rain-end content states.

WeatherKit's `forecastNextHour` response carries the type in
`summary[].condition`. The Worker already requests `dataSets=forecastNextHour`
(`weatherkit.ts:40`), so this costs no additional quota.

**Confirmed against live responses 2026-07-27** via
`backend/test/probe-weatherkit-summary.sh` (which added a `dryRun` mode to
`/test-cron` so any coordinate can be probed without a device there and without
sending a push):

| Location | Observed |
|---|---|
| Chicago, actively raining | `summary: ["rain","clear"]` → `precip: rain` |
| Dry locations | `summary: ["clear"]` → `precip: rain` |
| Queenstown NZ, Bariloche AR | `summary: null` (no coverage) → `precip: rain`, no throw |
| Bergen NO | `summary: []` → `precip: rain`, no throw |

So the field is real, values are lowercase bare nouns, and periods run in
chronological order — which is what lets `precipFromForecast` resolve the
period the pushed event falls in. On the rain-start path that is the first
non-`clear` period from the one covering the first wet minute onward, so "snow
starting in 40 min" is wintry even though it is clear now, and a gradual onset
whose wet minute lands just before the summary's snow period (the confidence
gap below) still reads snow. On the rain-end path it is `summary[0]` — what is
falling now — so light rain now with snow later in the hour is not pushed as
"Snowing now". A summary without `startTime` is read from the beginning.

Two things this did **not** settle:

*A wintry value has not been observed in the wild* — it was July. Perisher AU is
covered and in season, so it is the target for a southern-hemisphere follow-up.
`precipFromForecast` exact-matches the documented lowercase values `snow`,
`sleet`, `hail` and `mixed`; anything else resolves to `rain`, and `/test-cron`
echoes the raw `summary` next to the derived `precip` so an unexpected spelling
shows up in the probe rather than hiding behind a confident `rain`.

*Apple's summary uses a higher confidence bar than our own detection.* Belfast
showed `minutes` precipitation at chance 0.31 while `summary` still said
`["clear"]`. Very light snow can therefore be detected minute-wise but
summarised as clear, and would render as rain. That is a documented limitation,
not a bug — `rain` is the deliberate fallback for a rain app.

## `.mixed` handling

`WeatherService.precipitationType(from:)` ends in `default: return .rain`, so
WeatherKit's `.mixed` — common in real winter weather — currently resolves to
rain and would keep rendering as rain after this change.

Add a `.mixed` case to `PrecipitationType` (rawValue `"Mixed"`, icon
`cloud.sleet.fill`) and map WeatherKit `.mixed` to it. Both copy switches in
`LiveActivityService` are exhaustive over the enum, so the compiler will force
both to be updated:

- State B: `statusWord = "Wintry mix now"`, `verb = "Wintry mix"`
- State A: `typeWord = "wintry mix"`
- State C hero: currently `next.type == .snow ? "Flurries" : "Showers"` — becomes
  wintry-aware so mixed and sleet do not read "Showers".

`default: return .rain` stays as the catch-all for genuinely unknown future
cases, which is the right default for a rain app.

## Test plan

| Risk | Test | Pass condition |
|---|---|---|
| Optional decode wrong → activity silently freezes | Push a content-state with **no** `precip` key at a running 1.1.1 activity | Card keeps ticking, renders rain |
| Old widget, new payload | 1.1 widget receives payload **with** `precip` | Unknown key ignored, no decode failure |
| Snow never resolves to wintry | New `-liveActivityScenario` snow case | Snowflake + W1b palette in all surfaces |
| Copy regressions | Scenario run across rain / snow / sleet / mixed | Correct wording per state A/B/C |
| Real weather disagrees | Location spoof to a snowing region (Belfast recipe, `TESTING.md`) | Wintry survives a server push |

Simulator coverage for the first four; the last needs a device and real snow, so
it is verification-after-ship rather than a release gate.

## Out of scope

- Push-to-start Live Activities (iOS 17.2+) — separate work, tracked already.
- Distinct visuals per wintry type — deliberately collapsed to one treatment.
- Slimming the "bulky" hero text — known feedback, not this change.
- Animated snowfall — the lock screen is a static snapshot surface.

## Files touched

| File | Change |
|---|---|
| `Shared/RainActivityAttributes.swift` | `Precip` enum, optional `precip` field |
| `Shared/LiveActivityCardViews.swift` | Card views + palette, moved out of the widget so the app can render them; track alignment fix |
| `WillItRainWidgets/RainLiveActivity.swift` | Reduced to the ActivityKit wiring |
| `WillItRain/Views/LiveActivityCardPreview.swift` | DEBUG `-liveActivityCards` screen for lock-screen capture |
| `WillItRain/Services/LiveActivityService.swift` | Set `precip`; `.mixed` copy |
| `WillItRain/Models/RainForecast.swift` | `.mixed` case + icon |
| `WillItRain/Services/WeatherService.swift` | Map WeatherKit `.mixed` |
| `WillItRain/Services/LiveActivityDebugScenarios.swift` | Snow scenario |
| `backend/src/types.ts` | `precip` field, `summary[].condition` |
| `backend/src/index.ts` | Derive and send `precip` |
