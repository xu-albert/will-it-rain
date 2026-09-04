import Foundation

enum PrecipitationType: String {
    case rain = "Rain"
    case snow = "Snow"
    case hail = "Hail"
    case sleet = "Sleet"
    case none = "None"

    var icon: String {
        switch self {
        case .rain: return "cloud.rain.fill"
        case .snow: return "cloud.snow.fill"
        case .hail: return "cloud.hail.fill"
        case .sleet: return "cloud.sleet.fill"
        case .none: return "sun.max.fill"
        }
    }
}

enum PrecipitationIntensity: String, Comparable {
    case none = "None"
    case light = "Light"
    case moderate = "Moderate"
    case heavy = "Heavy"

    var numericValue: Double {
        switch self {
        case .none: return 0
        case .light: return 1
        case .moderate: return 2
        case .heavy: return 3
        }
    }

    static func < (lhs: PrecipitationIntensity, rhs: PrecipitationIntensity) -> Bool {
        lhs.numericValue < rhs.numericValue
    }

    static func from(millimetersPerHour: Double) -> PrecipitationIntensity {
        switch millimetersPerHour {
        case ..<0.1: return .none
        case 0.1..<2.5: return .light
        case 2.5..<7.5: return .moderate
        default: return .heavy
        }
    }
}

struct ChartDataPoint: Identifiable {
    let id = UUID()
    let date: Date
    let probability: Double // 0–1
    let intensity: PrecipitationIntensity
    let type: PrecipitationType
    let precipitationAmount: Double // mm/hr
}

struct PrecipitationPeriod: Identifiable {
    let id = UUID()
    let start: Date
    let end: Date
    let type: PrecipitationType
    let peakIntensity: PrecipitationIntensity

    func contains(_ date: Date) -> Bool {
        date >= start && date <= end
    }

    /// A point counts as precipitation when a specific amount is predicted (`intensity != .none`)
    /// OR when rain is more likely than not (`probability >= 0.5`). Keying off amount alone made the
    /// app show "Clear" when WeatherKit reported a high chance but a low probability-weighted amount —
    /// the "says nothing's happening when it's going to rain" bug. Adding the chance gate only *adds*
    /// detections (never removes), and 0.5 keeps marginal <50% forecasts from crying wolf. This makes
    /// the in-app status agree with the backend, which already gates on precipitation chance.
    static let likelyRainProbability = 0.5

    /// Collapses a time-ordered series of points into contiguous wet stretches.
    ///
    /// This is the one seam everything downstream reads — the hero status, the alert
    /// gate, the Live Activity and the poll interval all derive from these periods.
    /// A period takes the type of its first wet point (a `.none` type on a wet reading
    /// is called rain) and its peak intensity across the stretch (a wet reading whose
    /// amount rounds to `.none` counts as light). It ends at the first dry point after
    /// it, or at the last point in the series when the rain outlasts the data.
    static func detect(in dataPoints: [ChartDataPoint]) -> [PrecipitationPeriod] {
        var periods: [PrecipitationPeriod] = []
        var periodStart: Date?
        var periodType: PrecipitationType = .none
        var peakIntensity: PrecipitationIntensity = .none

        for point in dataPoints {
            let isWet = point.intensity != .none || point.probability >= likelyRainProbability
            if isWet {
                let intensity = point.intensity == .none ? .light : point.intensity
                if periodStart == nil {
                    periodStart = point.date
                    periodType = point.type == .none ? .rain : point.type
                    peakIntensity = intensity
                } else if intensity > peakIntensity {
                    peakIntensity = intensity
                }
            } else if let start = periodStart {
                periods.append(PrecipitationPeriod(
                    start: start,
                    end: point.date,
                    type: periodType,
                    peakIntensity: peakIntensity
                ))
                periodStart = nil
                peakIntensity = .none
            }
        }

        // Close any open period
        if let start = periodStart, let lastDate = dataPoints.last?.date {
            periods.append(PrecipitationPeriod(
                start: start,
                end: lastDate,
                type: periodType,
                peakIntensity: peakIntensity
            ))
        }

        return periods
    }
}

enum WeatherCondition: CaseIterable {
    case clear
    case cloudy
    case raining
    case rainingNight
    case snowing
    case snowingNight
    case night

    var debugLabel: String {
        switch self {
        case .clear: return "Clear"
        case .cloudy: return "Cloudy"
        case .raining: return "Rain"
        case .rainingNight: return "Rain Night"
        case .snowing: return "Snow"
        case .snowingNight: return "Snow Night"
        case .night: return "Night"
        }
    }

    var gradientColors: (top: String, bottom: String) {
        switch self {
        case .clear: return ("LightBlueTop", "WhiteBottom")
        case .cloudy: return ("GrayBlueTop", "SlateBottom")
        case .raining: return ("DarkBlueGrayTop", "DeepNavyBottom")
        case .rainingNight: return ("DarkBlueGrayTop", "DeepNavyBottom")
        case .snowing: return ("CoolWhiteTop", "LightGrayBlueBottom")
        case .snowingNight: return ("DarkSlateTop", "DeepGrayBottom")
        case .night: return ("DarkIndigoTop", "NearBlackBottom")
        }
    }
}

