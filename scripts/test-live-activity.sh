#!/bin/bash
# Live Activity visual regression harness for Gonna Rain?
#
# Usage:
#   ./scripts/test-live-activity.sh                 # all scenarios
#   ./scripts/test-live-activity.sh BS BX           # only these
#   OUTDIR=/tmp/shots ./scripts/test-live-activity.sh
#
# Drives the in-app `-liveActivityScenario` harness across every design state
# and captures the Dynamic Island for each, so a palette or glyph regression is
# visible in a diff rather than discovered by a user mid-storm.
#
# ---------------------------------------------------------------------------
# READ THIS BEFORE CHANGING ANYTHING
#
# The scenario harness lives behind `#if DEBUG`. A RELEASE build strips it
# entirely and the app launches perfectly normally — no crash, no error, no log
# line — it simply never starts an activity. Several confusing hours are
# available to anyone who forgets this, so the script forces a Debug build and
# refuses to trust a prebuilt binary.
#
# Two more traps found the hard way:
#   * `print()` from the app does NOT reach most log-capture wrappers. Console
#     output only arrives via `simctl launch --console-pty`.
#   * The Live Activity is only visible once the app is BACKGROUNDED (compact
#     Dynamic Island) or the device is locked. A foreground screenshot shows
#     the app, not the activity.
#
# Two passes, because the two presentations need opposite things:
#
#   1. Dynamic Island  — needs the app backgrounded. Real ActivityKit render.
#   2. Lock-screen card — needs the app foregrounded, via the app's
#      `-liveActivityCards` debug screen. The real lock screen is unreachable
#      from a script (`simctl` has no lock command; Simulator's Device ▸ Lock
#      over osascript fails silently too often), and the card is where every
#      part of the palette that the island does not show actually lives — the
#      track, its glow, and the ring around the "now" dot.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$REPO/WillItRain/WillItRain.xcodeproj"
SCHEME="WillItRain"
BUNDLE_ID="com.willitrain.WillItRain"

# Must be a Dynamic Island device, or the compact presentation has nowhere to go.
SIM_NAME="${SIM_NAME:-iPhone 16 Pro}"
OUTDIR="${OUTDIR:-$REPO/screenshots/live-activity}"

# A|B|C rain · AS|BS|CS wintry · BX legacy payload with `precip` absent
ALL_SCENARIOS=(A B C AS BS CS BX)
SCENARIOS=("${@:-${ALL_SCENARIOS[@]}}")

SETTLE=4   # seconds for the activity to appear and the countdown to start

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
info() { printf '\033[2m      %s\033[0m\n' "$1"; }

failures=0

# Capture the simulator screen to <path>.
#
# The `rm -f` is load-bearing. macOS attaches a per-file access ACL
# (com.apple.macl) to screenshots, keyed to whichever app created them, and
# simctl is denied when it tries to overwrite a PNG some *other* process wrote
# — an earlier run under a different agent, say. It fails with EPERM
# ("You don't have permission"), not a file-mode error, so `ls` shows nothing
# wrong. Unlinking first sidesteps the ACL completely.
#
# Failure is counted, not fatal: under `set -e` a single denied write used to
# abort the whole run mid-scenario, which reads like the harness hanging.
capture_shot() {
  local path="$1" label="$2"
  rm -f "$path"
  if ! xcrun simctl io "$SIM_UDID" screenshot --type=png "$path" >/dev/null 2>&1 \
     || [ ! -s "$path" ]; then
    fail "screenshot failed: $label"
    failures=$((failures + 1))
    return 0
  fi
  pass "wrote $(basename "$path")"
}

mkdir -p "$OUTDIR"

