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

        // Rain starting notification
        if settings.rainStartEnabled, let next = forecast.nextPrecipitationPeriod {
            let timeUntil = next.start.timeIntervalSince(now)
            let leadTimeSeconds = Double(settings.leadTime * 60)

            if timeUntil <= leadTimeSeconds && timeUntil > 0 {
                if settings.lastNotifiedPrecipStart != next.start {
                    let type = next.type.rawValue
                    scheduleImmediate(
                        title: "\(type) Expected",
                        body: "\(type) expected from \(formatter.string(from: next.start)) to \(formatter.string(from: next.end))",
                        identifier: "precip-start"
                    )
                    settings.lastNotifiedPrecipStart = next.start
                }
            }
        }

        // Rain ending notification
        if settings.rainEndEnabled, let current = forecast.currentPrecipitationPeriod {
            let timeUntilEnd = current.end.timeIntervalSince(now)

            if timeUntilEnd <= 1800 && timeUntilEnd > 0 {
                if settings.lastNotifiedPrecipEnd != current.end {
                    let type = current.type.rawValue
                    scheduleImmediate(
                        title: "\(type) Ending Soon",
                        body: "\(type) ending around \(formatter.string(from: current.end))",
                        identifier: "precip-end"
                    )
                    settings.lastNotifiedPrecipEnd = current.end
                }
            }
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
