#!/bin/bash
# Capture the adopted `drift-scatter` app icon AS IT ACTUALLY RENDERS on iOS, so
# the shaped-cloud-underside question can be judged from real renders rather
# than from rasterised mock-ups.
#
# Captures, in order:
#   home screen        (60pt @3x -> the 180px asset)
#   Spotlight          (small, on a light blurred ground)
#   Settings > Apps    (29pt @3x -> the 87px asset — the size the question is about)
#   Live Activity lock-screen card   (AppIconTile at 20pt)
#   Dynamic Island expanded
#   Dynamic Island compact
#
# The Dynamic Island MINIMAL presentation is not captured: it only appears when
# a second app's activity is running alongside this one, which this harness does
# not stage. See data/wir-icon-adopt/README.md.
#
# Each capture is saved full-frame, plus a 1:1 crop and a 4x nearest-neighbour
# magnification of the icon itself, because the whole point is judging pixels.
# The crop rectangles below are the ones that produced the committed evidence in
# data/wir-icon-adopt/ — each reproduces its committed `*-icon.png` exactly, so
# a re-run after a silhouette change is comparable frame for frame. Re-derive
# them only if the framing itself has to change.
#
# REQUIRES AN UNLOCKED MAC AND EXCLUSIVE USE OF THE SIMULATOR — the GUI passes
# drive Simulator's own window with cliclick.
#
# ---------------------------------------------------------------------------
# COORDINATE MAPPING — read this before changing any tap coordinate.
#
# Taps are given in DEVICE PIXELS (the coordinate space of `simctl io
# screenshot`, 1320x2868 on an iPhone 16 Pro Max) and mapped to macOS screen
# points by map_pt().
#
# Two traps make the naive mapping wrong, and both cost a previous session its
# captures:
#
#   1. The Simulator draws the device at 0.62 mac PIXELS per device pixel, i.e.
#      k = 0.31 screen POINTS per device pixel on a 2x display — not the 0.30
#      that the window dimensions appear to imply.
#
#   2. This Simulator window renders the device ROTATED 180 DEGREES: the status
#      bar is drawn at the BOTTOM of the window and the labels are inverted.
#      `simctl io screenshot` is unaffected and still returns an upright frame,
#      so the rotation is invisible in the captures and only corrupts taps.
#      Every tap must therefore be mirrored through the screen centre.
#
# Symptom of getting this wrong: long-pressing the Dynamic Island silently
# lands on the wallpaper and drops the Home Screen into jiggle mode instead.
#
# To re-derive the calibration after a zoom/orientation change, see
# recalibrate() below — it prints the numbers to paste back into this header.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SIM="${SIM:-CD425710-939D-4E4D-A878-6B4283B72760}"   # iPhone 16 Pro Max
BUNDLE_ID="com.willitrain.WillItRain"
OUTDIR="${OUTDIR:-$REPO/data/wir-icon-adopt}"   # the committed evidence lives here
APP="$REPO/.build/la-shots/Build/Products/Debug-iphonesimulator/WillItRain.app"

# Calibration, in macOS screen POINTS. See the header.
ORIGIN_X=304        # screen x of device pixel (0,0) as DRAWN
ORIGIN_Y=132.5      # screen y of device pixel (0,0) as DRAWN
SCALE=0.31          # screen points per device pixel
ROTATED=1           # window draws the device upside-down
DEV_W=1320
DEV_H=2868

mkdir -p "$OUTDIR/native"

[ -d "$APP" ] || { echo "No Debug build at $APP — build first:"; \
  echo "  xcodebuild -project WillItRain/WillItRain.xcodeproj -scheme WillItRain \\"; \
  echo "    -configuration Debug -destination 'platform=iOS Simulator,id=$SIM' \\"; \
  echo "    -derivedDataPath .build/la-shots build"; exit 1; }
[ -d "$APP/PlugIns/WillItRainWidgets.appex" ] || { echo "Widget extension missing"; exit 1; }

focus() {
  osascript >/dev/null 2>&1 <<'EOS' || true
tell application "Simulator" to activate
delay 0.5
tell application "System Events" to tell process "Simulator"
  set frontmost to true
  try
    perform action "AXRaise" of window 1
  end try
end tell
EOS
}

# Cmd+L does not lock via System Events, but Cmd+Shift+H does go Home.
home() {
  focus
  osascript >/dev/null 2>&1 <<'EOS' || true
tell application "System Events" to tell process "Simulator"
  keystroke "h" using {command down, shift down}
end tell
EOS
}

