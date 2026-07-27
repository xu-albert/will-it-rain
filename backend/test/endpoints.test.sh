#!/bin/bash
# Endpoint contract tests for the Gonna Rain? Worker.
#
# Usage:
#   ./backend/test/endpoints.test.sh                    # local wrangler dev (default)
#   TARGET=https://will-it-rain.albertwxu.workers.dev \
#     ADMIN_TOKEN=<secret> ./backend/test/endpoints.test.sh --remote
#
# Runs entirely against local state by default, so it never writes junk into
# production KV and never spends WeatherKit quota.
#
# What it guards:
#   * /test-rain and /test-cron stay authenticated. They send real pushes and
#     spend real WeatherKit quota, and the Worker URL is extractable from the
#     shipped iOS binary, so an unauthenticated regression here is exploitable
#     by anyone who unzips the app.
#   * /register rejects malformed input BEFORE writing to KV. Unbounded
#     coordinates are a direct lever on a 500k/month quota, because the cron
#     makes one WeatherKit call per distinct grid cell.

set -uo pipefail

cd "$(dirname "$0")/.."

REMOTE=false
[ "${1:-}" = "--remote" ] && REMOTE=true

PORT=8899
TARGET="${TARGET:-http://127.0.0.1:$PORT}"
TOKEN_OK=$(printf 'a%.0s' {1..64})
# Well-formed but deliberately never registered, so 404-vs-409 can be told apart.
TOKEN_MISSING=$(printf 'b%.0s' {1..64})
ADMIN_TOKEN="${ADMIN_TOKEN:-local-test-secret}"

pass=0; fail=0
DEV_PID=""
CREATED_DEV_VARS=false

cleanup() {
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null
  # Only remove .dev.vars if this script created it — never clobber a real one.
  [ "$CREATED_DEV_VARS" = true ] && rm -f .dev.vars
  return 0
}
trap cleanup EXIT

check() { # name expected_status curl-args...
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@")
  if [ "$got" = "$want" ]; then
    printf '\033[32mok\033[0m    %-46s %s\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf '\033[31mFAIL\033[0m  %-46s got %s, want %s\n' "$name" "$got" "$want"
    fail=$((fail + 1))
  fi
}

if [ "$REMOTE" = false ]; then
  if [ ! -f .dev.vars ]; then
    CREATED_DEV_VARS=true
    cat > .dev.vars <<EOF
ADMIN_TOKEN=$ADMIN_TOKEN
APPLE_TEAM_ID=TEST
APPLE_KEY_ID=TEST
APPLE_PRIVATE_KEY=test
WEATHERKIT_SERVICE_ID=test
APNS_TOPIC=com.local.test
APNS_ENV=sandbox
EOF
  fi
  echo "Starting local worker on :$PORT …"
  npx wrangler dev --port "$PORT" --local >/tmp/gonnarain-wrangler-test.log 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "$TARGET/" && break
    sleep 1
  done
fi

echo
echo "== auth gate =="
check "/test-rain  unauthenticated" 401 -X POST "$TARGET/test-rain" -d "{\"token\":\"$TOKEN_OK\"}"
check "/test-rain  wrong secret"    401 -X POST "$TARGET/test-rain" -H "X-Admin-Token: wrong" -d "{\"token\":\"$TOKEN_OK\"}"
check "/test-cron  unauthenticated" 401 -X POST "$TARGET/test-cron" -d "{\"token\":\"$TOKEN_OK\",\"lat\":37.3,\"lon\":-122.0}"
check "/test-cron  wrong secret"    401 -X POST "$TARGET/test-cron" -H "X-Admin-Token: wrong" -d "{\"token\":\"$TOKEN_OK\",\"lat\":37.3,\"lon\":-122.0}"
# /test-activity pushes at a real device's live activity. Left open it would let
# anyone drive arbitrary text onto a stranger's lock screen.
check "/test-activity unauth"      401 -X POST "$TARGET/test-activity" -d "{\"token\":\"$TOKEN_OK\"}"
check "/test-activity wrong secret" 401 -X POST "$TARGET/test-activity" -H "X-Admin-Token: wrong" -d "{\"token\":\"$TOKEN_OK\"}"

echo
echo "== /register input validation =="
check "lat out of range"        400 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":9999,\"lon\":0}"
check "lon out of range"        400 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":0,\"lon\":9999}"
check "lat as string"           400 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":\"37.3\",\"lon\":-122.0}"
check "non-hex token"           400 -X POST "$TARGET/register" -d '{"token":"zzzz","lat":37.3,"lon":-122.0}'
check "KV key injection"        400 -X POST "$TARGET/register" -d "{\"token\":\"device:$TOKEN_OK\",\"lat\":37.3,\"lon\":-122.0}"
check "malformed JSON"          400 -X POST "$TARGET/register" -d '{not json'
check "empty body"              400 -X POST "$TARGET/register"
check "short activity token"    400 -X POST "$TARGET/register-activity" -d "{\"token\":\"$TOKEN_OK\",\"activityToken\":\"abc\"}"
check "unknown route"           404 -X POST "$TARGET/nope"

if [ "$REMOTE" = false ]; then
  # Writes only touch local KV, so these are safe to assert on.
  echo
  echo "== happy path (local only) =="
  check "valid registration"    200 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":37.3318,\"lon\":-122.0312,\"leadTimeMinutes\":20}"
  check "edge coords (0,0)"     200 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":0,\"lon\":0}"
  check "lead time clamped"     200 -X POST "$TARGET/register" -d "{\"token\":\"$TOKEN_OK\",\"lat\":37.3,\"lon\":-122.0,\"leadTimeMinutes\":99999}"
  check "authorized /test-rain" 500 -X POST "$TARGET/test-rain" -H "X-Admin-Token: $ADMIN_TOKEN" -d "{\"token\":\"$TOKEN_OK\"}"
  echo "      (500 above is correct: auth passed, then APNs rejected the dummy local credentials)"
  # The device registered just above has no activityToken, so this exercises the
  # 409 branch — the one a human hits when they forget to start an activity
  # first, and the one that would otherwise surface as a confusing APNs error.
  check "/test-activity, no activity" 409 -X POST "$TARGET/test-activity" -H "X-Admin-Token: $ADMIN_TOKEN" -d "{\"token\":\"$TOKEN_OK\"}"
  check "/test-activity, no device"   404 -X POST "$TARGET/test-activity" -H "X-Admin-Token: $ADMIN_TOKEN" -d "{\"token\":\"$TOKEN_MISSING\"}"
fi

echo
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
