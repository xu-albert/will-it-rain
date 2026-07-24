#!/bin/bash
# Take App Store screenshots for Gonna Rain?
# Usage: ./screenshots/take_screenshots.sh
#
# Prerequisites: Build the app first in Xcode (Release config recommended)
# The script uses the most recent build from DerivedData.

set -e

SIM="CD425710-939D-4E4D-A878-6B4283B72760"  # iPhone 16 Pro Max
BUNDLE_ID="com.willitrain.WillItRain"
OUTDIR="$(cd "$(dirname "$0")" && pwd)"
SCENARIOS=("nyc-rain" "chicago-snow-night" "sf-clear" "seattle-rain-soon")
WAIT_SECONDS=5  # Time for animations to settle

# Find the most recent build
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/WillItRain-*/Build/Products/*-iphonesimulator/WillItRain.app -maxdepth 0 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
    echo "Error: No build found. Build the app in Xcode first."
    exit 1
fi
echo "Using build: $APP_PATH"

# Boot simulator if needed
xcrun simctl boot "$SIM" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$SIM"
sleep 3

# Install app
xcrun simctl install "$SIM" "$APP_PATH"

# Clean status bar (9:41, full bars)
xcrun simctl status_bar "$SIM" override \
    --time "9:41" \
    --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 \
    --wifiBars 3

# Take screenshots
for scenario in "${SCENARIOS[@]}"; do
    echo "--- $scenario ---"
    xcrun simctl terminate "$SIM" "$BUNDLE_ID" 2>/dev/null || true
    sleep 1
    xcrun simctl launch "$SIM" "$BUNDLE_ID" -screenshot "$scenario"
    sleep "$WAIT_SECONDS"

    filename=$(echo "$scenario" | tr '-' '_')
    xcrun simctl io "$SIM" screenshot "$OUTDIR/${filename}_6.7.png" --type=png
    echo "Saved: ${filename}_6.7.png"
done

# Cleanup
xcrun simctl terminate "$SIM" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl status_bar "$SIM" clear

# Resize to App Store required dimensions (1284x2778 for 6.7" display)
# iPhone 16 Pro Max captures at 1320x2868; App Store accepts 1284x2778 or 1242x2688.
echo "Resizing screenshots to 1284x2778..."
for f in "$OUTDIR"/*_6.7.png; do
    sips -z 2778 1284 "$f" --out "$f" >/dev/null 2>&1
done

echo "Done! Screenshots saved to $OUTDIR"
