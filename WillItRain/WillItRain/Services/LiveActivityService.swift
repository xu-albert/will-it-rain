import ActivityKit
import Foundation

/// Starts, updates, and ends the rain Live Activity from the same forecast
/// evaluations that drive notifications (foreground refresh + BGAppRefreshTask).
final class LiveActivityService {
    static let shared = LiveActivityService()

    /// Show the activity once rain is this close (minutes), even if the user's
    /// notification lead time is shorter.
    private let showLeadMinutes = 60
    /// How far ahead the track can look.
    private let horizonMinutes = 240

    private var tokenObservers: [String: Task<Void, Never>] = [:]

    func sync(forecast: RainForecast, settings: NotificationSettings) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let now = Date()
        let horizon = now.addingTimeInterval(TimeInterval(horizonMinutes * 60))
        let periods = forecast.precipitationPeriods
            .filter { $0.end > now && $0.start < horizon }
            .sorted { $0.start < $1.start }
        let current = periods.first { $0.contains(now) }

        let lead = max(settings.leadTime, showLeadMinutes)
        let shouldShow = current != nil
            || periods.first.map { $0.start.timeIntervalSince(now) <= TimeInterval(lead * 60) } == true

        guard shouldShow, let state = makeState(now: now, periods: periods, current: current, forecast: forecast) else {
            endAll()
            return
        }

        let content = ActivityContent(state: state, staleDate: now.addingTimeInterval(45 * 60))
        if let activity = Activity<RainActivityAttributes>.activities.first {
            Task { await activity.update(content) }
        } else {
            do {
                let activity = try Activity.request(
                    attributes: RainActivityAttributes(locationName: forecast.locationName),
                    content: content,
                    pushType: .token
                )
                observePushToken(for: activity)
                print("[LiveActivity] Started \(activity.id)")
            } catch {
                print("[LiveActivity] Start failed: \(error)")
            }
        }
    }

    func endAll() {
        for activity in Activity<RainActivityAttributes>.activities {
            tokenObservers[activity.id]?.cancel()
            tokenObservers[activity.id] = nil
            Task { await activity.end(nil, dismissalPolicy: .default) }
        }
    }

    private func observePushToken(for activity: Activity<RainActivityAttributes>) {
        tokenObservers[activity.id]?.cancel()
        tokenObservers[activity.id] = Task {
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                print("[LiveActivity] Push token: \(hex)")
                await PushRegistrationService.shared.registerLiveActivityToken(hex)
            }
        }
    }

    // MARK: - Content state

    private func makeState(
        now: Date,
        periods: [PrecipitationPeriod],
        current: PrecipitationPeriod?,
        forecast: RainForecast
    ) -> RainActivityAttributes.ContentState? {
        guard let last = periods.last else { return nil }

        let windowMinutes = windowMinutes(now: now, lastEnd: last.end)
        let window = TimeInterval(windowMinutes * 60)
        let segments = periods.map { p in
            RainActivityAttributes.ContentState.Segment(
                start: max(0, p.start.timeIntervalSince(now) / window),
                end: min(1, p.end.timeIntervalSince(now) / window)
            )
        }.filter { $0.end > $0.start }
        let (mid, end) = trackLabels(windowMinutes: windowMinutes)

        // State C — intermittent: several distinct bursts ahead, not raining now.
        if current == nil, periods.count >= 2, let next = periods.first {
            let minutes = max(1, Int(next.start.timeIntervalSince(now) / 60))
            let hero: String
            switch next.type {
            case .snow: hero = "Flurries"
            case .sleet, .mixed, .hail: hero = "Wintry mix"
            case .rain, .none: hero = "Showers"
            }
            return .init(
                statusText: "On & off",
                countdownTarget: nil,
                heroText: hero,
                subBold: "next burst in \(minutes) min",
                subRest: "On & off · ",
                boldFirst: false,
                rightText: "until \(shortTime(last.end))",
                segments: segments,
                windowMinutes: windowMinutes,
                midLabel: mid,
                endLabel: end,
                flagText: nil,
                flagPosition: nil,
                precip: next.type.isWintry ? .wintry : .rain
            )
        }

        // State B — raining now: countdown to when it stops.
        if let current {
            let statusWord: String
            let verb: String
            switch current.type {
            case .snow: statusWord = "Snowing now"; verb = "Snowing"
            case .hail: statusWord = "Hailing now"; verb = "Hailing"
            case .sleet: statusWord = "Sleet now"; verb = "Sleet"
            case .mixed: statusWord = "Wintry mix now"; verb = "Wintry mix"
            case .rain, .none: statusWord = "Raining now"; verb = "Raining"
            }
            return .init(
                statusText: statusWord,
                countdownTarget: current.end,
                heroText: nil,
                subBold: "stops around \(shortTime(current.end))",
                subRest: "\(verb) · ",
                boldFirst: false,
                rightText: current.peakIntensity.rawValue,
                segments: segments,
                windowMinutes: windowMinutes,
                midLabel: mid,
                endLabel: end,
                flagText: shortTime(current.end),
                flagPosition: segments.first?.end,
                precip: current.type.isWintry ? .wintry : .rain
            )
        }

        // State A — approaching: countdown to the first drop.
        guard let next = periods.first else { return nil }
        let duration = max(1, Int(next.end.timeIntervalSince(next.start) / 60))
        let typeWord: String
        switch next.type {
        case .snow: typeWord = "snow"
        case .hail: typeWord = "hail"
        case .sleet: typeWord = "sleet"
        case .mixed: typeWord = "wintry mix"
        case .rain, .none: typeWord = "rain"
        }
        let intensity = next.peakIntensity == .none ? "Light" : next.peakIntensity.rawValue
        return .init(
            statusText: "\(typeWord.capitalized) incoming",
            countdownTarget: next.start,
            heroText: nil,
            subBold: "\(intensity) \(typeWord)",
            subRest: " · lasts about \(formatDuration(minutes: duration))",
            boldFirst: true,
            rightText: forecast.locationName,
            segments: segments,
            windowMinutes: windowMinutes,
            midLabel: mid,
            endLabel: end,
            flagText: shortTime(next.start),
            flagPosition: segments.first?.start,
            precip: next.type.isWintry ? .wintry : .rain
        )
    }

    /// Snap the track span to one of the design's windows: 90 min, 2 h, or 4 h.
    private func windowMinutes(now: Date, lastEnd: Date) -> Int {
        let needed = Int(lastEnd.timeIntervalSince(now) / 60) + 20
        if needed <= 90 { return 90 }
        if needed <= 120 { return 120 }
        return horizonMinutes
    }

    private func trackLabels(windowMinutes: Int) -> (mid: String, end: String) {
        if windowMinutes == 90 { return ("+45 min", "+90 min") }
        let hours = windowMinutes / 60
        let midHours = Double(hours) / 2
        let mid = midHours == floor(midHours)
            ? "+\(Int(midHours)) hr"
            : "+\(Int(windowMinutes / 2)) min"
        return (mid, "+\(hours) hr")
    }

    private func shortTime(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        return f.string(from: date)
    }

    private func formatDuration(minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60
        let m = minutes % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }
}
