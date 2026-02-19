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

enum WeatherCondition {
    case clear
    case cloudy
    case raining
    case snowing
    case night

    var gradientColors: (top: String, bottom: String) {
        switch self {
        case .clear: return ("LightBlueTop", "WhiteBottom")
        case .cloudy: return ("GrayBlueTop", "SlateBottom")
        case .raining: return ("DarkBlueGrayTop", "DeepNavyBottom")
        case .snowing: return ("CoolWhiteTop", "LightGrayBlueBottom")
        case .night: return ("DarkIndigoTop", "NearBlackBottom")
        }
    }
}

struct RainForecast {
    let dataPoints: [ChartDataPoint]
    let precipitationPeriods: [PrecipitationPeriod]
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
        let now = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"

        if let current = currentPrecipitationPeriod {
            let typeStr = current.type.rawValue
            let endStr = formatter.string(from: current.end)
            return ("\(typeStr == "Rain" ? "Raining" : typeStr == "Snow" ? "Snowing" : typeStr) Now",
                    "Clears around \(endStr)")
        }

        if let next = nextPrecipitationPeriod {
            let minutes = Int(next.start.timeIntervalSince(now) / 60)
            let typeStr = next.type.rawValue
            let endStr = formatter.string(from: next.end)

            if minutes <= 60 {
                return ("\(typeStr) in \(minutes) min",
                        "Expected until \(endStr)")
            } else {
                let hours = minutes / 60
                return ("\(typeStr) in \(hours)h",
                        "Expected until \(endStr)")
            }
        }

        let lastPoint = dataPoints.last?.date ?? now.addingTimeInterval(3600 * 12)
        let hours = Int(lastPoint.timeIntervalSince(now) / 3600)
        return ("No Rain", "Dry for the next \(hours) hours")
    }
}
