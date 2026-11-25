#if DEBUG
import SwiftUI

/// Debug-only screen that draws the Live Activity's lock-screen card for a set
/// of scenarios, so `scripts/test-live-activity.sh` can screenshot it.
///
///   -liveActivityCards A,B,C
///
/// Why this exists: the wintry palette's most delicate parts — the near-white
/// track, its glow, and the ring that keeps the "now" dot from disappearing
/// into it — appear ONLY on the lock-screen card. The Dynamic Island shows just
/// a glyph and a countdown. Reaching the real lock screen from a script is not
/// possible: `simctl` has no lock command, and driving Simulator's
/// Device ▸ Lock menu over osascript depends on window focus and Accessibility
/// permissions, and fails silently often enough to be useless in a harness.
///
/// So the card renders here instead, from the same views the widget uses
/// (Shared/LiveActivityCardViews.swift). What this does NOT reproduce is the
/// system chrome around it: the wallpaper behind, `activityBackgroundTint`, and
/// the platter's own corner masking. Everything inside the card is identical
/// code, which is where every palette decision lives.
struct LiveActivityCardPreview: View {
    let scenarios: [LiveActivityService.DebugScenario]

    var body: some View {
        ZStack {
            // Neutral backdrop, not the card's own navy — otherwise a card that
            // failed to draw its background would be invisible in the shot.
            Color(red: 0.04, green: 0.05, blue: 0.09).ignoresSafeArea()

            VStack(spacing: 14) {
                ForEach(scenarios, id: \.rawValue) { scenario in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(scenario.rawValue)
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.45))
                        LockScreenActivityView(state: scenario.contentState)
                            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .preferredColorScheme(.dark)
        .statusBarHidden()
    }
}

extension LiveActivityCardPreview {
    /// Parses `-liveActivityCards A,B,C`. Returns nil when the flag is absent,
    /// which is the signal to launch the app normally.
    static func fromLaunchArgs(_ args: [String]) -> LiveActivityCardPreview? {
        guard let idx = args.firstIndex(of: "-liveActivityCards"), idx + 1 < args.count else {
            return nil
        }
        let codes = args[idx + 1]
            .split(separator: ",")
            .compactMap { LiveActivityService.DebugScenario(rawValue: String($0)) }
        guard !codes.isEmpty else {
            AppLogger.activity.warning("-liveActivityCards matched no known scenarios: \(args[idx + 1])")
            return nil
        }
        let joinedCodes = codes.map(\.rawValue).joined(separator: ",")
        AppLogger.activity.debug("Rendering debug cards: \(joinedCodes)")
        // scripts/test-live-activity.sh verifies flag parsing via `simctl launch --console-pty` stdout.
        print("[LiveActivity][Debug] Rendering cards: \(joinedCodes)")
        return LiveActivityCardPreview(scenarios: codes)
    }
}
#endif
