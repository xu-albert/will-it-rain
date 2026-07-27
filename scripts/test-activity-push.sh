#!/bin/bash
# Drive a real server -> Live Activity push at a real device.
#
#   export ADMIN_TOKEN='<the secret>'
#   ./scripts/test-activity-push.sh <device-token>            # full sequence
#   ./scripts/test-activity-push.sh <device-token> wintry     # one push
#
# This is the last untested link in the chain. Everything else has been proven:
# the app renders both palettes (scripts/test-live-activity.sh), the Worker
# derives `precip` correctly (backend/test/probe-weatherkit-summary.sh), and
# alert pushes reach real phones. What had never run even once is the server
# pushing a *content-state* at a *real activity token* — and that is the path
# that decides what a card says during an actual storm.
#
# It matters because `content-state` is a full replacement, not a merge. The
# server's payload, not the app's, decides whether a card reads as snow or rain
# from the next cron tick onward.
#
# ---------------------------------------------------------------------------
# BEFORE RUNNING — get an activity onto the phone with a push token
#
#   1. Build to the device from Xcode in **Debug**. A TestFlight/Release build
#      strips the `#if DEBUG` scenario harness, so nothing will start.
#   2. Launch with the argument `-liveActivityScenario BS` (Xcode: Edit Scheme >
#      Run > Arguments). BS is the wintry "snowing now" state.
#   3. Watch the Xcode console for:
#           [LiveActivity] Push token: <hex>
#      That line is the whole point. Until it appears the server literally
#      cannot reach the activity — an activity started with `pushType: nil` has
#      no token at all, which is why the harness now requests `.token`.
#   4. Find the device token in the same console:
#           [Push] Stored device token: <hex>
#      That hex is this script's argument. (The Worker is keyed by device token
#      and looks the activity token up from it.)
#   5. Lock the phone so the card is visible.
# ---------------------------------------------------------------------------

set -uo pipefail

WORKER="${WORKER:-https://will-it-rain.albertwxu.workers.dev}"
DEVICE_TOKEN="${1:-}"
ONE_SHOT="${2:-}"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
info() { printf '\033[2m      %s\033[0m\n' "$1"; }

if [ -z "$DEVICE_TOKEN" ]; then
  echo "usage: $0 <device-token> [rain|wintry|legacy|end]"
  echo
  echo "Get the device token from the Xcode console: '[Push] Stored device token: <hex>'"
  exit 1
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN is not set. It is a Worker secret — keep it in your password"
  echo "manager, never in this repo. Then: export ADMIN_TOKEN='<value>'"
  exit 1
fi

failures=0

# push <label> <json-fragment> <expected-http-status>
push() {
  local label="$1" fragment="$2" expect="${3:-200}"
  local body status
  body=$(curl -s -w '\n%{http_code}' -X POST "$WORKER/test-activity" \
    -H "Content-Type: application/json" \
    -H "X-Admin-Token: $ADMIN_TOKEN" \
    -d "{\"token\":\"$DEVICE_TOKEN\"$fragment}")
  status=$(printf '%s' "$body" | tail -1)
  body=$(printf '%s' "$body" | sed '$d')

  if [ "$status" = "$expect" ]; then
    pass "$label"
    info "$body"
  else
    fail "$label (HTTP $status, wanted $expect)"
    info "$body"
    if [ "$status" = "409" ]; then
      info "No activity is running, or the app never reported a push token."
      info "Re-read the BEFORE RUNNING block at the top of this script."
    fi
    failures=$((failures + 1))
  fi
}

case "$ONE_SHOT" in
  rain)   push "rain push"   ',"precip":"rain"';   exit $failures ;;
  wintry) push "wintry push" ',"precip":"wintry"'; exit $failures ;;
  legacy) push "legacy push" '';                   exit $failures ;;
  end)    push "end push"    ',"event":"end"';     exit $failures ;;
esac

echo "Pushing to device ${DEVICE_TOKEN:0:8}…  Watch the phone's lock screen."
echo

push "1/3  wintry — card must turn pale with a snowflake" ',"precip":"wintry","minutesUntil":30'
sleep 8
push "2/3  rain — card must turn cyan with a droplet"     ',"precip":"rain","minutesUntil":18'
sleep 8
# The regression that has no error message. A pre-1.1.1 Worker sends no `precip`
# at all; if the field were ever made non-optional, ActivityKit would fail to
# decode this and the card would freeze — no crash, no log, just a card that
# quietly stops updating. It must render as rain and keep ticking.
push "3/3  legacy — no precip field at all; must render rain and keep ticking" ',"minutesUntil":11'

cat <<'EOF'

Check the phone — these are the assertions a script cannot make:

  1. wintry  pale near-white track, white glow, snowflake, "Snow incoming"
  2. rain    cyan track, droplet, "Rain incoming"
  3. legacy  identical to 2, and the countdown is STILL TICKING

Step 3 is the one that matters. A frozen or blank card there means `precip` has
been made non-optional and ActivityKit can no longer decode a payload from an
older Worker — which in production looks like an activity that silently stops
updating, with nothing in any log to explain it.

To dismiss:  ./scripts/test-activity-push.sh <device-token> end
EOF

exit "$failures"
