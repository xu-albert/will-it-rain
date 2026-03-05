import Foundation
import Combine

class NotificationSettings: ObservableObject {
    private let defaults = UserDefaults.standard

    @Published var leadTime: Int {
        didSet { defaults.set(leadTime, forKey: "leadTime") }
    }
    @Published var quietHoursEnabled: Bool {
        didSet { defaults.set(quietHoursEnabled, forKey: "quietHoursEnabled") }
    }
    @Published var quietHoursStart: Date {
        didSet { defaults.set(quietHoursStart.timeIntervalSinceReferenceDate, forKey: "quietHoursStart") }
    }
    @Published var quietHoursEnd: Date {
        didSet { defaults.set(quietHoursEnd.timeIntervalSinceReferenceDate, forKey: "quietHoursEnd") }
    }
    @Published var rainStartEnabled: Bool {
        didSet { defaults.set(rainStartEnabled, forKey: "rainStartEnabled") }
    }
    @Published var rainEndEnabled: Bool {
        didSet { defaults.set(rainEndEnabled, forKey: "rainEndEnabled") }
    }
    @Published var chartHours: Int {
        didSet { defaults.set(chartHours, forKey: "chartHours") }
    }
    @Published var useCelsius: Bool {
        didSet { defaults.set(useCelsius, forKey: "useCelsius") }
    }

    // State tracking for duplicate prevention
    @Published var lastNotifiedPrecipStart: Date? {
        didSet {
            if let date = lastNotifiedPrecipStart {
                defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastNotifiedPrecipStart")
            } else {
                defaults.removeObject(forKey: "lastNotifiedPrecipStart")
            }
        }
    }
    @Published var lastNotifiedPrecipEnd: Date? {
        didSet {
            if let date = lastNotifiedPrecipEnd {
                defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastNotifiedPrecipEnd")
            } else {
                defaults.removeObject(forKey: "lastNotifiedPrecipEnd")
            }
        }
    }

    // Confirmation state for two-pass notification
    @Published var pendingPrecipStart: Date? {
        didSet {
            if let date = pendingPrecipStart {
                defaults.set(date.timeIntervalSinceReferenceDate, forKey: "pendingPrecipStart")
            } else {
                defaults.removeObject(forKey: "pendingPrecipStart")
            }
        }
    }
    @Published var pendingPrecipEnd: Date? {
        didSet {
            if let date = pendingPrecipEnd {
                defaults.set(date.timeIntervalSinceReferenceDate, forKey: "pendingPrecipEnd")
            } else {
                defaults.removeObject(forKey: "pendingPrecipEnd")
            }
        }
    }
    @Published var lastRainEndTime: Date? {
        didSet {
            if let date = lastRainEndTime {
                defaults.set(date.timeIntervalSinceReferenceDate, forKey: "lastRainEndTime")
            } else {
                defaults.removeObject(forKey: "lastRainEndTime")
            }
        }
    }

    /// Check if two dates refer to the same event (within 10 minutes).
    func isSameEvent(_ a: Date?, _ b: Date?) -> Bool {
        guard let a, let b else { return false }
        return abs(a.timeIntervalSince(b)) < 10 * 60
    }

    init() {
        let d = defaults
        self.leadTime = d.object(forKey: "leadTime") as? Int ?? 20
        self.quietHoursEnabled = d.bool(forKey: "quietHoursEnabled")
        self.rainStartEnabled = d.object(forKey: "rainStartEnabled") as? Bool ?? true
        self.rainEndEnabled = d.object(forKey: "rainEndEnabled") as? Bool ?? true
        self.chartHours = d.object(forKey: "chartHours") as? Int ?? 12
        self.useCelsius = d.bool(forKey: "useCelsius")

        let calendar = Calendar.current
        if d.object(forKey: "quietHoursStart") != nil {
            self.quietHoursStart = Date(timeIntervalSinceReferenceDate: d.double(forKey: "quietHoursStart"))
        } else {
            self.quietHoursStart = calendar.date(from: DateComponents(hour: 22, minute: 0)) ?? Date()
        }
        if d.object(forKey: "quietHoursEnd") != nil {
            self.quietHoursEnd = Date(timeIntervalSinceReferenceDate: d.double(forKey: "quietHoursEnd"))
        } else {
            self.quietHoursEnd = calendar.date(from: DateComponents(hour: 7, minute: 0)) ?? Date()
        }

        self.lastNotifiedPrecipStart = d.object(forKey: "lastNotifiedPrecipStart") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastNotifiedPrecipStart"))
            : nil
        self.lastNotifiedPrecipEnd = d.object(forKey: "lastNotifiedPrecipEnd") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastNotifiedPrecipEnd"))
            : nil
        self.pendingPrecipStart = d.object(forKey: "pendingPrecipStart") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "pendingPrecipStart"))
            : nil
        self.pendingPrecipEnd = d.object(forKey: "pendingPrecipEnd") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "pendingPrecipEnd"))
            : nil
        self.lastRainEndTime = d.object(forKey: "lastRainEndTime") != nil
            ? Date(timeIntervalSinceReferenceDate: d.double(forKey: "lastRainEndTime"))
            : nil
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
