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
# One of them is not self-checking: the Settings > Apps crop is an absolute
# rectangle, and which row lands there depends on what apps the simulator has
# installed and how they sort. It frames this app's row only on a simulator
# matching the one the committed evidence came from — on any other, it silently
# frames a neighbouring app. The operator has to confirm that row by eye.
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
# To re-derive the calibration after a zoom/orientation change, by hand:
# `screencapture` the Simulator window, find the device screen rectangle inside
# that image, and halve every measurement (a screencapture on a 2x display is in
# mac PIXELS; the constants below are screen POINTS). SCALE is then that
# rectangle's width / DEV_W — its height / DEV_H must agree — and ORIGIN_X /
# ORIGIN_Y are the screen point of its top-left corner AS DRAWN. Set ROTATED=1
# when the status bar is drawn at the BOTTOM of the window.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SIM="${SIM:-CD425710-939D-4E4D-A878-6B4283B72760}"   # iPhone 16 Pro Max
BUNDLE_ID="com.willitrain.WillItRain"
OUTDIR="${OUTDIR:-$REPO/data/wir-icon-adopt}"   # the committed evidence lives here
APP="$REPO/.build/la-shots/Build/Products/Debug-iphonesimulator/WillItRain.app"

# Calibration, in macOS screen POINTS. See the header.
ORIGIN_X=304        # screen x of the DRAWN device-screen rectangle's top-left corner
ORIGIN_Y=132.5      # screen y of that same corner. Under ROTATED=1 the corner shows
                    # device pixel (DEV_W, DEV_H), NOT (0,0): map_pt mirrors before it
                    # scales, so (0,0) lands at the rectangle's bottom-right.
SCALE=0.31          # screen points per device pixel
ROTATED=1           # window draws the device upside-down
DEV_W=1320
DEV_H=2868

# Refuse the three ways this run can do damage, before it touches anything: it
# needs an operator watching (capture 3 cannot be confirmed otherwise), it needs
# the tool that drives every GUI pass, and it writes into the directory holding
# the committed evidence.
[ -t 0 ] || { echo "ABORT: this harness needs an operator on a terminal (stdin is not a tty)."; exit 2; }
CLICLICK="$(command -v cliclick 2>/dev/null || true)"
[ -x "${CLICLICK:-}" ] || {
  echo "ABORT: cliclick is not installed or not executable (brew install cliclick)."
  echo "       Every GUI pass is driven by it: without it the long press, the Home"
  echo "       Screen paging and Spotlight all silently do nothing, and the captures"
  echo "       come out plausible-looking but wrong."
  exit 2
}
if [ "${OVERWRITE:-0}" != 1 ] && compgen -G "$OUTDIR/*-icon.png" >/dev/null; then
  echo "ABORT: $OUTDIR already holds captures; a re-run would overwrite committed evidence."
  echo "       Re-run with OVERWRITE=1 to re-capture, or set OUTDIR elsewhere."
  exit 2
fi

mkdir -p "$OUTDIR/native"

[ -d "$APP" ] || { echo "No Debug build at $APP — build first:"; \
  echo "  xcodebuild -project WillItRain/WillItRain.xcodeproj -scheme WillItRain \\"; \
  echo "    -configuration Debug -destination 'platform=iOS Simulator,id=$SIM' \\"; \
  echo "    -derivedDataPath .build/la-shots build"; exit 1; }
[ -d "$APP/PlugIns/WillItRainWidgets.appex" ] || { echo "Widget extension missing"; exit 1; }

# The one input helper that is deliberately best-effort: re-activating the window
# is not itself state a capture depends on, and the steps below fail loudly on
# their own if the window never came forward. Every OTHER osascript that drives
# input propagates its status, because an input step that silently did nothing
# means screenshotting whatever was already on screen and labelling it evidence.
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
  if ! osascript >/dev/null 2>&1 <<'EOS'
tell application "System Events" to tell process "Simulator"
  keystroke "h" using {command down, shift down}
end tell
EOS
  then
    echo "    FAIL: Cmd+Shift+H did not reach the Simulator — is this terminal allowed"
    echo "          to control System Events (Privacy & Security > Automation)?"
    return 1
  fi
}

