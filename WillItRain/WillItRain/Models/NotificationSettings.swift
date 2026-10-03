import Foundation
import Combine

class NotificationSettings: ObservableObject {
    private let defaults: UserDefaults

    @Published var leadTime: Int {
        didSet { defaults.set(leadTime, forKey: "leadTime") }
    }
    @Published var quietHoursEnabled: Bool {
        didSet { defaults.set(quietHoursEnabled, forKey: "quietHoursEnabled") }
    }
    @Published var quietHoursStart: Date {
        didSet { persist(quietHoursStart, forKey: "quietHoursStart") }
    }
    @Published var quietHoursEnd: Date {
        didSet { persist(quietHoursEnd, forKey: "quietHoursEnd") }
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
        didSet { persist(lastNotifiedPrecipStart, forKey: "lastNotifiedPrecipStart") }
    }
    @Published var lastNotifiedPrecipEnd: Date? {
        didSet { persist(lastNotifiedPrecipEnd, forKey: "lastNotifiedPrecipEnd") }
    }

    // Confirmation state for two-pass notification
    @Published var pendingPrecipStart: Date? {
        didSet { persist(pendingPrecipStart, forKey: "pendingPrecipStart") }
    }
    @Published var pendingPrecipEnd: Date? {
        didSet { persist(pendingPrecipEnd, forKey: "pendingPrecipEnd") }
    }
    @Published var lastRainEndTime: Date? {
        didSet { persist(lastRainEndTime, forKey: "lastRainEndTime") }
    }
    /// When the previous evaluated forecast was wet. This is separate from
    /// `lastRainEndTime`: a fresh install, or a launch after a long gap, must
    /// not mistake its first dry forecast for a rain ending and send a resume
    /// alert.
    @Published var lastPrecipitatingTime: Date? {
        didSet { persist(lastPrecipitatingTime, forKey: "lastPrecipitatingTime") }
    }

    /// Check if two dates refer to the same event (within 10 minutes).
    func isSameEvent(_ a: Date?, _ b: Date?) -> Bool {
        guard let a, let b else { return false }
        return abs(a.timeIntervalSince(b)) < 10 * 60
    }

    /// `defaults` is where every setting lives; the app uses the standard suite,
    /// tests hand in an isolated one.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let d = defaults
        self.leadTime = d.object(forKey: "leadTime") as? Int ?? 20
        self.quietHoursEnabled = d.bool(forKey: "quietHoursEnabled")
        self.rainStartEnabled = d.object(forKey: "rainStartEnabled") as? Bool ?? true
        self.rainEndEnabled = d.object(forKey: "rainEndEnabled") as? Bool ?? true
        self.chartHours = d.object(forKey: "chartHours") as? Int ?? 12
        self.useCelsius = d.bool(forKey: "useCelsius")

        let calendar = Calendar.current
        self.quietHoursStart = Self.storedDate(forKey: "quietHoursStart", in: d)
            ?? calendar.date(from: DateComponents(hour: 22, minute: 0)) ?? Date()
        self.quietHoursEnd = Self.storedDate(forKey: "quietHoursEnd", in: d)
            ?? calendar.date(from: DateComponents(hour: 7, minute: 0)) ?? Date()

        self.lastNotifiedPrecipStart = Self.storedDate(forKey: "lastNotifiedPrecipStart", in: d)
        self.lastNotifiedPrecipEnd = Self.storedDate(forKey: "lastNotifiedPrecipEnd", in: d)
        self.pendingPrecipStart = Self.storedDate(forKey: "pendingPrecipStart", in: d)
        self.pendingPrecipEnd = Self.storedDate(forKey: "pendingPrecipEnd", in: d)
        self.lastRainEndTime = Self.storedDate(forKey: "lastRainEndTime", in: d)
        self.lastPrecipitatingTime = Self.storedDate(forKey: "lastPrecipitatingTime", in: d)
    }

    // Dates are stored as seconds since the reference date. A nil clears the key,
    // so an absent key reads back as nil rather than as the reference date itself.
    private func persist(_ date: Date?, forKey key: String) {
        if let date {
            defaults.set(date.timeIntervalSinceReferenceDate, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    private static func storedDate(forKey key: String, in defaults: UserDefaults) -> Date? {
        guard defaults.object(forKey: key) != nil else { return nil }
        return Date(timeIntervalSinceReferenceDate: defaults.double(forKey: key))
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

    /// The complete alert policy mirrored to the Worker. SwiftUI keys a
    /// debounced registration task on this value, so changing any server-side
    /// alert setting promptly replaces the pending registration with the newest
    /// one while display-only settings do not create network traffic.
    var remoteAlertSettings: RemoteAlertSettings {
        RemoteAlertSettings(settings: self)
    }
}

struct RemoteAlertSettings: Hashable {
    let leadTimeMinutes: Int
    let rainStartEnabled: Bool
    let rainEndEnabled: Bool
    let quietHoursEnabled: Bool
    let quietHoursStartMinutes: Int
    let quietHoursEndMinutes: Int
    let timeZoneIdentifier: String

    init(
        leadTimeMinutes: Int,
        rainStartEnabled: Bool,
        rainEndEnabled: Bool,
        quietHoursEnabled: Bool,
        quietHoursStartMinutes: Int,
        quietHoursEndMinutes: Int,
        timeZoneIdentifier: String
    ) {
        self.leadTimeMinutes = leadTimeMinutes
        self.rainStartEnabled = rainStartEnabled
        self.rainEndEnabled = rainEndEnabled
        self.quietHoursEnabled = quietHoursEnabled
        self.quietHoursStartMinutes = quietHoursStartMinutes
        self.quietHoursEndMinutes = quietHoursEndMinutes
        self.timeZoneIdentifier = timeZoneIdentifier
    }

    init(
        settings: NotificationSettings,
        calendar: Calendar = .autoupdatingCurrent,
        timeZone: TimeZone = .autoupdatingCurrent
    ) {
        var localCalendar = calendar
        localCalendar.timeZone = timeZone
        leadTimeMinutes = settings.leadTime
        rainStartEnabled = settings.rainStartEnabled
        rainEndEnabled = settings.rainEndEnabled
        quietHoursEnabled = settings.quietHoursEnabled
        quietHoursStartMinutes = Self.minutesSinceMidnight(settings.quietHoursStart, calendar: localCalendar)
        quietHoursEndMinutes = Self.minutesSinceMidnight(settings.quietHoursEnd, calendar: localCalendar)
        timeZoneIdentifier = timeZone.identifier
    }

    private static func minutesSinceMidnight(_ date: Date, calendar: Calendar) -> Int {
        calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
    }
}
