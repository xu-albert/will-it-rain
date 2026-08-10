# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
