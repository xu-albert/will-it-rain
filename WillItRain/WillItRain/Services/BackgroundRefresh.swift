import BackgroundTasks
import Foundation

/// The app's one BGAppRefreshTask. It polls the weather and replays a
/// registration the Worker deferred or throttled, so it is requested for
/// whichever of the two is due first.
enum BackgroundRefresh {
    static let identifier = "com.willitrain.refresh"

    /// The next weather poll, brought forward to a waiting registration's retry
    /// time when that comes sooner.
    static func schedule(after interval: TimeInterval) {
        var date = Date(timeIntervalSinceNow: interval)
        if let retryAt = PushRegistrationService.shared.pendingRetryDate, retryAt > Date() {
            date = min(date, retryAt)
        }
        schedule(at: date)
    }

    static func schedule(at date: Date) {
        let clamped = min(max(date.timeIntervalSinceNow, 2 * 60), 60 * 60)
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: clamped)
        do {
            try BGTaskScheduler.shared.submit(request)
            print("[Background] Scheduled refresh in \(Int(clamped))s")
        } catch {
            print("Background task scheduling failed: \(error)")
        }
    }
}
