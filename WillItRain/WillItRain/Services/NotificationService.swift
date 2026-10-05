import Foundation
import UserNotifications

final class NotificationService {
    /// Hands one composed alert to the system.
    ///
    /// Injected so the gate below can be tested without UNUserNotificationCenter,
    /// whose `add` needs a granted authorization and a running app. The shared
    /// instance delivers through the real center.
    typealias Deliver = (_ title: String, _ body: String, _ identifier: String) -> Void

    static let shared = NotificationService()
    private static let center = UNUserNotificationCenter.current()
    private static let maximumInRainPollInterval: TimeInterval = 15 * 60

    private let deliver: Deliver
    private let remoteAlertsActive: () -> Bool

    init(
        deliver: Deliver? = nil,
        remoteAlertsActive: (() -> Bool)? = nil
    ) {
        self.deliver = deliver ?? Self.deliverImmediately
        self.remoteAlertsActive = remoteAlertsActive ?? {
            PushRegistrationService.shared.isRemoteRegistrationActive
        }
    }

    func requestPermission() async -> Bool {
        do {
            return try await Self.center.requestAuthorization(options: [.alert, .sound])
        } catch {
            return false
        }
    }

    /// Decides, for one forecast evaluation at `now`, which alerts are due and
    /// delivers them. Every decision is recorded in `settings`, so the two-pass
    /// confirmation and the duplicate suppression survive across polls and launches.
    func evaluateAndSchedule(forecast: RainForecast, settings: NotificationSettings, now: Date = Date()) {
        // A confirmed Worker registration makes remote delivery authoritative.
        // Keeping this gate before all local state mutation means a foreground
        // poll cannot arm a second alert for the same event the Worker owns.
        guard !remoteAlertsActive() else { return }
        guard !settings.isInQuietHours(at: now) else { return }

        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"

        // Track lastRainEndTime only after observing a recent wet-to-dry
        // transition. On a fresh install, or after a long gap between polls, a
        // dry forecast with rain ahead is not evidence that rain just stopped;
        // recording it would trigger a false resume alert and suppress the
        // real lead-time alert that follows.
        if forecast.isPrecipitating(at: now) {
            settings.lastRainEndTime = nil
            settings.lastPrecipitatingTime = now
        } else if let lastWet = settings.lastPrecipitatingTime {
            let timeSinceWet = now.timeIntervalSince(lastWet)
            if timeSinceWet >= 0, timeSinceWet <= Self.maximumInRainPollInterval {
                settings.lastRainEndTime = now
            }
            settings.lastPrecipitatingTime = nil
        }

        // --- Rain starting (two-pass confirmation) ---
        if settings.rainStartEnabled, let next = forecast.nextConfirmedPrecipitationPeriod(at: now) {
            let timeUntil = next.start.timeIntervalSince(now)
            let leadTimeSeconds = Double(settings.leadTime * 60)

            if timeUntil <= leadTimeSeconds && timeUntil > 0 {
                if let pending = settings.pendingPrecipStart {
                    // Second pass: confirmed — fire notification
                    if settings.isSameEvent(pending, next.start)
                        && !settings.isSameEvent(settings.lastNotifiedPrecipStart, next.start) {
                        let type = next.type.rawValue
                        let typeLower = type.lowercased()
                        let intensity = next.peakIntensity == .none ? "" : "\(next.peakIntensity.rawValue) "
                        let mins = max(1, Int(next.start.timeIntervalSince(now) / 60))
                        deliver(
                            mins <= 5 ? "\(type) starting soon" : "\(type) in ~\(mins) min",
                            "\(intensity)\(typeLower) expected around \(formatter.string(from: next.start)), lasting to \(formatter.string(from: next.end)).",
                            "precip-start"
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
        if settings.rainEndEnabled, let current = forecast.currentPrecipitationPeriod(at: now) {
            let timeUntilEnd = current.end.timeIntervalSince(now)

            if timeUntilEnd <= 1800 && timeUntilEnd > 0 {
                if let pending = settings.pendingPrecipEnd {
                    // Second pass: confirmed
                    if settings.isSameEvent(pending, current.end)
                        && !settings.isSameEvent(settings.lastNotifiedPrecipEnd, current.end) {
                        let type = current.type.rawValue
                        deliver(
                            "\(type) ending soon",
                            "\(type) should stop around \(formatter.string(from: current.end)).",
                            "precip-end"
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
           !forecast.isPrecipitating(at: now),
           let lastEnd = settings.lastRainEndTime,
           now.timeIntervalSince(lastEnd) <= 10 * 60,
           let next = forecast.nextConfirmedPrecipitationPeriod(at: now),
           next.start.timeIntervalSince(now) <= 60 * 60,
           !settings.isSameEvent(settings.lastNotifiedPrecipStart, next.start) {
            let mins = max(1, Int(next.start.timeIntervalSince(now) / 60))
            let type = next.type.rawValue
            deliver(
                "More \(type.lowercased()) coming",
                "\(type) returns in about \(mins) min.",
                "precip-resume"
            )
            settings.lastNotifiedPrecipStart = next.start
            print("[Notifications] Rain resuming notification sent")
        }
    }

    private static func deliverImmediately(title: String, body: String, identifier: String) {
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
        Self.center.removeAllPendingNotificationRequests()
    }
}
