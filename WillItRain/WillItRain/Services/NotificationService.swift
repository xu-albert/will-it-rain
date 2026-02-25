import Foundation
import UserNotifications

final class NotificationService {
    static let shared = NotificationService()
    private let center = UNUserNotificationCenter.current()

    func requestPermission() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    func evaluateAndSchedule(forecast: RainForecast, settings: inout NotificationSettings) {
        let now = Date()

        guard !settings.isInQuietHours(at: now) else { return }

        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"

        // Track lastRainEndTime
        if forecast.isCurrentlyPrecipitating {
            settings.lastRainEndTime = nil
        } else if settings.lastRainEndTime == nil {
            settings.lastRainEndTime = now
        }

        // --- Rain starting (two-pass confirmation) ---
        if settings.rainStartEnabled, let next = forecast.nextPrecipitationPeriod {
            let timeUntil = next.start.timeIntervalSince(now)
            let leadTimeSeconds = Double(settings.leadTime * 60)

            if timeUntil <= leadTimeSeconds && timeUntil > 0 {
                if let pending = settings.pendingPrecipStart {
                    // Second pass: confirmed — fire notification
                    if settings.isSameEvent(pending, next.start)
                        && !settings.isSameEvent(settings.lastNotifiedPrecipStart, next.start) {
                        let type = next.type.rawValue
                        scheduleImmediate(
                            title: "\(type) Expected",
                            body: "\(type) expected from \(formatter.string(from: next.start)) to \(formatter.string(from: next.end))",
                            identifier: "precip-start"
                        )
                        settings.lastNotifiedPrecipStart = next.start
                        settings.pendingPrecipStart = nil
                        print("[Notifications] Rain start confirmed and notified")
                    }
                } else {
                    // First pass: set pending
                    settings.pendingPrecipStart = next.start
                    print("[Notifications] Rain start pending confirmation")
                }
            } else {
                // Rain moved out of lead time window — clear pending
                settings.pendingPrecipStart = nil
            }
        } else {
            // No upcoming rain — clear pending
            settings.pendingPrecipStart = nil
        }

        // --- Rain ending (two-pass confirmation) ---
        if settings.rainEndEnabled, let current = forecast.currentPrecipitationPeriod {
            let timeUntilEnd = current.end.timeIntervalSince(now)

            if timeUntilEnd <= 1800 && timeUntilEnd > 0 {
                if let pending = settings.pendingPrecipEnd {
                    // Second pass: confirmed
                    if settings.isSameEvent(pending, current.end)
                        && !settings.isSameEvent(settings.lastNotifiedPrecipEnd, current.end) {
                        let type = current.type.rawValue
                        scheduleImmediate(
                            title: "\(type) Ending Soon",
                            body: "\(type) ending around \(formatter.string(from: current.end))",
                            identifier: "precip-end"
                        )
                        settings.lastNotifiedPrecipEnd = current.end
                        settings.pendingPrecipEnd = nil
                        print("[Notifications] Rain end confirmed and notified")
                    }
                } else {
                    // First pass: set pending
                    settings.pendingPrecipEnd = current.end
                    print("[Notifications] Rain end pending confirmation")
                }
            } else {
                settings.pendingPrecipEnd = nil
            }
        } else {
            settings.pendingPrecipEnd = nil
        }

        // --- Rain resuming after brief gap ---
        if settings.rainStartEnabled,
           !forecast.isCurrentlyPrecipitating,
           let lastEnd = settings.lastRainEndTime,
           now.timeIntervalSince(lastEnd) <= 10 * 60,
           let next = forecast.nextPrecipitationPeriod,
           next.start.timeIntervalSince(now) <= 60 * 60,
           !settings.isSameEvent(settings.lastNotifiedPrecipStart, next.start) {
            let mins = Int(next.start.timeIntervalSince(now) / 60)
            let type = next.type.rawValue
            scheduleImmediate(
                title: "Brief Gap",
                body: "\(type) returns in \(mins) min",
                identifier: "precip-resume"
            )
            settings.lastNotifiedPrecipStart = next.start
            print("[Notifications] Rain resuming notification sent")
        }
    }

    private func scheduleImmediate(title: String, body: String, identifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)

        center.add(request) { error in
            if let error {
                print("Notification error: \(error.localizedDescription)")
            }
        }
    }

    func cancelAll() {
        center.removeAllPendingNotificationRequests()
    }
}
