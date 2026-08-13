import ActivityKit
import Foundation

/// Shared between the app (starts/updates activities) and the widget extension
/// (renders them). ContentState is pushed over APNs too, so keep it small —
/// the whole payload must stay under 4KB.
nonisolated struct RainActivityAttributes: ActivityAttributes {
    /// Which of the two visual treatments to draw. Deliberately two cases, not
    /// the app's full `PrecipitationType`: the widget's only decision is cyan
    /// rain vs the pale "frost" look, and keeping it binary keeps the pushed
    /// payload small and spares the Worker from modelling WeatherKit's taxonomy.
    nonisolated enum Precip: String, Codable, Hashable {
        case rain
        case wintry
    }

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
        /// Rain vs wintry styling. MUST stay Optional: the synthesized Codable
        /// init throws on a missing key even when a property has a default, so a
        /// non-optional would make ActivityKit fail to decode any push from a
        /// Worker that predates this field — the activity would freeze with no
        /// error rather than degrade. `nil` renders as rain, i.e. old behaviour.
        var precip: Precip?
    }

    var locationName: String
}
