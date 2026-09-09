#!/bin/bash
# Probe WeatherKit's forecastNextHour.summary against real coordinates.
#
#   export ADMIN_TOKEN='<the secret>'
#   ./test/probe-weatherkit-summary.sh                    # default location set
#   ./test/probe-weatherkit-summary.sh 41.8781 -87.6298   # one coordinate
#
# Why this exists: the wintry Live Activity depends on
# `forecastNextHour.summary[].condition` to tell snow from rain, and nothing in
# the app or the Worker can tell you whether that field is real — a wrong guess
# fails *quietly*, with `precipFromForecast` returning its 'rain' default
# forever. The cron logs the summary, but only for a grid that already has a
# registered device AND active precipitation, so it can go months without
# printing. This asks directly.
#
# `dryRun: true` means no push is sent, so any coordinate can be probed without
# a device there and without anyone's phone buzzing.
#
# ---------------------------------------------------------------------------
# What was observed 2026-07-27 (first real confirmation):
#
#   Chicago, raining      -> summary ["rain","clear"]   precip=rain
#   dry locations         -> summary ["clear"]          precip=rain (default)
#   Belfast, light rain   -> summary ["clear"]          precip=rain
#     ...while `minutes` DID show precipitation (chance 0.31). Apple's summary
#     applies a higher confidence bar than our own `chance > 0.3` isWet test.
#     Consequence: very light snow may be detected minute-wise but summarised
#     as "clear", and would then render as rain. Known limitation, not a bug —
#     the fallback is deliberately 'rain'.
#   Queenstown NZ, Bariloche AR -> summary null   (no forecastNextHour there)
#   Bergen NO                   -> summary []     (covered, but no minutes)
#     Both degrade to 'rain' without throwing, which is the intent.
#
# So: the field is REAL, values are lowercase bare nouns, and periods are in
# chronological order. `precipFromForecast` resolves the period for the moment
# the push is about — the upcoming rain start, or what is falling now once it
# is already raining — so "snow starting in 40 min" reads wintry rather than
# clear. The rule itself is documented on the function in src/index.ts;
# /test-cron applies it exactly as the cron does, so a probe taken while it is
# raining reports what the cron would push.
#
# STILL UNPROVEN: a wintry value has not been observed in the wild (probed in
# July; Perisher AU is covered and in season, so it is the best target come
# southern-hemisphere snow). `precipFromForecast` exact-matches the documented
# lowercase values snow, sleet, hail and mixed; anything else resolves to rain,
# which is why this probe echoes the raw `summary` next to the derived `precip`.
# ---------------------------------------------------------------------------

set -uo pipefail

WORKER="${WORKER:-https://will-it-rain.albertwxu.workers.dev}"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN is not set. It is a Worker secret — keep it in your password"
  echo "manager, never in this repo. Then: export ADMIN_TOKEN='<value>'"
  exit 1
fi

# /test-cron requires a well-formed device token even for a dry run. This one is
# deliberately fake: dryRun skips the push, so it is never sent to APNs.
TOKEN='0000000000000000000000000000000000000000000000000000000000000001'

probe() {
  printf '%-16s ' "$1"
  curl -s -X POST "$WORKER/test-cron" \
    -H "Content-Type: application/json" \
    -H "X-Admin-Token: $ADMIN_TOKEN" \
    -d "{\"token\":\"$TOKEN\",\"lat\":$2,\"lon\":$3,\"dryRun\":true}"
  echo
}

if [ $# -eq 2 ]; then
  probe "custom" "$1" "$2"
  exit 0
fi

# A spread of coverage cases rather than a list of cities: somewhere usually wet,
# somewhere usually dry, a covered southern-hemisphere ski area for wintry
# values in season, and two places with no forecastNextHour at all so the
# graceful-degradation path stays exercised.
echo "== covered, temperate =="
probe "Chicago"      41.8781 -87.6298
probe "Seattle"      47.6062 -122.3321
probe "Belfast"      54.5973 -5.9301
echo
echo "== covered, wintry in southern-hemisphere winter =="
probe "Perisher AU"  -36.4056 148.4048
echo
echo "== NOT covered — must degrade to precip=rain, never throw =="
probe "Queenstown NZ" -45.0312 168.6626
probe "Bariloche AR"  -41.1335 -71.3103

cat <<'EOF'

Read the `summary` field. What matters:
  * it is present (not missing) wherever forecastNextHour is covered
  * values are lowercase bare nouns: "clear", "rain", and — the open question —
    "snow" / "sleet" / "hail" / "mixed"
  * `precip` is "wintry" only when a wintry condition appears; "rain" otherwise
  * uncovered regions return null/[] and still report precip=rain, not an error

If `summary` is ever absent from a covered location, snow will silently render
as rain everywhere. That is the regression this probe exists to catch.
EOF