struct DaySummary: Identifiable {
    let id = UUID()
    let date: Date
    let precipChance: Double // 0–1
    let type: PrecipitationType
    let highTemp: Double? // Celsius
    let lowTemp: Double? // Celsius

    var dayName: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f.string(from: date)
    }

    var dayAbbreviation: String {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f.string(from: date)
    }
}

struct RainForecast {
    let dataPoints: [ChartDataPoint]
    let precipitationPeriods: [PrecipitationPeriod]
    let dailySummaries: [DaySummary]
    let currentCondition: WeatherCondition
    let currentType: PrecipitationType
    let locationName: String
    let fetchedAt: Date

    // Every time-dependent reading below takes the instant it is evaluated at, so
    // the same forecast can be asked what it means "now" and what it will mean in
    // ten minutes, and so the answers are testable. The argument-less forms read
    // the clock.

    var isCurrentlyPrecipitating: Bool { isPrecipitating(at: Date()) }

    func isPrecipitating(at now: Date) -> Bool {
        precipitationPeriods.contains { $0.contains(now) }
    }

    var currentPrecipitationPeriod: PrecipitationPeriod? { currentPrecipitationPeriod(at: Date()) }

    func currentPrecipitationPeriod(at now: Date) -> PrecipitationPeriod? {
        precipitationPeriods.first { $0.contains(now) }
    }

    var nextPrecipitationPeriod: PrecipitationPeriod? { nextPrecipitationPeriod(at: Date()) }

    func nextPrecipitationPeriod(at now: Date) -> PrecipitationPeriod? {
        precipitationPeriods.first { $0.start > now }
    }

    var heroStatus: (title: String, subtitle: String) {
        heroStatus(for: .clear)
    }

    func heroStatus(for condition: WeatherCondition, at now: Date = Date()) -> (title: String, subtitle: String) {
        // Currently precipitating
        if let current = currentPrecipitationPeriod(at: now) {
            let remaining = Int(current.end.timeIntervalSince(now) / 60)
            let stopsIn = formatDuration(minutes: remaining)
            switch current.type {
            case .rain: return ("Raining", "Stops in \(stopsIn)")
            case .snow: return ("Snowing", "Stops in \(stopsIn)")
            case .hail: return ("Hailing", "Stops in \(stopsIn)")
            case .sleet: return ("Sleet", "Stops in \(stopsIn)")
            case .none: return ("Raining", "Stops in \(stopsIn)")
            }
        }

        // Precipitation coming
        if let next = nextPrecipitationPeriod(at: now) {
            let minutes = Int(next.start.timeIntervalSince(now) / 60)
            let timeStr = formatDuration(minutes: minutes)
            let duration = Int(next.end.timeIntervalSince(next.start) / 60)
            let durationStr = "Will last \(formatDuration(minutes: duration))"
            switch next.type {
            case .rain: return ("Rains in \(timeStr)", durationStr)
            case .snow: return ("Snows in \(timeStr)", durationStr)
            case .hail: return ("Hails in \(timeStr)", durationStr)
            case .sleet: return ("Sleet in \(timeStr)", durationStr)
            case .none: return ("Rains in \(timeStr)", durationStr)
            }
        }

        // No precipitation — use condition for title
        let lastPoint = dataPoints.last?.date ?? now.addingTimeInterval(3600 * 12)
        let hours = max(1, Int(lastPoint.timeIntervalSince(now) / 3600))
        let title = condition == .cloudy ? "Cloudy" : "Clear"
        if hours >= 7 * 24 {
            return (title, "No rain expected this week")
        } else if hours >= 48 {
            let days = hours / 24
            return (title, "No rain for the next \(days) days")
        } else {
            return (title, "Chance of rain within 48 hours")
        }
    }

    /// Returns the adaptive poll interval in seconds based on current forecast conditions.
    func nextPollInterval(leadTimeMinutes: Int = 20, at now: Date = Date()) -> TimeInterval {
        // Currently raining
        if let current = currentPrecipitationPeriod(at: now) {
            let minsUntilEnd = current.end.timeIntervalSince(now) / 60
            if minsUntilEnd <= 10 { return 2 * 60 }
            if minsUntilEnd <= 30 { return 5 * 60 }
            return 15 * 60
        }

        // Rain coming
        if let next = nextPrecipitationPeriod(at: now) {
            let minsUntilStart = next.start.timeIntervalSince(now) / 60
            if minsUntilStart <= Double(leadTimeMinutes + 20) { return 5 * 60 }
            let hoursUntilStart = minsUntilStart / 60
            if hoursUntilStart <= 6 { return 30 * 60 }
        }

        // Clear 6+ hours or no rain
        return 60 * 60
    }

    private func formatDuration(minutes: Int) -> String {
        if minutes < 60 {
            return "\(minutes) min"
        }
        let totalHours = minutes / 60
        let m = minutes % 60
        if totalHours >= 48 {
            let d = totalHours / 24
            let h = totalHours % 24
            if h == 0 { return "\(d)d" }
            return "\(d)d \(h)h"
        }
        if m == 0 {
            return "\(totalHours)h"
        }
        return "\(totalHours)h \(m)m"
    }
}
