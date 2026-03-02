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

    func requestPermission() {
        manager.requestWhenInUseAuthorization()
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
            continuation?.resume(returning: location)
            continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}
