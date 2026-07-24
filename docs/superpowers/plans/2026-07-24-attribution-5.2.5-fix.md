# Fix Apple Weather Attribution (5.2.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Apple Weather attribution ( Weather + legal link) visible and legible on every app state and device so the app clears Guideline 5.2.5 and gets approved.

**Architecture:** Extract the attribution into a single reusable `AttributionView`, then render it once as a safe-area bottom overlay on the root `ZStack` in `ContentView` so it appears identically in `.loading`, `.loaded`, and `.error` states. Give it a contrast backing so it is legible on both light-clear and dark-rain gradients.

**Tech Stack:** SwiftUI, Xcode, iOS Simulator. No test framework in this project — verification is build + visual screenshots on the exact device Apple reviewed (iPad Air 11" M3).

## Global Constraints

- Attribution glyph/text must be exactly: `Image(systemName: "apple.logo")` + `Text("Weather")` (renders as " Weather").
- Legal link URL must be exactly: `https://weatherkit.apple.com/legal-attribution.html`
- Attribution must render on **all three** `AppState` cases: `.loading`, `.loaded`, `.error`.
- Attribution must stay inside the safe area (never clipped by the iPad home indicator) — use `.overlay`, never `.ignoresSafeArea`, on the attribution.
- Text must be full-opacity white on a contrast backing — no `opacity` reducing the text legibility.
- Scope is attribution only. Do not touch notification, detection, backend, or Live Activity code.
- Primary review device: **iPad Air 11-inch (M3)** simulator.

---

### Task 1: Create `AttributionView` and render it on every app state

**Files:**
- Create: `WillItRain/WillItRain/Views/AttributionView.swift`
- Modify: `WillItRain/WillItRain/Views/ContentView.swift` (add overlay to root `ZStack` in `body`, lines 33-97; remove old attribution `Link` at lines 185-195)
- Modify: `WillItRain/WillItRain.xcodeproj/project.pbxproj` (add the new file to the app target — Xcode does this automatically if added via the IDE; if editing the pbxproj by hand or via a build that auto-discovers, confirm the file is a member of the `WillItRain` target)

**Interfaces:**
- Produces: `struct AttributionView: View` — no initializer parameters. Usage: `AttributionView()`.

- [ ] **Step 1: Create the `AttributionView` component**

Create `WillItRain/WillItRain/Views/AttributionView.swift` with exactly:

```swift
import SwiftUI

/// Apple Weather attribution required by App Store Guideline 5.2.5.
/// Displays the "Weather" trademark and links to the legal source page.
/// Designed to be legible on both light (clear-day) and dark (rain) backgrounds.
struct AttributionView: View {
    private let legalURL = URL(string: "https://weatherkit.apple.com/legal-attribution.html")!

    var body: some View {
        Link(destination: legalURL) {
            HStack(spacing: 4) {
                Image(systemName: "apple.logo")
                    .font(.system(size: 13))
                Text("Weather")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Color.black.opacity(0.28))
            )
        }
        .accessibilityLabel("Apple Weather. Legal attribution.")
    }
}
```

- [ ] **Step 2: Remove the old inline attribution from `loadedView`**

In `WillItRain/WillItRain/Views/ContentView.swift`, delete the old attribution block (currently lines 185-195), i.e. the comment `// Apple Weather attribution (required by WeatherKit guidelines 5.2.5)` and the entire `Link(destination: URL(string: "https://weatherkit.apple.com/legal-attribution.html")!) { ... }.padding(.bottom, 16)` that follows it. Leave the rest of `loadedView` (the `WeeklyForecastView` and its `.padding(.bottom, 20)`) intact.

- [ ] **Step 3: Add the persistent overlay to the root `ZStack`**

In `ContentView.body`, attach an overlay to the root `ZStack` (the one opened at line 34, closed at line 61). Add it immediately after the `ZStack { ... }` closing brace, before the existing `#if DEBUG .overlay(alignment: .bottom)` modifier so the debug picker (dev-only) sits below it:

```swift
        }
        .overlay(alignment: .bottom) {
            AttributionView()
                .padding(.bottom, 8)
        }
        #if DEBUG
        .overlay(alignment: .bottom) {
            debugConditionPicker
        }
        #endif
```

(The `}` above is the existing closing brace of the root `ZStack`. Do not add a second `ZStack`.)

- [ ] **Step 4: Build for the iPad Air 11" M3 simulator**

Use the xcodebuild MCP: confirm session defaults (`session_show_defaults`), set the simulator to "iPad Air 11-inch (M3)" if needed, then `build_sim`.
Expected: **Build succeeds** with no errors. If the new file is not found by the compiler, ensure `AttributionView.swift` is a member of the `WillItRain` app target in `project.pbxproj`.

- [ ] **Step 5: Commit**

```bash
git add WillItRain/WillItRain/Views/AttributionView.swift WillItRain/WillItRain/Views/ContentView.swift WillItRain/WillItRain.xcodeproj/project.pbxproj
git commit -m "Fix 5.2.5: persistent legible Apple Weather attribution on all states"
```

---

### Task 2: Visual verification gate (iPad Air 11" M3 + iPhone)

This task produces no code — its deliverable is **proof** that the attribution is visible on every state and background on the exact device Apple used. Do not resubmit to App Review until all checks pass. Save screenshots to `screenshots/verification/`.

**Files:**
- Create (screenshots only): `screenshots/verification/*.png`

- [ ] **Step 1: Boot the iPad Air 11" M3 simulator and install the build**

Use xcodebuild MCP `build_run_sim` (or `install_app_sim` + `launch_app_sim`) targeting "iPad Air 11-inch (M3)".

- [ ] **Step 2: Verify LOADED state on a LIGHT background**

Launch with the clear-day scenario so the background is the near-white clear gradient:
Launch args: `-screenshot sf-clear`
Screenshot with `mcp__xcodebuild__screenshot`. Save as `screenshots/verification/ipad-loaded-light.png`.
Expected: " Weather" capsule is clearly visible and legible at the bottom, inside the safe area (not under the home indicator).

- [ ] **Step 3: Verify LOADED state on a DARK background**

Launch args: `-screenshot nyc-rain`
Screenshot. Save as `screenshots/verification/ipad-loaded-dark.png`.
Expected: " Weather" capsule clearly visible and legible against the dark rain gradient.

- [ ] **Step 4: Verify ERROR state**

Launch the app **without** a screenshot scenario, then deny location permission (Simulator: Features > Location > None, or decline the permission prompt) so the app enters `.error(.locationDenied)`.
Screenshot. Save as `screenshots/verification/ipad-error.png`.
Expected: the error screen still shows the " Weather" attribution capsule at the bottom. (This is the case that previously showed **no** attribution.)

- [ ] **Step 5: Verify LOADING state**

Cold-launch the app without a scenario and capture during the "Checking the sky..." loading screen (the attribution overlay is on the root `ZStack`, so it renders here too).
Screenshot. Save as `screenshots/verification/ipad-loading.png`.
Expected: " Weather" attribution visible over the loading view.
(If the loading state is too brief to capture, note it — it is structurally guaranteed by the root-overlay placement verified in the other states.)

- [ ] **Step 6: Verify the legal link opens**

With the app in the loaded state, tap the " Weather" capsule.
Expected: the device browser opens `weatherkit.apple.com/legal-attribution.html` (or the in-app SafariView, depending on OS handling of `Link`). Confirm it navigates to the Apple legal attribution page.

- [ ] **Step 7: iPhone regression check**

Switch the simulator to any iPhone (e.g. iPhone 15 / 16), run, and screenshot the loaded state (`-screenshot sf-clear`). Save as `screenshots/verification/iphone-loaded.png`.
Expected: attribution visible and legible; no layout regression versus before.

- [ ] **Step 8: Commit the verification screenshots**

```bash
git add screenshots/verification/
git commit -m "Add 5.2.5 attribution verification screenshots (iPad + iPhone)"
```

---

## Post-plan: resubmission checklist (manual, outside code)

Once Task 2 passes, before resubmitting in App Store Connect:
- Reply to Apple's message in App Store Connect noting the attribution is now displayed persistently on all screens.
- Optionally attach `ipad-loaded-light.png` / `ipad-error.png` as evidence.
- Submit the same version (1.0) build with the fix.

## Self-Review notes

- **Spec coverage:** persistent-on-all-states (Task 1 Step 3 + Task 2 Steps 2-5); legibility on light + dark (Task 2 Steps 2-3); iPad-safe placement (Global Constraints + `.overlay` not `.ignoresSafeArea`); tappable legal link (Task 1 Step 1 + Task 2 Step 6); iPad Air 11" M3 + iPhone verification (Task 2). All spec sections mapped.
- **No placeholders:** all code shown in full; no TBD/TODO.
- **Type consistency:** `AttributionView()` no-arg initializer used consistently in Task 1 Step 1 (definition) and Step 3 (usage).
- **Testing honesty:** project has no XCTest target; verification is build + on-simulator screenshots, which is the appropriate and sufficient gate for a presentation-only change of this kind.
