# Release 1 — Fix Apple Weather Attribution (Guideline 5.2.5)

**Date:** 2026-07-24
**Goal:** Clear the sole cited App Review blocker so the app can be approved.
**Scope:** Attribution only. Nothing else ships in this release.

## Background

Submission `f32f60ef-3b4e-4118-90be-708102e11798` was rejected under **Guideline
5.2.5 – Legal – Intellectual Property**. Apple reviewed on an **iPad Air 11-inch
(M3)** and stated the app "still does not include the required Apple Weather
attribution," despite a prior fix attempt (commit `a4f6392`).

WeatherKit apps must clearly display:
1. The Apple Weather trademark ( Weather).
2. A legal source link to `https://weatherkit.apple.com/legal-attribution.html`.

## Root cause

The attribution is present in code but **unreliable**, which reads to a reviewer
as "not present":

- **Only in the loaded state.** `ContentView.body` (`ContentView.swift:33-61`)
  switches on `AppState` (`.loading` / `.loaded` / `.error`). The attribution
  `Link` lives inside `loadedView(_:)` (`ContentView.swift:186-195`) only. If the
  reviewer's iPad hit a slow load or a location-permission **error**, there is
  **no attribution on screen at all**.
- **Low legibility.** It is rendered `white.opacity(0.6)`. On the light
  clear-day gradient (`gradientColors(for: .clear)`, near-white bottom) it is
  close to invisible.
- **Clip risk on iPad.** It sits at the bottom of a `VStack` full of `Spacer()`s
  with `.padding(.bottom, 16)`. On an 11" iPad this can crowd or fall under the
  home indicator.

## Design

Make the attribution a **single persistent component rendered on every app
state**, guaranteed legible on every background, and anchored inside the safe
area so it can never be clipped.

### 1. New reusable component: `AttributionView`

A small self-contained view (own file, e.g.
`WillItRain/WillItRain/Views/AttributionView.swift`).

- Content: `Link` to `https://weatherkit.apple.com/legal-attribution.html`
  wrapping an `HStack` of `Image(systemName: "apple.logo")` + `Text("Weather")`.
- Legibility: full-opacity white text/glyph on a **contrast backing** — a
  `Capsule` filled with `Color.black.opacity(0.28)` (readable on both the darkest
  rain gradient and the lightest clear gradient). No `opacity` on the text
  itself.
- Sizing: `.font(.system(size: 13, weight: .medium))`, comfortable horizontal
  padding so the tap target and text are clearly visible.

**What it does:** renders the required trademark + legal link.
**How you use it:** drop it in as an overlay; no inputs.
**Depends on:** nothing (pure SwiftUI + a hardcoded URL).

### 2. Render it on every state, once

Move the attribution **out of `loadedView`** and attach it to the root `ZStack`
in `ContentView.body` as a bottom-anchored overlay that respects the safe area:

```swift
ZStack { ... }               // existing state switch
.overlay(alignment: .bottom) {
    AttributionView()
        .padding(.bottom, 8)
}
```

- `.overlay` (not `.ignoresSafeArea`) keeps it inside the safe area → never
  clipped by the home indicator on iPad.
- Because it is on the root `ZStack`, it appears identically in `.loading`,
  `.loaded`, and `.error` states.
- Remove the old `Link` block from `loadedView` (`ContentView.swift:185-195`) to
  avoid a duplicate.

### 3. DEBUG coexistence

The `#if DEBUG` condition picker is also a bottom overlay
(`ContentView.swift:62-66`). In release builds it is compiled out, so there is no
conflict in the shipped app. During DEBUG testing the picker may overlap; that is
acceptable and dev-only. (Optional: nudge the debug picker up if it obscures the
attribution while testing — not required for release.)

## Out of scope (explicitly deferred)

- Rain-detection / "something/nothing happening" status bug — next release.
- Server push notifications, Live Activities, Cloudflare backend — next release.
- Any refactor beyond extracting `AttributionView` and relocating it.

## Testing / verification (gate before resubmission)

Reproduce Apple's exact environment and prove the attribution is visible on
every screen:

1. Build & run on the **iPad Air 11-inch (M3) simulator** (the device Apple used).
2. Capture screenshots of all three states with ` Weather` visible:
   - **Loaded** (normal forecast).
   - **Loading** (launch, before data arrives).
   - **Error** (deny location permission → error screen).
3. Verify legibility against the **clear/light** background (use a clear-day
   screenshot scenario) and a **rain/dark** background.
4. Confirm the link opens `weatherkit.apple.com/legal-attribution.html`.
5. Also sanity-check on an iPhone simulator (no regression).

Only resubmit once all three states show a legible ` Weather` link on the iPad
sim.

## Success criteria

- ` Weather` trademark + legal link visible and legible on loading, loaded, and
  error states, on iPad Air 11" and iPhone, on light and dark backgrounds.
- Tapping opens the legal attribution page.
- No other behavior changed.
