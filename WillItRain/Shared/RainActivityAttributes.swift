import ActivityKit
import Foundation

/// Shared between the app (starts/updates activities) and the widget extension
/// (renders them). ContentState is pushed over APNs too, so keep it small —
/// the whole payload must stay under 4KB.
nonisolated struct RainActivityAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
        nonisolated struct Segment: Codable, Hashable {
            /// Normalized 0…1 positions across the track window.
            var start: Double
            var end: Double
        }

        /// Header status, e.g. "Rain incoming" / "Raining now" / "On & off".
        var statusText: String
        /// Hero countdown target. When nil, `heroText` is shown instead.
        var countdownTarget: Date?
        /// Static hero, e.g. "Showers" (intermittent state).
        var heroText: String?
        /// Context line: the bold phrase and the rest. `boldFirst` controls order:
        /// "**Light rain** · lasts about 40 min" vs "Raining · **stops around 4:33**".
        var subBold: String
        var subRest: String
        var boldFirst: Bool
        /// Right-aligned secondary text: location, intensity, or "until 6 PM".
        var rightText: String
        /// Cyan stretches on the slim track.
        var segments: [Segment]
        /// Track span in minutes (labels and hour dots derive from this).
        var windowMinutes: Int
        var midLabel: String
        var endLabel: String
        /// Small time flag above the track ("4:33") and its 0…1 position.
        var flagText: String?
        var flagPosition: Double?
    }

    var locationName: String
}
