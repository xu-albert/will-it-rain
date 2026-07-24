import CoreLocation
import Combine

enum LocationError: LocalizedError {
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Location access is needed to show weather for your area."
        }
    }
}

@MainActor
final class LocationService: NSObject, ObservableObject {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    @Published var locationName: String = ""

    override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    private static let lastRegisteredLatKey = "lastRegisteredLat"
    private static let lastRegisteredLonKey = "lastRegisteredLon"
    private static let homeLatKey = "homeLocationLat"
    private static let homeLonKey = "homeLocationLon"
    private static let alwaysPromptShownKey = "alwaysLocationPromptShown"
    private static let throttleDistance: Double = 10_000 // 10 km
    private static let travelDistance: Double = 50_000 // 50 km (~31 miles)

    var hasAlwaysPermission: Bool {
        manager.authorizationStatus == .authorizedAlways
    }

    func requestPermission() {
        manager.requestWhenInUseAuthorization()
    }

    func requestAlwaysPermission() {
        manager.requestAlwaysAuthorization()
        UserDefaults.standard.set(true, forKey: Self.alwaysPromptShownKey)
    }

    func startMonitoringSignificantLocationChanges() {
        guard hasAlwaysPermission else { return }
        manager.delegate = self
        manager.allowsBackgroundLocationUpdates = true
        manager.startMonitoringSignificantLocationChanges()
    }

    /// Check if the user has traveled >50km from their home location and hasn't been prompted yet.
    func hasUserTraveled(from location: CLLocation) -> Bool {
        let defaults = UserDefaults.standard
        // Don't prompt again if already shown
        if defaults.bool(forKey: Self.alwaysPromptShownKey) { return false }
        // Already have "Always"
        if hasAlwaysPermission { return false }
        // Need a home location to compare against
        guard defaults.object(forKey: Self.homeLatKey) != nil else {
            // First time — save as home location
            defaults.set(location.coordinate.latitude, forKey: Self.homeLatKey)
            defaults.set(location.coordinate.longitude, forKey: Self.homeLonKey)
            return false
        }
        let home = CLLocation(
            latitude: defaults.double(forKey: Self.homeLatKey),
            longitude: defaults.double(forKey: Self.homeLonKey)
        )
        return location.distance(from: home) > Self.travelDistance
    }

    /// Returns true if the new location is far enough from the last registered location.
    private func shouldRegister(_ location: CLLocation) -> Bool {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: Self.lastRegisteredLatKey) != nil else { return true }
        let last = CLLocation(
            latitude: defaults.double(forKey: Self.lastRegisteredLatKey),
            longitude: defaults.double(forKey: Self.lastRegisteredLonKey)
        )
        return location.distance(from: last) > Self.throttleDistance
    }

    /// Save the location we just registered with the backend.
    private func saveRegisteredLocation(_ location: CLLocation) {
        let defaults = UserDefaults.standard
        defaults.set(location.coordinate.latitude, forKey: Self.lastRegisteredLatKey)
        defaults.set(location.coordinate.longitude, forKey: Self.lastRegisteredLonKey)
    }

    func currentLocation() async throws -> CLLocation {
        let status = manager.authorizationStatus
        if status == .denied || status == .restricted {
            throw LocationError.permissionDenied
        }

        if status == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            self.manager.delegate = self
            self.manager.requestLocation()
        }
    }

    func reverseGeocode(_ location: CLLocation) async -> String {
        let geocoder = CLGeocoder()
        do {
            let placemarks = try await geocoder.reverseGeocodeLocation(location)
            return placemarks.first?.locality ?? "Current Location"
        } catch {
            return "Current Location"
        }
    }
}

extension LocationService: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.first else { return }
        Task { @MainActor in
            if let continuation = self.continuation {
                continuation.resume(returning: location)
                self.continuation = nil
            } else if self.shouldRegister(location) {
                // Significant location change — register with backend if moved >10km
                let settings = NotificationSettings()
                await PushRegistrationService.shared.registerLocation(
                    lat: location.coordinate.latitude,
                    lon: location.coordinate.longitude,
                    leadTimeMinutes: settings.leadTime,
                    rainStartEnabled: settings.rainStartEnabled,
                    rainEndEnabled: settings.rainEndEnabled
                )
                self.saveRegisteredLocation(location)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}
