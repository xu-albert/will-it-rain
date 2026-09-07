#!/bin/bash
# Everything CI runs, headlessly, in one command — the executable form of
# TESTING.md section 12. Used by the no-mistakes test step (.no-mistakes.yaml)
# so that step runs a fixed command instead of an exploratory agent, and by
# anyone who wants the release gate locally.
#
#   ./scripts/test-headless.sh            # backend + iOS
#   ./scripts/test-headless.sh backend    # backend only
#   ./scripts/test-headless.sh ios        # iOS only
#
# Backend: npm ci, typecheck, vitest, and a wrangler deploy --dry-run (never a
# real deploy). iOS: build-for-testing on the generic simulator destination,
# then test-without-building on the iPhone 17 Pro simulator, exactly the
# invocation AGENTS.md "Build & test" prescribes. Never opens Simulator.app.
#
# The simulator is booted explicitly and given time to settle before the test
# host is launched: launching straight after a boot (or another lane's
# shutdown) fails preflight with "Busy" and executes zero tests, which reads
# like a test failure but is not one. The device is shut down afterwards
# because nothing here should leave a simulator running on someone's desk.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$REPO/WillItRain/WillItRain.xcodeproj"
SCHEME="WillItRain"
SIM_NAME="${SIM_NAME:-iPhone 17 Pro}"
DERIVED="${DERIVED_DATA:-$REPO/DerivedData}"
WHAT="${1:-all}"

run_backend() {
  echo "== backend: npm ci, typecheck, vitest, wrangler dry-run"
  (
    cd "$REPO/backend"
    npm ci --no-audit --no-fund
    npm run typecheck
    npm test
    npx wrangler deploy --dry-run
  )
}

run_ios() {
  mkdir -p "$DERIVED"
  echo "== iOS: build-for-testing"
  xcodebuild build-for-testing \
    -project "$PROJECT" -scheme "$SCHEME" \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    -quiet

  # More than one simulator can carry this name (each installed iOS runtime
  # adds one), and one of them may be booted by another session. Pick a
  # shut-down one on the NEWEST runtime — what `name=` resolves to and what the
  # CI image has — and address it by UDID, so this never drives, or shuts down,
  # someone else's. Older runtimes are not a target: on the iOS 26.2 device the
  # test host crashed on every relaunch, in tests untouched for months.
  SIM_UDID=$(xcrun simctl list devices available \
    | awk -v name="$SIM_NAME (" '
        /^-- iOS / { split($0, parts, " "); runtime = parts[3] }
        index($0, name) && /\(Shutdown\)/ {
          match($0, /[0-9A-F-]{36}/)
          print runtime, substr($0, RSTART, RLENGTH)
        }' \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -1 | cut -d" " -f2)
  if [ -z "$SIM_UDID" ]; then
    echo "No shut-down simulator named '$SIM_NAME' is available:"
    xcrun simctl list devices available | grep -F "$SIM_NAME (" || true
    return 1
  fi
  echo "== iOS: boot $SIM_NAME ($SIM_UDID) and wait for it to settle"
  xcrun simctl boot "$SIM_UDID"
  xcrun simctl bootstatus "$SIM_UDID" -b
  sleep 15

  echo "== iOS: test-without-building on $SIM_NAME ($SIM_UDID)"
  xcodebuild test-without-building \
    -project "$PROJECT" -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,id=$SIM_UDID" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    | tee "$DERIVED/test-headless.log" \
    | grep -E "Test Suite '.*' (started|passed|failed)|Executed [0-9]+ tests|error:|\*\* TEST" \
    || true
  # grep's own exit code is not the verdict; the log's summary line is.
  xcrun simctl shutdown "$SIM_UDID" >/dev/null 2>&1 || true
  if grep -q "\*\* TEST EXECUTE FAILED \*\*" "$DERIVED/test-headless.log"; then
    echo "iOS tests failed (full log: $DERIVED/test-headless.log)"
    return 1
  fi
  if ! grep -q "Test Suite 'All tests' passed" "$DERIVED/test-headless.log"; then
    echo "iOS tests did not run to completion (full log: $DERIVED/test-headless.log)"
    return 1
  fi
}

case "$WHAT" in
  all) run_backend; run_ios ;;
  backend) run_backend ;;
  ios) run_ios ;;
  *) echo "usage: $0 [all|backend|ios]"; exit 2 ;;
esac

echo "== all green"
