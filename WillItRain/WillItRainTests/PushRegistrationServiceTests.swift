import CoreLocation
import XCTest
@testable import WillItRain

final class PushRegistrationServiceTests: XCTestCase {
    private final class URLProtocolStub: URLProtocol {
        static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            guard let handler = Self.handler else {
                XCTFail("URLProtocolStub handler was not set")
                return
            }
            do {
                let (response, data) = try handler(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }

        override func stopLoading() {}

        static func bodyData(from request: URLRequest) throws -> Data {
            if let body = request.httpBody { return body }
            guard let stream = request.httpBodyStream else {
                throw CocoaError(.fileReadCorruptFile)
            }
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count < 0 { throw stream.streamError ?? CocoaError(.fileReadUnknown) }
                if count == 0 { break }
                data.append(buffer, count: count)
            }
            return data
        }
    }

    private var suiteName = ""
    private var defaults: UserDefaults!
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        suiteName = "PushRegistrationServiceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        URLProtocolStub.handler = nil
        session.invalidateAndCancel()
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testConfirmedRegistrationActivatesRemoteOwnershipAndCarriesTheWholePolicy() async throws {
        var requestPayload: RegistrationPayload?
        URLProtocolStub.handler = { request in
            requestPayload = try JSONDecoder().decode(
                RegistrationPayload.self,
                from: try URLProtocolStub.bodyData(from: request)
            )
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data("{\"ok\":true}".utf8)
            )
        }
        var logs: [String] = []
        let service = PushRegistrationService(
            baseURL: URL(string: "https://worker.test")!,
            defaults: defaults,
            session: session,
            log: { logs.append($0) }
        )
        let tokenData = Data(repeating: 0xab, count: 32)
        let fullToken = String(repeating: "ab", count: 32)
        service.storeToken(tokenData)

        let result = await service.registerLocation(
            lat: 37.7,
            lon: -122.4,
            leadTimeMinutes: 45,
            rainStartEnabled: false,
            rainEndEnabled: true,
            quietHoursEnabled: true,
            quietHoursStartMinutes: 21 * 60 + 30,
            quietHoursEndMinutes: 6 * 60 + 15,
            timeZoneIdentifier: "America/Los_Angeles"
        )

        XCTAssertEqual(result, .registered)
        XCTAssertTrue(service.isRemoteRegistrationActive)
        XCTAssertEqual(requestPayload?.token, fullToken)
        XCTAssertEqual(requestPayload?.leadTimeMinutes, 45)
        XCTAssertEqual(requestPayload?.rainStartEnabled, false)
        XCTAssertEqual(requestPayload?.rainEndEnabled, true)
        XCTAssertEqual(requestPayload?.quietHoursEnabled, true)
        XCTAssertEqual(requestPayload?.quietHoursStartMinutes, 21 * 60 + 30)
        XCTAssertEqual(requestPayload?.quietHoursEndMinutes, 6 * 60 + 15)
        XCTAssertEqual(requestPayload?.timeZoneIdentifier, "America/Los_Angeles")
        XCTAssertFalse(logs.contains { $0.contains(fullToken) }, "Operational logs must never contain the APNs token")

