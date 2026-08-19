import XCTest
import CoreLocation
@testable import WillItRain

/// A CLLocationManager that reports a usable authorization status and records
/// `requestLocation()` calls instead of asking the system for a fix, so the
/// delegate can be driven deterministically and headlessly.
private final class StubLocationManager: CLLocationManager {
    var requests = 0
    override var authorizationStatus: CLAuthorizationStatus { .authorizedWhenInUse }
    override func requestLocation() { requests += 1 }
}

/// Holds a `currentLocation()` call's result so the test can poll for it. Polling
/// rather than awaiting matters: the defect these cover leaves the call suspended
/// forever, and a test that awaited it directly would hang CI instead of failing.
@MainActor
private final class Outcome {
    var result: Result<CLLocation, Error>?
}

/// `LocationService` coalesces every concurrent `currentLocation()` caller onto
/// one in-flight `requestLocation()`. These cover the property that makes that
/// safe: whatever the delegate does, no caller is left suspended and the next
/// call can always start a fresh request.
@MainActor
final class LocationServiceTests: XCTestCase {

    private let fix = CLLocation(latitude: 37.7749, longitude: -122.4194)

    func testEmptyLocationsArrayFailsWaitersInsteadOfStrandingThem() async {
        let manager = StubLocationManager()
        let service = LocationService(manager: manager)

        let outcome = start(service)
        await waitForRequests(on: manager, count: 1)

        // The delegate callback CLLocationManager promises, carrying nothing.
        // Returning silently here used to leave the waiter list permanently
        // non-empty, so this call never resumed.
        service.locationManager(manager, didUpdateLocations: [])

        guard let result = await settle(outcome) else {
            return XCTFail("currentLocation() never resumed after an empty location update")
        }
        guard case .failure(let error) = result, case LocationError.noFix = error else {
            return XCTFail("Expected .noFix, got \(result)")
        }
    }

    func testANewRequestIsIssuedAfterAnEmptyUpdate() async {
        let manager = StubLocationManager()
        let service = LocationService(manager: manager)

        let first = start(service)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didUpdateLocations: [])
        _ = await settle(first)

        // The wedge this guards against is not the failed call but everything
        // after it: with the in-flight request never cleared, no later caller
        // would ever reach requestLocation() again.
        let retry = start(service)
        await waitForRequests(on: manager, count: 2)
        service.locationManager(manager, didUpdateLocations: [fix])

        guard let result = await settle(retry), case .success(let location) = result else {
            return XCTFail("A fresh request must be possible after an empty update")
        }
        XCTAssertEqual(location.coordinate.latitude, fix.coordinate.latitude, accuracy: 0.0001)
    }

    func testConcurrentCallersShareOneRequestAndAllResume() async {
        let manager = StubLocationManager()
        let service = LocationService(manager: manager)

        let first = start(service)
        let second = start(service)
        await waitForRequests(on: manager, count: 1)

        service.locationManager(manager, didUpdateLocations: [fix])

        for outcome in [first, second] {
            guard let result = await settle(outcome), case .success = result else {
                return XCTFail("Every coalesced caller must receive the one fix")
            }
        }
        // One fix served both: a second request would mean the callers raced
        // rather than coalesced.
        XCTAssertEqual(manager.requests, 1)
    }

    func testDelegateFailureResumesEveryWaiterAndClearsTheRequest() async {
        let manager = StubLocationManager()
        let service = LocationService(manager: manager)

        let attempt = start(service)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didFailWithError: CLError(.locationUnknown))

        guard let result = await settle(attempt), case .failure = result else {
            return XCTFail("A delegate error must resume the waiters")
        }

        let retry = start(service)
        await waitForRequests(on: manager, count: 2)
        service.locationManager(manager, didUpdateLocations: [fix])
        guard let retried = await settle(retry), case .success = retried else {
            return XCTFail("A fresh request must be possible after a failure")
        }
    }

    // MARK: - Helpers

    private func start(_ service: LocationService) -> Outcome {
        let outcome = Outcome()
        Task { @MainActor in
            do {
                outcome.result = .success(try await service.currentLocation())
            } catch {
                outcome.result = .failure(error)
            }
        }
        return outcome
    }

    /// Polls until the call resolves, or gives up so the test fails rather than hangs.
    private func settle(_ outcome: Outcome) async -> Result<CLLocation, Error>? {
        for _ in 0..<200 where outcome.result == nil {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return outcome.result
    }

    /// Yields until the service has issued `count` requests, so the delegate is
    /// never driven before a waiter has been enqueued.
    private func waitForRequests(
        on manager: StubLocationManager,
        count: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<200 where manager.requests < count {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(manager.requests, count, "Service never issued the request", file: file, line: line)
    }
}