# A Device menu item must have its parent menu opened first, or the click is
# silently swallowed.
devmenu() {
  focus
  if ! osascript >/dev/null 2>&1 <<EOS
tell application "System Events" to tell process "Simulator"
  click menu bar item "Device" of menu bar 1
  delay 0.8
  click menu item "$1" of menu 1 of menu bar item "Device" of menu bar 1
end tell
EOS
  then
    echo "    FAIL: Device > $1 did not click — no such menu item, or this terminal is"
    echo "          not allowed to control System Events (Privacy & Security > Automation)?"
    return 1
  fi
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
  [ -n "${h:-}" ] || {
    echo "ABORT: could not read the Simulator's window geometry. Either it has no window"
    echo "       (Mac screen locked?), or this terminal is not allowed to control System"
    echo "       Events (Privacy & Security > Automation) — which every input step here"
    echo "       needs, so this check is also the up-front probe for that permission."
    exit 2
  }
  echo "window ${w}x${h} at ($x,$y)"
  if [ "$w" -ne 462 ] || [ "$h" -ne 988 ] || [ "$x" -ne 278 ] || [ "$y" -ne 53 ]; then
    echo "ABORT: expected the 462x988 window at (278,53) this script is calibrated for."
    echo "       Got ${w}x${h} at ($x,$y). Re-derive ORIGIN_X/ORIGIN_Y/SCALE/ROTATED by"
    echo "       hand as the header describes, and update the constants above."
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

# Long press that screenshots WHILE the finger is down. The Dynamic Island
# collapses the moment it is released, so a shot taken after `du` catches the
# compact presentation instead — which is exactly how the previous round's
# "expanded" captures came out compact.
#
# A failed press must never fall through to the screenshot: that is the same
# failure by another route, an unpressed island captured under an "expanded"
# name. Every input step below therefore reports instead of being swallowed.
press_shot() {  # press_shot <dx> <dy> <hold_s> <basename> [crop x y w h]
  local dx="$1" dy="$2" hold="$3"; shift 3
  local p; p=$(map_pt "$dx" "$dy"); set -- $p "$@"
  local sx="$1" sy="$2"; shift 2
  focus
  cliclick m:"$sx","$sy" >/dev/null 2>&1 \
    || { echo "    FAIL: cliclick could not move to ($sx,$sy) for the long press"; return 1; }
  sleep 0.4
  cliclick dd:"$sx","$sy" >/dev/null 2>&1 \
    || { echo "    FAIL: cliclick could not press at ($sx,$sy)"
         cliclick du:"$sx","$sy" >/dev/null 2>&1 || true; return 1; }
  sleep "$hold"
  # The shot must never abort this function: under `set -e` a failed screenshot
  # would skip the release below and leave the mouse button physically held
  # down on the user's desktop. Take the status, release, then report it.
  local status=0
  shot "$@" || status=$?
  cliclick du:"$sx","$sy" >/dev/null 2>&1 \
    || { echo "    FAIL: cliclick could not release the press at ($sx,$sy)"; status=1; }
  return "$status"
}

drag() {  # drag <dx1> <dy1> <dx2> <dy2>
  local a b; a=$(map_pt "$1" "$2"); b=$(map_pt "$3" "$4")
  set -- $a $b
  focus
  cliclick dd:"$1","$2" m:"$3","$4" w:250 du:"$3","$4" >/dev/null 2>&1 \
    || { echo "    FAIL: cliclick could not drag ($1,$2) -> ($3,$4)"
         cliclick du:"$3","$4" >/dev/null 2>&1 || true; return 1; }
}

typed() {
  focus
  osascript >/dev/null 2>&1 -e "tell application \"System Events\" to keystroke \"$1\"" \
    || { echo "    FAIL: could not type \"$1\" — is this terminal allowed to control"
         echo "          System Events (Privacy & Security > Automation)?"; return 1; }
}

status_bar_override() {
  xcrun simctl status_bar "$SIM" override --time "9:41" \
    --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiBars 3 >/dev/null 2>&1 || true
}

# shot <basename> [crop x y w h]
#
# The crops in $OUTDIR are committed evidence, so a capture never overwrites one
# unless the operator asks for it with OVERWRITE=1. Producing nothing is always
# better here than producing a plausible-looking wrong file.
shot() {
  local base="$1"; shift
  if [ $# -eq 4 ] && [ "${OVERWRITE:-0}" != 1 ] && [ -e "$OUTDIR/${base}-icon.png" ]; then
    echo "    REFUSING to overwrite ${base}-icon.png (committed evidence)."
    echo "    Re-run with OVERWRITE=1 to re-capture, or set OUTDIR elsewhere."
    return 1
  fi
  local native="$OUTDIR/native/${base}.png"
  rm -f "$native"
  # Every failure below is reported by returning non-zero rather than by letting
  # `set -e` fire: callers reached through `||` run with errexit suppressed, so
  # a bare failing command there would fall through and be reported as success.
  xcrun simctl io "$SIM" screenshot --type=png "$native" >/dev/null 2>&1 || true
  [ -s "$native" ] || { echo "    FAIL screenshot $base"; return 1; }
  echo "    wrote native/${base}.png"
  if [ $# -eq 4 ]; then
    if ! python3 - "$native" "$OUTDIR/${base}-icon.png" "$OUTDIR/${base}-icon-4x.png" "$@" <<'PY'
import sys
from PIL import Image
src, out1, out4, x, y, w, h = sys.argv[1], sys.argv[2], sys.argv[3], *map(int, sys.argv[4:8])
c = Image.open(src).crop((x, y, x + w, y + h))
c.save(out1)
c.resize((w * 4, h * 4), Image.NEAREST).save(out4)
PY
    then
      echo "    FAIL crop $base"
      return 1
    fi
    echo "    wrote ${base}-icon.png + -icon-4x.png"
  fi
}

# Checks that SOME plausible Settings list row is at the crop rectangle: a light
# list row carrying a distinctly darker tile at its left edge. Measured on the
# committed capture that is 231 against 62, and every other pane this harness
# visits reads below 60 on the light side, so it catches the Home Screen, the
# lock screen, Spotlight and the Settings root.
#
# That is ALL it proves. It is NOT evidence the row belongs to this app: every
# row in Settings > Apps has the same shape, and the crop rectangle is a fixed
# absolute position while the Apps list is ordered by whatever apps are
# installed. On a simulator whose app set differs from the one the committed
# evidence was captured on, a neighbouring app's row sits at that position and
# passes this check unchanged. Confirming the row is the right one is the
# operator's job; what keeps a wrong crop out of the repo is `shot` refusing to
# overwrite an existing capture without OVERWRITE=1.
verify_settings_row() {  # verify_settings_row <x> <y> <w> <h>
  local probe; probe="$(mktemp -d)/settings-probe.png"
  xcrun simctl io "$SIM" screenshot --type=png "$probe" >/dev/null 2>&1 || true
  [ -s "$probe" ] || { echo "    ABORT: could not screenshot to check the pane"; return 1; }
  python3 - "$probe" "$@" <<'PY'
import sys
from PIL import Image, ImageStat
src, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:6])
row = Image.open(src).crop((x, y, x + w, y + h)).convert("L")
tile = ImageStat.Stat(row.crop((64, 40, 151, 130))).mean[0]
rest = ImageStat.Stat(row.crop((200, 40, 550, 130))).mean[0]
if rest <= 170 or tile >= rest - 100:
    sys.exit(f"    ABORT: no Settings list row at the crop rectangle "
             f"(row {rest:.0f}, tile {tile:.0f}; want a light row with a darker tile)")
PY
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
# guess a tap — a miss here captures the wrong pane and looks like a real result
# — this tries the deep link and has the operator confirm.
#
# The crop rectangle is absolute, so it only frames THIS app's row on a
# simulator whose Settings > Apps ordering matches the machine the committed
# evidence came from. Nothing here can check that, which is why the operator is
# asked to confirm the row itself and not merely that Settings is open.
SETTINGS_ROW=(55 1755 560 175)
echo; echo "=== 3/6: Settings > Apps (29pt @3x — the 87px asset) ==="
home; sleep 1
xcrun simctl openurl "$SIM" "App-Prefs:root=APPS" >/dev/null 2>&1 \
  || xcrun simctl launch "$SIM" com.apple.Preferences >/dev/null 2>&1 || true
sleep 3
echo "    open Settings > Apps, then confirm the Gonna Rain? row is the one the"
echo "    crop will take (device-pixel y=${SETTINGS_ROW[1]}; compare it against the"
echo "    committed 03-settings-apps-icon.png) before pressing return"
read -r _
status_bar_override
verify_settings_row "${SETTINGS_ROW[@]}"
shot "03-settings-apps" "${SETTINGS_ROW[@]}"

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
