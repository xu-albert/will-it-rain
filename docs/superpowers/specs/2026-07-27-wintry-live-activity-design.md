# Wintry Live Activity — design spec

**Date:** 2026-07-27
**Release:** 1.1.1
**Branch:** `release-1.1.1-wintry-live-activity`

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
are archived in `docs/design/live-activity/snow-mockup-v{1,2,3}.{html,png}` with
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
| Glyph colour **inside header badge** | white | `#12233B` |

Two rows there are function, not taste:

*Glyph colour inside the badge* — the badge is filled with the track gradient,
so against a near-white wintry badge a white glyph disappears.

*Now-dot ring* — in the "falling now" state the track segment starts at 0,
directly beneath the white "now" dot. With a near-white track the two whites
merge, so the ring has to carry the separation. `#B0CBE0` is deep enough to
divide them while still reading as ice rather than as a dark outline.

Measured on the rendered mockups, W1b's track sits ~10 luminance points above
the earlier B3 pick at the same sample points (245 vs 236 at 25% along).

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

WeatherKit's `forecastNextHour` response is believed to carry the type in
`summary[].condition` (values include `clear`, `rain`, `snow`, `sleet`, `hail`,
`mixed`). The Worker already requests `dataSets=forecastNextHour`
(`weatherkit.ts:40`), so this costs no additional quota.

**This must be confirmed against a live response before code depends on it.**
Verification step: log `forecastNextHour.summary` from one real `/test-cron`
call and read it back via `wrangler tail`. If `condition` is absent, fall back to
mapping from the app only and accept that server pushes clear the wintry state —
a known, documented limitation rather than a silent bug.

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
| `WillItRainWidgets/RainLiveActivity.swift` | Palette switch, snowflake glyph, badge glyph colour |
| `WillItRain/Services/LiveActivityService.swift` | Set `precip`; `.mixed` copy |
| `WillItRain/Models/RainForecast.swift` | `.mixed` case + icon |
| `WillItRain/Services/WeatherService.swift` | Map WeatherKit `.mixed` |
| `WillItRain/Services/LiveActivityDebugScenarios.swift` | Snow scenario |
| `backend/src/types.ts` | `precip` field, `summary[].condition` |
| `backend/src/index.ts` | Derive and send `precip` |