# A Device menu item must have its parent menu opened first, or the click is
# silently swallowed.
devmenu() {
  focus
  osascript >/dev/null 2>&1 <<EOS || true
tell application "System Events" to tell process "Simulator"
  click menu bar item "Device" of menu bar 1
  delay 0.8
  click menu item "$1" of menu 1 of menu bar item "Device" of menu bar 1
end tell
EOS
}

win_geom() {  # -> "x y w h"
  osascript -e 'tell application "System Events" to tell process "Simulator" to return {position, size} of window 1' 2>/dev/null \
    | tr -d ' ' | tr ',' ' '
}

# The whole tap path depends on the window being the size the calibration was
# taken at. Anything else means a different zoom and every tap would be wrong,
# so refuse rather than click blindly into the user's desktop.
assert_window() {
  local x y w h
  read -r x y w h <<<"$(win_geom)"
  [ -n "${h:-}" ] || { echo "ABORT: Simulator has no window (Mac screen locked?)"; exit 2; }
  echo "window ${w}x${h} at ($x,$y)"
  if [ "$w" -ne 462 ] || [ "$h" -ne 988 ] || [ "$x" -ne 278 ] || [ "$y" -ne 53 ]; then
    echo "ABORT: expected the 462x988 window at (278,53) this script is calibrated for."
    echo "       Got ${w}x${h} at ($x,$y). Re-run with RECALIBRATE=1 and update the header."
    exit 2
  fi
}

# device px -> macOS screen points, mirroring when the window is rotated 180.
map_pt() {
  python3 -c "
dx, dy = float('$1'), float('$2')
if $ROTATED:
    dx, dy = $DEV_W - dx, $DEV_H - dy
print(round($ORIGIN_X + $SCALE * dx), round($ORIGIN_Y + $SCALE * dy))
"
}

tap()   { local p; p=$(map_pt "$1" "$2"); set -- $p
          cliclick m:"$1","$2" >/dev/null 2>&1 || true; sleep 0.3
          cliclick c:"$1","$2" >/dev/null 2>&1 || true; }

# Long press that screenshots WHILE the finger is down. The Dynamic Island
# collapses the moment it is released, so a shot taken after `du` catches the
# compact presentation instead — which is exactly how the previous round's
# "expanded" captures came out compact.
press_shot() {  # press_shot <dx> <dy> <hold_s> <basename> [crop x y w h]
  local dx="$1" dy="$2" hold="$3"; shift 3
  local p; p=$(map_pt "$dx" "$dy"); set -- $p "$@"
  local sx="$1" sy="$2"; shift 2
  focus
  cliclick m:"$sx","$sy" >/dev/null 2>&1 || true; sleep 0.4
  cliclick dd:"$sx","$sy" >/dev/null 2>&1 || true
  sleep "$hold"
  # The shot must never abort this function: under `set -e` a failed screenshot
  # would skip the release below and leave the mouse button physically held
  # down on the user's desktop. Take the status, release, then report it.
  local status=0
  shot "$@" || status=$?
  cliclick du:"$sx","$sy" >/dev/null 2>&1 || true
  return "$status"
}

drag() {  # drag <dx1> <dy1> <dx2> <dy2>
  local a b; a=$(map_pt "$1" "$2"); b=$(map_pt "$3" "$4")
  set -- $a $b
  focus
  cliclick dd:"$1","$2" m:"$3","$4" w:250 du:"$3","$4" >/dev/null 2>&1 || true
}

typed() { focus; osascript >/dev/null 2>&1 -e "tell application \"System Events\" to keystroke \"$1\"" || true; }

status_bar_override() {
  xcrun simctl status_bar "$SIM" override --time "9:41" \
    --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiBars 3 >/dev/null 2>&1 || true
}

