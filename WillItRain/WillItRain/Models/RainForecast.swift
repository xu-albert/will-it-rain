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
}

struct RainForecast {
    let dataPoints: [ChartDataPoint]
    let precipitationPeriods: [PrecipitationPeriod]
    let dailySummaries: [DaySummary]
    let currentCondition: WeatherCondition
    let currentType: PrecipitationType
    let locationName: String
    let fetchedAt: Date

    var isCurrentlyPrecipitating: Bool {
        precipitationPeriods.contains { $0.contains(Date()) }
    }

    var currentPrecipitationPeriod: PrecipitationPeriod? {
        precipitationPeriods.first { $0.contains(Date()) }
    }

    var nextPrecipitationPeriod: PrecipitationPeriod? {
        let now = Date()
        return precipitationPeriods.first { $0.start > now }
    }

    var heroStatus: (title: String, subtitle: String) {
        heroStatus(for: .clear)
    }

    func heroStatus(for condition: WeatherCondition) -> (title: String, subtitle: String) {
        let now = Date()

        // Currently precipitating
        if let current = currentPrecipitationPeriod {
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
        if let next = nextPrecipitationPeriod {
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
    func nextPollInterval(leadTimeMinutes: Int = 20) -> TimeInterval {
        let now = Date()

        // Currently raining
        if let current = currentPrecipitationPeriod {
            let minsUntilEnd = current.end.timeIntervalSince(now) / 60
            if minsUntilEnd <= 10 { return 2 * 60 }
            if minsUntilEnd <= 30 { return 5 * 60 }
            return 15 * 60
        }

        // Rain coming
        if let next = nextPrecipitationPeriod {
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
