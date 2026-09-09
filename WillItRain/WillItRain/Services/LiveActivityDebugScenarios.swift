#if DEBUG
import ActivityKit
import Foundation

/// Debug-only harness for visually QA'ing the Live Activity against the design
/// mockups without needing a real forecast.
///
///   -liveActivityScenario A | B | C      rain     (docs/design/live-activity/v3-final.png)
///   -liveActivityScenario AS | BS | CS   wintry   (snow-mockup-v3.html, variant W1b)
///   -liveActivityScenario BX             legacy payload with `precip` absent
///
/// BX exists because a missing `precip` is the one failure mode that produces no
/// error: if the field were ever made non-optional, ActivityKit would fail to
/// decode pushes from an older Worker and the card would freeze rather than
/// degrade. BX must render exactly like B.
extension LiveActivityService {
    enum DebugScenario: String {
        case a = "A"
        case b = "B"
        case c = "C"
        case aWintry = "AS"
        case bWintry = "BS"
        case cWintry = "CS"
        case bLegacy = "BX"

        /// Base geometry per design state, shared by the rain and wintry runs so
        /// the two differ only in styling and copy.
        private enum Shape { case approaching, active, intermittent }

        private var shape: Shape {
            switch self {
            case .a, .aWintry: return .approaching
            case .b, .bWintry, .bLegacy: return .active
            case .c, .cWintry: return .intermittent
            }
        }

        private var isWintry: Bool {
            switch self {
            case .aWintry, .bWintry, .cWintry: return true
            case .a, .b, .c, .bLegacy: return false
            }
        }

        var contentState: RainActivityAttributes.ContentState {
            let now = Date()
            // .bLegacy deliberately leaves this nil to mimic a payload from a Worker
            // that predates the field (anything before 1.1.2).
            let precip: RainActivityAttributes.Precip? =
                self == .bLegacy ? nil : (isWintry ? .wintry : .rain)

            switch shape {
            case .approaching:
                // Countdown to the first flake/drop, single stretch on the track.
                return .init(
                    statusText: isWintry ? "Snow incoming" : "Rain incoming",
                    countdownTarget: now.addingTimeInterval(12 * 60),
                    heroText: nil,
                    subBold: isWintry ? "Light snow" : "Light rain",
                    subRest: " · lasts about 40 min",
                    boldFirst: true,
                    rightText: isWintry ? "Chicago" : "San Francisco",
                    segments: [.init(start: 0.16, end: 0.50)],
                    windowMinutes: 120,
                    midLabel: "+1 hr",
                    endLabel: "+2 hr",
                    flagText: "4:33",
                    flagPosition: 0.16,
                    precip: precip
                )

            case .active:
                // Falling now: countdown to when it stops, "now" dot inside the segment.
                return .init(
                    statusText: isWintry ? "Snowing now" : "Raining now",
                    countdownTarget: now.addingTimeInterval(39 * 60),
                    heroText: nil,
                    subBold: "stops around 4:33",
                    subRest: isWintry ? "Snowing · " : "Raining · ",
                    boldFirst: false,
                    rightText: "Moderate",
                    segments: [.init(start: 0.0, end: 0.43)],
                    windowMinutes: 90,
                    midLabel: "+45 min",
                    endLabel: "+90 min",
                    flagText: "4:33",
                    flagPosition: 0.43,
                    precip: precip
                )

            case .intermittent:
                // Static hero word, three separate bursts.
                return .init(
                    statusText: "On & off",
                    countdownTarget: nil,
                    heroText: isWintry ? "Flurries" : "Showers",
                    subBold: "next burst in 8 min",
                    subRest: "On & off · ",
                    boldFirst: false,
                    rightText: "until 6 PM",
                    segments: [
                        .init(start: 0.06, end: 0.21),
                        .init(start: 0.38, end: 0.55),
                        .init(start: 0.72, end: 0.88)
                    ],
                    windowMinutes: 240,
                    midLabel: "+2 hr",
                    endLabel: "+4 hr",
                    flagText: nil,
                    flagPosition: nil,
                    precip: precip
                )
            }
        }
    }

    /// Parses `-liveActivityScenario <code>` out of the process launch arguments
    /// and, if present, ends any existing activities and starts a fresh one with
    /// the hard-coded ContentState for that scenario.
    static func startDebugScenarioIfRequested(launchArgs: [String]) async {
        guard let idx = launchArgs.firstIndex(of: "-liveActivityScenario"),
              idx + 1 < launchArgs.count,
              let scenario = DebugScenario(rawValue: launchArgs[idx + 1]) else { return }

        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            print("[LiveActivity][Debug] Activities not enabled on this device/simulator — cannot start scenario \(scenario.rawValue)")
            return
        }

        for activity in Activity<RainActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }

        let content = ActivityContent(state: scenario.contentState, staleDate: nil)
        do {
            // `.token`, not nil. An activity started with no push type cannot be
            // reached from the server at all, which made the whole
            // server -> Live Activity path impossible to exercise on demand:
            // the only activities with tokens were ones real weather had
            // started. With a token, `scripts/test-activity-push.sh` can drive
            // a real content-state push at a real activity.
            let activity = try Activity.request(
                attributes: RainActivityAttributes(locationName: "San Francisco"),
                content: content,
                pushType: .token
            )
            LiveActivityService.shared.observePushToken(for: activity)
            print("[LiveActivity][Debug] Started scenario \(scenario.rawValue): \(activity.id)")
        } catch {
            print("[LiveActivity][Debug] Failed to start scenario \(scenario.rawValue): \(error)")
        }
    }
}
#endif
