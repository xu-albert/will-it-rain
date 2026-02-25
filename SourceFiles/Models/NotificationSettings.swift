import Foundation

struct NotificationSettings {
    private static let defaults = UserDefaults.standard

    var leadTime: Int {
        didSet { Self.defaults.set(leadTime, forKey: "leadTime") }
    }
    var quietHoursEnabled: Bool {
        didSet { Self.defaults.set(quietHoursEnabled, forKey: "quietHoursEnabled") }
    }
    var quietHoursStart: Date {
        didSet { Self.defaults.set(quietHoursStart.timeIntervalSinceReferenceDate, forKey: "quietHoursStart") }
    }
    var quietHoursEnd: Date {
        didSet { Self.defaults.set(quietHoursEnd.timeIntervalSinceReferenceDate, forKey: "quietHoursEnd") }
    }
    var rainStartEnabled: Bool {
        didSet { Self.defaults.set(rainStartEnabled, forKey: "rainStartEnabled") }
    }
    var rainEndEnabled: Bool {
        didSet { Self.defaults.set(rainEndEnabled, forKey: "rainEndEnabled") }
    }
    var chartHours: Int {
        didSet { Self.defaults.set(chartHours, forKey: "chartHours") }
    }

    // State tracking for duplicate prevention
    var lastNotifiedPrecipStart: Date? {
        didSet {
            if let date = lastNotifiedPrecipStart {
                Self.defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastNotifiedPrecipStart")
            } else {
                Self.defaults.removeObject(forKey: "lastNotifiedPrecipStart")
            }
        }
    }
    var lastNotifiedPrecipEnd: Date? {
        didSet {
            if let date = lastNotifiedPrecipEnd {
                Self.defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastNotifiedPrecipEnd")
            } else {
                Self.defaults.removeObject(forKey: "lastNotifiedPrecipEnd")
            }
        }
    }

    // Confirmation state for two-pass notification
    var pendingPrecipStart: Date? {
        didSet {
            if let date = pendingPrecipStart {
                Self.defaults.set(date.timeIntervalSinceReferenceDate, forKey: "pendingPrecipStart")
            } else {
                Self.defaults.removeObject(forKey: "pendingPrecipStart")
            }
        }
    }
    var pendingPrecipEnd: Date? {
        didSet {
            if let date = pendingPrecipEnd {
                Self.defaults.set(date.timeIntervalSinceReferenceDate, forKey: "pendingPrecipEnd")
            } else {
                Self.defaults.removeObject(forKey: "pendingPrecipEnd")
            }
        }
    }
    var lastRainEndTime: Date? {
        didSet {
            if let date = lastRainEndTime {
                Self.defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastRainEndTime")
            } else {
                Self.defaults.removeObject(forKey: "lastRainEndTime")
            }
        }
    }

    /// Check if two dates refer to the same event (within 10 minutes).
    func isSameEvent(_ a: Date?, _ b: Date?) -> Bool {
        guard let a, let b else { return false }
        return abs(a.timeIntervalSince(b)) < 10 * 60
    }

    static func load() -> NotificationSettings {
        let d = defaults
        let leadTime = d.object(forKey: "leadTime") as? Int ?? 20
        let quietHoursEnabled = d.bool(forKey: "quietHoursEnabled")
        let rainStartEnabled = d.object(forKey: "rainStartEnabled") as? Bool ?? true
        let rainEndEnabled = d.object(forKey: "rainEndEnabled") as? Bool ?? true
        let chartHours = d.object(forKey: "chartHours") as? Int ?? 12

        let calendar = Calendar.current
        let quietStart: Date
        if d.object(forKey: "quietHoursStart") != nil {
            quietStart = Date(timeIntervalSinceReferenceDate: d.double(forKey: "quietHoursStart"))
        } else {
            quietStart = calendar.date(from: DateComponents(hour: 22, minute: 0)) ?? Date()
        }
        let quietEnd: Date
        if d.object(forKey: "quietHoursEnd") != nil {
            quietEnd = Date(timeIntervalSinceReferenceDate: d.double(forKey: "quietHoursEnd"))
        } else {
            quietEnd = calendar.date(from: DateComponents(hour: 7, minute: 0)) ?? Date()
        }

        let lastStart: Date? = d.object(forKey: "lastNotifiedPrecipStart") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastNotifiedPrecipStart"))
            : nil
        let lastEnd: Date? = d.object(forKey: "lastNotifiedPrecipEnd") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastNotifiedPrecipEnd"))
            : nil
        let pendingStart: Date? = d.object(forKey: "pendingPrecipStart") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "pendingPrecipStart"))
            : nil
        let pendingEnd: Date? = d.object(forKey: "pendingPrecipEnd") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "pendingPrecipEnd"))
            : nil
        let lastRainEnd: Date? = d.object(forKey: "lastRainEndTime") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastRainEndTime"))
            : nil

        return NotificationSettings(
            leadTime: leadTime,
            quietHoursEnabled: quietHoursEnabled,
            quietHoursStart: quietStart,
            quietHoursEnd: quietEnd,
            rainStartEnabled: rainStartEnabled,
            rainEndEnabled: rainEndEnabled,
            chartHours: chartHours,
            lastNotifiedPrecipStart: lastStart,
            lastNotifiedPrecipEnd: lastEnd,
            pendingPrecipStart: pendingStart,
            pendingPrecipEnd: pendingEnd,
            lastRainEndTime: lastRainEnd
        )
    }

    func isInQuietHours(at date: Date = Date()) -> Bool {
        guard quietHoursEnabled else { return false }
        let calendar = Calendar.current
        let nowMinutes = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        let startMinutes = calendar.component(.hour, from: quietHoursStart) * 60 + calendar.component(.minute, from: quietHoursStart)
        let endMinutes = calendar.component(.hour, from: quietHoursEnd) * 60 + calendar.component(.minute, from: quietHoursEnd)

        if startMinutes <= endMinutes {
            return nowMinutes >= startMinutes && nowMinutes < endMinutes
        } else {
            return nowMinutes >= startMinutes || nowMinutes < endMinutes
        }
    }
}
