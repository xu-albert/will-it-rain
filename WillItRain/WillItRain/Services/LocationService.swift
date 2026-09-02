import CoreLocation
import Combine

enum LocationError: LocalizedError {
    case permissionDenied
    case noFix

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Location access is needed to show weather for your area."
        case .noFix:
            return "Couldn't get a location fix. Try again in a moment."
        }
    }
}

@MainActor
final class LocationService: NSObject, ObservableObject {
    private let manager: CLLocationManager

    // Every caller waiting on the one in-flight `requestLocation()`. This is a
    // list, not a single slot, because there is genuinely more than one caller:
    // the weather poller and the foreground re-registration can both start on
    // the same MainActor turn when the app returns from the background. A single
    // slot let the second caller overwrite the first, and an overwritten
    // CheckedContinuation is never resumed — the orphaned `await` hangs for the
    // lifetime of the process.
    private var waiters: [CheckedContinuation<CLLocation, Error>] = []

    // Whether a `requestLocation()` is outstanding. Tracked explicitly rather
    // than inferred from `waiters.count == 1`, because those two facts come
    // apart: any delegate callback that returned without resuming the waiters
    // would leave the list permanently non-empty, so no later caller would ever
    // issue a request and every one of them would wait forever. Every path out
    // of the delegate clears this by resuming the waiters.
    private var requestInFlight = false

    @Published var locationName: String = ""

    init(manager: CLLocationManager = CLLocationManager()) {
        self.manager = manager
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
            self.waiters.append(continuation)
            self.manager.delegate = self
            // `requestLocation()` promises exactly one delegate callback, and
            // that callback resumes every waiter, so a caller arriving while a
            // request is already in flight rides along with it instead of
            // starting a second one.
            if !self.requestInFlight {
                self.requestInFlight = true
                self.manager.requestLocation()
            }
        }
    }

    /// Hands one location fix — or one failure — to everyone waiting on it.
    ///
    /// Also ends the in-flight request, so this is what every delegate path has
    /// to call: it is the single point where both "nobody is left suspended" and
    /// "the next caller can start a fresh request" become true again.
    private func resumeWaiters(with result: Result<CLLocation, Error>) {
        requestInFlight = false
        let pending = waiters
        waiters.removeAll()
        for continuation in pending {
            continuation.resume(with: result)
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
        Task { @MainActor in
            // CLLocationManager documents this array as never empty, but the
            // guard has to end the request rather than just return: bailing out
            // silently would strand every waiter forever.
            guard let location = locations.first else {
                self.resumeWaiters(with: .failure(LocationError.noFix))
                return
            }

            let hadWaiters = !self.waiters.isEmpty
            self.resumeWaiters(with: .success(location))

            if !hadWaiters, self.shouldRegister(location) {
                // Significant location change — register with backend if moved >10km
                let settings = NotificationSettings()
                await PushRegistrationService.shared.registerLocation(location, settings: settings)
                self.saveRegisteredLocation(location)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.resumeWaiters(with: .failure(error))
        }
    }
}
