import UIKit
import UserNotifications
import CoreLocation

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private let locationService = LocationService(asksForPermission: false)

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        locationService.startMonitoringSignificantLocationChanges()
        // Every launch, background ones included: a registration the Worker
        // deferred or throttled before the app was last suspended still lands.
        Task { await PushRegistrationService.shared.replayPendingRegistration() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrationService.shared.storeToken(deviceToken)
        // Register with backend using current location
        Task {
            if let location = try? await locationService.currentLocation() {
                let settings = NotificationSettings()
                await PushRegistrationService.shared.registerLocation(location, settings: settings)
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[Push] Failed to register: \(error)")
    }

    // Show notifications even when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
