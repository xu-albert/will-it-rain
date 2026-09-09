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
            ContentView()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background {
                scheduleBackgroundRefresh(after: 15 * 60)
            }
        }
    }

    // MARK: - Background Tasks

    private func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "com.willitrain.refresh",
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { return }
            handleBackgroundRefresh(refreshTask)
        }
    }

    private func scheduleBackgroundRefresh(after interval: TimeInterval) {
        let clamped = min(max(interval, 2 * 60), 60 * 60)
        let request = BGAppRefreshTaskRequest(identifier: "com.willitrain.refresh")
        request.earliestBeginDate = Date(timeIntervalSinceNow: clamped)
        do {
            try BGTaskScheduler.shared.submit(request)
            print("[Background] Scheduled refresh in \(Int(clamped))s")
        } catch {
            print("Background task scheduling failed: \(error)")
        }
    }

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        let operation = Task {
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
                scheduleBackgroundRefresh(after: nextInterval)
                task.setTaskCompleted(success: true)
            } catch {
                scheduleBackgroundRefresh(after: 15 * 60)
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            operation.cancel()
        }
    }
}
