#if DEBUG
import ActivityKit
import Foundation

/// Debug-only harness for visually QA'ing the Live Activity against the
/// design mockup (docs/design/live-activity/v3-final.png) without needing a
/// real forecast. Launch with `-liveActivityScenario <A|B|C>` to force one of
/// the three design states.
extension LiveActivityService {
    enum DebugScenario: String {
        case a = "A"
        case b = "B"
        case c = "C"

        var contentState: RainActivityAttributes.ContentState {
            let now = Date()
            switch self {
            case .a:
                // Approaching: countdown to first drop, single cyan stretch.
                return .init(
                    statusText: "Rain incoming",
                    countdownTarget: now.addingTimeInterval(12 * 60),
                    heroText: nil,
                    subBold: "Light rain",
                    subRest: " · lasts about 40 min",
                    boldFirst: true,
                    rightText: "San Francisco",
                    segments: [.init(start: 0.16, end: 0.50)],
                    windowMinutes: 120,
                    midLabel: "+1 hr",
                    endLabel: "+2 hr",
                    flagText: "4:33",
                    flagPosition: 0.16
                )
            case .b:
                // Raining now: countdown to when it stops, "now" dot inside the segment.
                return .init(
                    statusText: "Raining now",
                    countdownTarget: now.addingTimeInterval(39 * 60),
                    heroText: nil,
                    subBold: "stops around 4:33",
                    subRest: "Raining · ",
                    boldFirst: false,
                    rightText: "Moderate",
                    segments: [.init(start: 0.0, end: 0.43)],
                    windowMinutes: 90,
                    midLabel: "+45 min",
                    endLabel: "+90 min",
                    flagText: "4:33",
                    flagPosition: 0.43
                )
            case .c:
                // Intermittent: static hero word, three separate bursts.
                return .init(
                    statusText: "On & off",
                    countdownTarget: nil,
                    heroText: "Showers",
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
                    flagPosition: nil
                )
            }
        }
    }

    /// Parses `-liveActivityScenario <A|B|C>` out of the process launch
    /// arguments and, if present, ends any existing activities and starts a
    /// fresh one with the hard-coded ContentState for that scenario.
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
            let activity = try Activity.request(
                attributes: RainActivityAttributes(locationName: "San Francisco"),
                content: content,
                pushType: nil
            )
            print("[LiveActivity][Debug] Started scenario \(scenario.rawValue): \(activity.id)")
        } catch {
            print("[LiveActivity][Debug] Failed to start scenario \(scenario.rawValue): \(error)")
        }
    }
}
#endif