        service.storeToken(Data(repeating: 0xcd, count: 32))
        XCTAssertFalse(service.isRemoteRegistrationActive,
                       "A rotated APNs token needs its own confirmed registration")
    }

    func testDeferredSettingsUpdateIsRetriedInsteadOfReportedAsStored() async {
        let retried = expectation(description: "deferred registration retried")
        var requests = 0
        URLProtocolStub.handler = { request in
            requests += 1
            if requests == 1 {
                return (
                    HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: ["Retry-After": "0"])!,
                    Data("{\"deferred\":true,\"retryAfterSeconds\":0}".utf8)
                )
            }
            retried.fulfill()
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data("{\"ok\":true}".utf8)
            )
        }
        let service = PushRegistrationService(
            baseURL: URL(string: "https://worker.test")!,
            defaults: defaults,
            session: session,
            scheduleReplay: { _ in },
            log: { _ in }
        )
        service.storeToken(Data(repeating: 0xab, count: 32))

        let result = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30)

        XCTAssertEqual(result, .deferred(retryAfterSeconds: 0))
        await fulfillment(of: [retried], timeout: 2)
        XCTAssertEqual(requests, 2)
        XCTAssertTrue(service.isRemoteRegistrationActive)
    }

    // MARK: - Durable replay

    private static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    /// Answers each registration with the next canned response and records what was sent.
    private func respond(with responses: [(status: Int, body: String)]) -> () -> [RegistrationPayload] {
        var remaining = responses
        var sent: [RegistrationPayload] = []
        URLProtocolStub.handler = { request in
            sent.append(try JSONDecoder().decode(
                RegistrationPayload.self,
                from: try URLProtocolStub.bodyData(from: request)
            ))
            guard !remaining.isEmpty else { throw URLError(.notConnectedToInternet) }
            let next = remaining.removeFirst()
            if next.status == 0 { throw URLError(.notConnectedToInternet) }
            return (
                HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!,
                Data(next.body.utf8)
            )
        }
        return { sent }
    }

    private func makeService(
        now: @escaping () -> Date,
        scheduleReplay: @escaping (Date) -> Void = { _ in }
    ) -> PushRegistrationService {
        PushRegistrationService(
            baseURL: URL(string: "https://worker.test")!,
            defaults: defaults,
            session: session,
            now: now,
            scheduleReplay: scheduleReplay,
            log: { _ in }
        )
    }

    func testDeferredSettingsChangeSurvivesSuspensionAndIsReplayedWhenDue() async {
        var now = Self.t0
        var replaysScheduled: [Date] = []
        let sent = respond(with: [
            (202, "{\"ok\":false,\"deferred\":true,\"retryAfterSeconds\":240}"),
            (200, "{\"ok\":true}"),
        ])
        let beforeSuspension = makeService(now: { now }, scheduleReplay: { replaysScheduled.append($0) })
        beforeSuspension.storeToken(Data(repeating: 0xab, count: 32))

        let deferred = await beforeSuspension.registerLocation(
            lat: 37.7,
            lon: -122.4,
            leadTimeMinutes: 30,
            quietHoursEnabled: true,
            quietHoursStartMinutes: 21 * 60 + 30,
            quietHoursEndMinutes: 6 * 60 + 15,
            timeZoneIdentifier: "America/Los_Angeles"
        )

        XCTAssertEqual(deferred, .deferred(retryAfterSeconds: 240))
        XCTAssertEqual(replaysScheduled, [Self.t0.addingTimeInterval(240)],
                       "The background refresh must be asked for at the Worker's retry time")
        XCTAssertFalse(beforeSuspension.isRemoteRegistrationActive)

        // What a background refresh or the next launch runs: a new process that
        // knows only what was persisted.
        let afterSuspension = makeService(now: { now }, scheduleReplay: { replaysScheduled.append($0) })
        XCTAssertEqual(afterSuspension.pendingRetryDate, Self.t0.addingTimeInterval(240))

        now = Self.t0.addingTimeInterval(100)
        let early = await afterSuspension.replayPendingRegistration()
        XCTAssertEqual(early, .deferred(retryAfterSeconds: 140))
        XCTAssertEqual(sent().count, 1, "A replay must not go out before the Worker's retry time")

        now = Self.t0.addingTimeInterval(240)
        let replayed = await afterSuspension.replayPendingRegistration()
        XCTAssertEqual(replayed, .registered)
        XCTAssertEqual(sent().count, 2)
        XCTAssertEqual(sent().last, sent().first, "The replay carries exactly the deferred policy")
        XCTAssertEqual(sent().last?.quietHoursStartMinutes, 21 * 60 + 30)
        XCTAssertTrue(afterSuspension.isRemoteRegistrationActive)
        XCTAssertNil(afterSuspension.pendingRetryDate)

        let nothingWaiting = await afterSuspension.replayPendingRegistration()
        XCTAssertNil(nothingWaiting)
        XCTAssertEqual(sent().count, 2)
    }

    func testThrottledRegistrationIsReplayedAfterTheWorkersRetryAfter() async {
        var now = Self.t0
        var replaysScheduled: [Date] = []
        let sent = respond(with: [
            (429, "{\"error\":\"Too many registration requests\",\"code\":\"rate_limited\",\"retryAfterSeconds\":420}"),
            (200, "{\"ok\":true}"),
        ])
        let service = makeService(now: { now }, scheduleReplay: { replaysScheduled.append($0) })
        service.storeToken(Data(repeating: 0xab, count: 32))

        let throttled = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30, rainStartEnabled: false)

        XCTAssertEqual(throttled, .deferred(retryAfterSeconds: 420))
        XCTAssertEqual(service.pendingRetryDate, Self.t0.addingTimeInterval(420))
        XCTAssertEqual(replaysScheduled, [Self.t0.addingTimeInterval(420)])

        now = Self.t0.addingTimeInterval(420)
        let replayed = await makeService(now: { now }).replayPendingRegistration()

        XCTAssertEqual(replayed, .registered)
        XCTAssertEqual(sent().map(\.rainStartEnabled), [false, false])
    }

    func testANewerPayloadReplacesTheOneWaitingEvenWhenItCannotBeSent() async {
        var now = Self.t0
        let sent = respond(with: [
            (202, "{\"ok\":false,\"deferred\":true,\"retryAfterSeconds\":60}"),
            (0, ""),
            (200, "{\"ok\":true}"),
        ])
        let service = makeService(now: { now })
        service.storeToken(Data(repeating: 0xab, count: 32))

        _ = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30, quietHoursEnabled: false)
        let offline = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30, quietHoursEnabled: true)
        XCTAssertEqual(offline, .unavailable)

        now = Self.t0.addingTimeInterval(60)
        let replayed = await service.replayPendingRegistration()

        XCTAssertEqual(replayed, .registered)
        XCTAssertEqual(sent().map(\.quietHoursEnabled), [false, true, true],
                       "Replaying the older payload would undo the user's latest change")
    }

    func testAConfirmedRegistrationLeavesNothingToReplay() async {
        let now = Self.t0
        let sent = respond(with: [
            (202, "{\"ok\":false,\"deferred\":true,\"retryAfterSeconds\":60}"),
            (200, "{\"ok\":true}"),
        ])
        let service = makeService(now: { now })
        service.storeToken(Data(repeating: 0xab, count: 32))

        _ = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30)
        let confirmed = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 45)

        XCTAssertEqual(confirmed, .registered)
        XCTAssertNil(service.pendingRetryDate)
        let nothingWaiting = await service.replayPendingRegistration()
        XCTAssertNil(nothingWaiting)
        XCTAssertEqual(sent().map(\.leadTimeMinutes), [30, 45])
    }
}
