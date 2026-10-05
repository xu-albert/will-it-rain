import SwiftUI
import BackgroundTasks
import UIKit

@main
struct WillItRainApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        registerBackgroundTask()
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // -liveActivityCards A,B,C renders the lock-screen card instead of
            // the app, so the harness can screenshot a presentation that is
            // otherwise only reachable by locking the device.
            if let preview = LiveActivityCardPreview.fromLaunchArgs(CommandLine.arguments) {
                preview
            } else {
                ContentView()
            }
            #else
            ContentView()
            #endif
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background:
                BackgroundRefresh.schedule(after: 15 * 60)
            case .active:
                Task { await PushRegistrationService.shared.replayPendingRegistration() }
            default:
                break
            }
        }
    }

    // MARK: - Background Tasks

    private func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: BackgroundRefresh.identifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { return }
            handleBackgroundRefresh(refreshTask)
        }
    }

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        let operation = Task {
            // Needs no location fix, so it runs even when the weather work below fails.
            await PushRegistrationService.shared.replayPendingRegistration()
            do {
                let locationService = LocationService()
                let weatherService = WeatherService()
                let location = try await locationService.currentLocation()
                let name = await locationService.reverseGeocode(location)
                let forecast = try await weatherService.fetch(location: location, locationName: name)

                let settings = NotificationSettings()
                NotificationService.shared.evaluateAndSchedule(forecast: forecast, settings: settings)
                LiveActivityService.shared.sync(forecast: forecast, settings: settings)

                let nextInterval = forecast.nextPollInterval(leadTimeMinutes: settings.leadTime)
                BackgroundRefresh.schedule(after: nextInterval)
                task.setTaskCompleted(success: true)
            } catch {
                BackgroundRefresh.schedule(after: 15 * 60)
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            operation.cancel()
        }
    }
}