# shot <basename> [crop x y w h]
shot() {
  local base="$1"; shift
  local native="$OUTDIR/native/${base}.png"
  rm -f "$native"
  xcrun simctl io "$SIM" screenshot --type=png "$native" >/dev/null 2>&1
  [ -s "$native" ] || { echo "    FAIL screenshot $base"; return 1; }
  echo "    wrote native/${base}.png"
  if [ $# -eq 4 ]; then
    python3 - "$native" "$OUTDIR/${base}-icon.png" "$OUTDIR/${base}-icon-4x.png" "$@" <<'PY'
import sys
from PIL import Image
src, out1, out4, x, y, w, h = sys.argv[1], sys.argv[2], sys.argv[3], *map(int, sys.argv[4:8])
c = Image.open(src).crop((x, y, x + w, y + h))
c.save(out1)
c.resize((w * 4, h * 4), Image.NEAREST).save(out4)
PY
    echo "    wrote ${base}-icon.png + -icon-4x.png"
  fi
}

start_scenario() {  # start_scenario <A|B|C>
  xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
  sleep 1
  local console; console=$(mktemp)
  ( xcrun simctl launch --console-pty "$SIM" "$BUNDLE_ID" \
      -liveActivityScenario "$1" >"$console" 2>&1 & ) || true
  sleep 5
  grep -q "Started scenario $1" "$console" \
    || { echo "    FAIL: activity did not start for $1 (Release build? harness is #if DEBUG)"; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1 || true
xcrun simctl install "$SIM" "$APP"
assert_window
status_bar_override

ISLAND_X=680; ISLAND_Y=96      # centre of the compact island, device px

# ============ 1: Home Screen ===============================================
echo; echo "=== 1/6: Home Screen ==="
xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
home; sleep 2
# `home` lands on the FIRST home page, which is the widget/stock-app page. A
# freshly installed app goes onto a later page, so swipe across to the page that
# actually holds the icon — the committed capture is not on page one. Set
# HOME_PAGES if this install landed further along than one page over.
for _ in $(seq 1 "${HOME_PAGES:-1}"); do drag 1150 1400 170 1400; sleep 1; done
status_bar_override
shot "01-home-screen" ${HOME_CROP:-688 578 244 258}

# ============ 2: Spotlight =================================================
echo; echo "=== 2/6: Spotlight ==="
home; sleep 1
drag 660 700 660 1500
sleep 2
typed "Gonna"
sleep 3
# The crop is the top hit's icon alone, not the whole results banner.
shot "02-spotlight" 96 330 240 250

# ============ 3: Settings > Apps ===========================================
# The committed capture is this app's row INSIDE Settings > Apps, at 29pt @3x.
# That list opens already scrolled to the top with the row visible, so nothing
# is scrolled once the pane is open.
#
# Where the "Apps" row sits in the ROOT Settings list moves with the iOS version
# and is the one coordinate the committed frames do not pin down. Rather than
# guess a tap — a miss here captures the wrong pane and looks like a real
# result — this tries the deep link and then has the operator confirm.
echo; echo "=== 3/6: Settings > Apps (29pt @3x — the 87px asset) ==="
home; sleep 1
xcrun simctl openurl "$SIM" "App-Prefs:root=APPS" >/dev/null 2>&1 \
  || xcrun simctl launch "$SIM" com.apple.Preferences >/dev/null 2>&1 || true
sleep 3
echo "    open Settings > Apps if it is not already showing, then press return"
read -r _ || echo "    WARNING: nothing on stdin — capturing whatever is on screen"
status_bar_override
shot "03-settings-apps" 55 1755 560 175

# ============ 4: Live Activity, Lock Screen card ===========================
echo; echo "=== 4/6: Live Activity lock-screen card ==="
# The first Live Activity presented after an unlock draws a one-off "Allow Live
# Activities from ...?" consent sheet over the card. Burn it on a throwaway
# activity, or it covers the first capture below.
home; sleep 1
if start_scenario A; then
  home; sleep 2
  devmenu "Lock"; sleep 4
  devmenu "Lock"; sleep 2
fi
xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
home; sleep 2
for code in A B C; do
  echo "--- scenario $code ---"
  home; sleep 1
  start_scenario "$code" || continue
  home; sleep 2
  status_bar_override
  devmenu "Lock"; sleep 4
  shot "04-lockscreen-$code" 53 1665 1210 495
  devmenu "Lock"; sleep 2
  home; sleep 2
done

# ============ 5: Dynamic Island, expanded ==================================
echo; echo "=== 5/6: Dynamic Island expanded ==="
for code in A B C; do
  echo "--- scenario $code ---"
  home; sleep 1
  start_scenario "$code" || continue
  home; sleep 3
  status_bar_override
  press_shot "$ISLAND_X" "$ISLAND_Y" 2.0 "05-island-expanded-$code" 60 0 1200 560
done

# ============ 6: Dynamic Island, compact ===================================
echo; echo "=== 6/6: Dynamic Island compact ==="
for code in A B C; do
  echo "--- scenario $code ---"
  home; sleep 1
  start_scenario "$code" || continue
  xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
  sleep 2
  status_bar_override
  sleep 2
  shot "06-island-compact-$code" 300 20 760 190
done

xcrun simctl terminate "$SIM" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl status_bar "$SIM" clear >/dev/null 2>&1 || true
echo; echo "Output: $OUTDIR"
