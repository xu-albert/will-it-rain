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
        .onChange(of: scenePhase) { phase in
            if phase == .background {
                scheduleBackgroundRefresh()
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

    private func scheduleBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: "com.willitrain.refresh")
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("Background task scheduling failed: \(error)")
        }
    }

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        scheduleBackgroundRefresh()

        let operation = Task {
            do {
                let locationService = LocationService()
                let weatherService = WeatherService()
                let location = try await locationService.currentLocation()
                let name = await locationService.reverseGeocode(location)
                let forecast = try await weatherService.fetch(location: location, locationName: name)

                var settings = NotificationSettings.load()
                NotificationService.shared.evaluateAndSchedule(forecast: forecast, settings: &settings)
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }

        task.expirationHandler = {
            operation.cancel()
        }
    }
}