# --- resolve simulator -----------------------------------------------------
SIM_UDID=$(xcrun simctl list devices available \
  | grep -F "$SIM_NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
if [ -z "$SIM_UDID" ]; then
  fail "No available simulator named '$SIM_NAME'."
  info "Available: $(xcrun simctl list devices available | grep -E 'iPhone' | sed 's/^ *//' | head -5)"
  exit 1
fi
info "Simulator: $SIM_NAME ($SIM_UDID)"

# Booting a device that is mid-transition fails with "Unable to lookup in
# current state: Shutting Down", so wait out any transition first.
sim_state() {
  xcrun simctl list devices | grep -F "$SIM_UDID" \
    | sed -E 's/.*\((Booted|Shutdown|Shutting Down|Booting)\).*/\1/'
}
for _ in $(seq 1 45); do
  case "$(sim_state)" in
    "Shutting Down"|"Booting") sleep 2 ;;
    *) break ;;
  esac
done
[ "$(sim_state)" = "Booted" ] || xcrun simctl boot "$SIM_UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$SIM_UDID"
xcrun simctl bootstatus "$SIM_UDID" -b >/dev/null 2>&1 || true
[ "$(sim_state)" = "Booted" ] || { fail "Simulator never reached Booted (state: $(sim_state))"; exit 1; }

# --- build (Debug, non-negotiable; see header) -----------------------------
info "Building Debug (Release would strip the harness)…"
BUILD_LOG=$(mktemp)
if ! xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$SIM_UDID" \
      -derivedDataPath "$REPO/.build/live-activity-test" \
      build >"$BUILD_LOG" 2>&1; then
  fail "Build failed."
  grep -E "error:|warning: .*never used" "$BUILD_LOG" | head -40
  info "Full log: $BUILD_LOG"
  exit 1
fi
APP_PATH="$REPO/.build/live-activity-test/Build/Products/Debug-iphonesimulator/WillItRain.app"
[ -d "$APP_PATH" ] || { fail "Built, but no app at $APP_PATH"; exit 1; }
[ -d "$APP_PATH/PlugIns/WillItRainWidgets.appex" ] \
  || { fail "Widget extension missing from bundle — the Live Activity cannot render."; exit 1; }
pass "Build (app + widget extension embedded)"

xcrun simctl install "$SIM_UDID" "$APP_PATH"
xcrun simctl status_bar "$SIM_UDID" override --time "9:41" \
  --batteryState charged --batteryLevel 100 --wifiBars 3 >/dev/null 2>&1 || true

# --- pass 1: Dynamic Island ------------------------------------------------
echo
echo "=== pass 1/2: Dynamic Island ==="
for code in "${SCENARIOS[@]}"; do
  echo
  echo "--- scenario $code ---"
  xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  sleep 1

  # --console-pty is the only reliable way to see the app's print() output.
  CONSOLE=$(mktemp)
  ( xcrun simctl launch --console-pty "$SIM_UDID" "$BUNDLE_ID" \
      -liveActivityScenario "$code" >"$CONSOLE" 2>&1 & ) || true
  sleep "$SETTLE"

  if grep -q "Started scenario $code" "$CONSOLE"; then
    pass "activity started"
  else
    fail "activity did NOT start for $code"
    info "$(grep -i 'liveactivity' "$CONSOLE" | head -3)"
    info "If every scenario fails here, you are almost certainly running a Release build."
    failures=$((failures + 1))
  fi

  # Background our app so the compact Dynamic Island is what's on screen.
  #
  # Launching another app is deterministic. Sending Cmd+Shift+H via osascript is
  # NOT: it depends on Simulator being frontmost and on Accessibility
  # permissions, and when it silently fails you get a screenshot of this app's
  # loading screen while the script still reports success.
  # The compact Dynamic Island only renders while OUR app is backgrounded, so
  # something else has to take the foreground.
  #
  # Which system apps exist varies by simulator image — Clock is absent from
  # some — so try candidates and confirm one actually launched instead of
  # assuming. Settings is deliberately excluded: it can land on an Apple Account
  # sign-in sheet, which would put the user's email and a password field into
  # every screenshot this script commits.
  backgrounded=false
  for filler in com.apple.mobilecal com.apple.mobileslideshow com.apple.Maps com.apple.mobilesafari; do
    if xcrun simctl launch "$SIM_UDID" "$filler" >/dev/null 2>&1; then
      backgrounded=true
      FILLER="$filler"
      break
    fi
  done
  if [ "$backgrounded" = false ]; then
    fail "could not background the app — the island will be empty in this shot"
    info "No usable filler app found. Install one, or lock the simulator by hand."
    failures=$((failures + 1))
  fi
  sleep 3

  # Deliberately NOT cropped to the island band. `sips` can only crop from the
  # centre — `--cropOffset` could not be made to reach the top strip at any sign
  # or magnitude, and it silently emits a transparent (apparently blank) image
  # when the window falls outside the source. A misleading blank screenshot is
  # worse than a full one, so keep the whole frame; the island is the top ~150px.
  capture_shot "$OUTDIR/scenario-${code}-island.png" "island $code"
