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
            log: { _ in }
        )
        service.storeToken(Data(repeating: 0xab, count: 32))

        let result = await service.registerLocation(lat: 37.7, lon: -122.4, leadTimeMinutes: 30)

        XCTAssertEqual(result, .deferred(retryAfterSeconds: 0))
        await fulfillment(of: [retried], timeout: 2)
        XCTAssertEqual(requests, 2)
        XCTAssertTrue(service.isRemoteRegistrationActive)
    }
}
