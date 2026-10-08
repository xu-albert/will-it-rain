import XCTest
import CoreLocation
import UIKit
@testable import WillItRain

/// A CLLocationManager that reports a usable authorization status and records
/// `requestLocation()` calls instead of asking the system for a fix, so the
/// delegate can be driven deterministically and headlessly.
private final class StubLocationManager: CLLocationManager {
    var requests = 0
    var authorizationRequests = 0
    var status: CLAuthorizationStatus = .authorizedWhenInUse
    override var authorizationStatus: CLAuthorizationStatus { status }
    override func requestLocation() { requests += 1 }
    override func requestWhenInUseAuthorization() { authorizationRequests += 1 }
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

    // MARK: - First launch

    func testAFixIsNotRequestedUntilTheUserAnswersThePrompt() async {
        // Asking for a fix while the status is still .notDetermined fails at
        // once with kCLErrorDenied: a fresh install's first screen was
        // "Connection Issue - kCLErrorDomain error 1" right after Allow.
        let manager = StubLocationManager()
        manager.status = .notDetermined
        let service = LocationService(manager: manager, notificationCenter: NotificationCenter())

        let outcome = start(service)
        await waitUntil { manager.authorizationRequests == 1 }
        XCTAssertEqual(manager.requests, 0, "No fix may be requested before the prompt is answered")

        // CoreLocation reports the initial .notDetermined as soon as a delegate
        // is set; that is not an answer.
        service.locationManagerDidChangeAuthorization(manager)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(manager.requests, 0)

        manager.status = .authorizedWhenInUse
        service.locationManagerDidChangeAuthorization(manager)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didUpdateLocations: [fix])

        guard let result = await settle(outcome), case .success = result else {
            return XCTFail("The first fix after Allow must reach the caller")
        }
    }

    func testCallersWaitingOnThePromptShareOneRequest() async {
        let manager = StubLocationManager()
        manager.status = .notDetermined
        let service = LocationService(manager: manager, notificationCenter: NotificationCenter())

        let first = start(service)
        let second = start(service)
        await waitUntil { manager.authorizationRequests >= 1 }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(manager.authorizationRequests, 1)

        manager.status = .authorizedWhenInUse
        service.locationManagerDidChangeAuthorization(manager)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didUpdateLocations: [fix])

        for outcome in [first, second] {
            guard let result = await settle(outcome), case .success = result else {
                return XCTFail("Every caller waiting on the prompt must get the fix")
            }
        }
    }

    func testAPromptStillUnansweredWhenTheAppBecomesActiveIsAskedForAgain() async {
        // A request made on the way back from the background may never become a
        // prompt; with nothing asking again, every caller would wait forever.
        let manager = StubLocationManager()
        manager.status = .notDetermined
        let center = NotificationCenter()
        let service = LocationService(manager: manager, notificationCenter: center)

        // Nobody waiting: becoming active asks for nothing.
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(manager.authorizationRequests, 0)

        let outcome = start(service)
        await waitUntil { manager.authorizationRequests == 1 }
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(manager.authorizationRequests, 2)

        manager.status = .authorizedWhenInUse
        service.locationManagerDidChangeAuthorization(manager)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didUpdateLocations: [fix])
        guard let result = await settle(outcome), case .success = result else {
            return XCTFail("The answer to the repeated request must reach the caller")
        }

        // Answered: becoming active again asks for nothing.
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(manager.authorizationRequests, 2)
    }

    func testDenyingThePromptFailsAsPermissionDenied() async {
        let manager = StubLocationManager()
        manager.status = .notDetermined
        let service = LocationService(manager: manager, notificationCenter: NotificationCenter())

        let outcome = start(service)
        await waitUntil { manager.authorizationRequests == 1 }
        manager.status = .denied
        service.locationManagerDidChangeAuthorization(manager)

        guard let result = await settle(outcome),
              case .failure(let error) = result,
              case LocationError.permissionDenied = error else {
            return XCTFail("Denying the prompt must read as permission denied")
        }
        XCTAssertEqual(manager.requests, 0)
    }

    func testAServiceThatMayNotAskFailsAtOnceInsteadOfWaitingOnThePrompt() async {
        // The background refresh: no prompt appears there, so after "Allow
        // Once" lapsed it waited for an answer that never came and its task
        // never completed.
        let manager = StubLocationManager()
        manager.status = .notDetermined
        let service = LocationService(manager: manager, asksForPermission: false)

        guard let result = await settle(start(service)),
              case .failure(let error) = result,
              case LocationError.permissionDenied = error else {
            return XCTFail("A service that may not ask must fail at once while nobody has answered")
        }
        XCTAssertEqual(manager.authorizationRequests, 0)
        XCTAssertEqual(manager.requests, 0)

        // Once the user has allowed it, the same service gets its fix.
        manager.status = .authorizedWhenInUse
        let retry = start(service)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didUpdateLocations: [fix])
        guard let retried = await settle(retry), case .success = retried else {
            return XCTFail("A service that may not ask must still get a fix once allowed")
        }
    }

    func testCoreLocationErrorsReachCallersAsLocationErrors() async {
        // A raw CLError reached the screen as "kCLErrorDomain error 0".
        let manager = StubLocationManager()
        let service = LocationService(manager: manager)

        let attempt = start(service)
        await waitForRequests(on: manager, count: 1)
        service.locationManager(manager, didFailWithError: CLError(.locationUnknown))
        guard let result = await settle(attempt),
              case .failure(let error) = result,
              case LocationError.noFix = error else {
            return XCTFail("locationUnknown must surface as .noFix")
        }

        // kCLErrorDenied while authorized is a transient refusal, not a denial.
        let retry = start(service)
        await waitForRequests(on: manager, count: 2)
        service.locationManager(manager, didFailWithError: CLError(.denied))
        guard let retried = await settle(retry),
              case .failure(let retryError) = retried,
              case LocationError.noFix = retryError else {
            return XCTFail("kCLErrorDenied while authorized must surface as .noFix")
        }
    }

    // MARK: - Helpers

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "Condition never became true")
    }

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