done

[ -n "${FILLER:-}" ] && xcrun simctl terminate "$SIM_UDID" "$FILLER" >/dev/null 2>&1

# --- pass 2: lock-screen cards ---------------------------------------------
#
# Three cards per shot: any more and the last one runs off the bottom of the
# screen, which a screenshot cannot tell you about — it just looks like a
# shorter list.
echo
echo "=== pass 2/2: lock-screen cards ==="
group=()
capture_group() {
  [ ${#group[@]} -eq 0 ] && return 0
  local codes
  codes=$(IFS=,; echo "${group[*]}")
  echo
  echo "--- cards $codes ---"

  xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  sleep 1
  local console
  console=$(mktemp)
  ( xcrun simctl launch --console-pty "$SIM_UDID" "$BUNDLE_ID" \
      -liveActivityCards "$codes" >"$console" 2>&1 & ) || true
  sleep "$SETTLE"

  # The app must confirm it parsed the flag. Without this check a screenshot of
  # the ordinary app UI would pass silently — exactly the failure that made the
  # first version of this script report success while capturing a loading screen.
  if grep -q "Rendering cards" "$console"; then
    pass "card screen rendered"
  else
    fail "card screen did NOT render for $codes"
    info "$(grep -i 'liveactivity' "$console" | head -3)"
    info "A Release build strips this screen too — check the configuration."
    failures=$((failures + 1))
  fi

  capture_shot "$OUTDIR/cards-$(IFS=-; echo "${group[*]}").png" "cards $codes"
  group=()
}

for code in "${SCENARIOS[@]}"; do
  group+=("$code")
  [ ${#group[@]} -eq 3 ] && capture_group
done
capture_group

xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl status_bar "$SIM_UDID" clear >/dev/null 2>&1 || true

echo
echo "Screenshots: $OUTDIR"
cat <<'EOF'

  scenario-*-island.png   Dynamic Island (glyph + countdown only)
  cards-*.png             the lock-screen card — where the palette lives

Now check by eye — these are the assertions a script cannot make:

  A,  B,  C   cyan track, droplet glyph
  AS, BS, CS  pale near-white track, snowflake glyph, dark glyph in the header badge
  BX          MUST be identical to B (cyan, droplet) with a TICKING countdown

On the wintry cards specifically (this is the W1b palette):
  * the track is near-white with a WHITE halo, not a blue one
  * in BS the track starts at 0, directly under the "now" dot — the blue-grey
    ring is the only thing keeping those two whites apart. If the dot has
    dissolved into the track, the ring is too light or has gone missing
  * the snowflake in the header badge is dark navy. White-on-near-white means
    someone reused the rain badge colour

BX is the one that matters most. It carries a payload with no `precip` field,
standing in for a push from a Worker that predates it. If BX renders as snow the
default is inverted; if its card is frozen or blank, the field has been made
non-optional and ActivityKit is failing to decode — which in production looks
like an activity that silently stops updating.
EOF

exit "$failures"
