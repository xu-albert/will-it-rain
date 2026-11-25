import XCTest
@testable import WillItRain

#if canImport(MetricKit)
import MetricKit
#endif

final class AppLoggerTests: XCTestCase {

    // MARK: - AppLogger ring buffer & categories

    private nonisolated final class ClockBox: @unchecked Sendable {
        private let lock = NSLock()
        private var current: Date

        init(_ start: Date) {
            self.current = start
        }

        func next() -> Date {
            lock.lock()
            defer { lock.unlock() }
            current = current.addingTimeInterval(1)
            return current
        }
    }

    func testRingBufferEnforcesCapacityAndPreservesOrder() {
        let clock = ClockBox(Date(timeIntervalSince1970: 1_700_000_000))
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 5, now: { clock.next() })

        for i in 1...8 {
            logger.category(.weather).info("event \(i)")
        }

        let entries = logger.recentEntries()
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(entries.map(\.message), ["event 4", "event 5", "event 6", "event 7", "event 8"])
        XCTAssertEqual(Set(entries.map(\.category)), [.weather])
        XCTAssertEqual(Set(entries.map(\.level)), [.info])
    }

    func testDefaultCapacityCapsAt150Entries() {
        let logger = AppLogger(subsystem: "com.willitrain.test")
        XCTAssertEqual(logger.capacity, 150)

        for i in 1...200 {
            logger.category(.push).info("entry \(i)")
        }

        let entries = logger.recentEntries()
        XCTAssertEqual(entries.count, 150)
        XCTAssertEqual(entries.first?.message, "entry 51")
        XCTAssertEqual(entries.last?.message, "entry 200")
    }

    func testCategoryFilteringDumpAndClear() {
        let fixed = Date(timeIntervalSince1970: 1_700_000_000)
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 20, now: { fixed })

        logger.category(.push).info("push ok")
        logger.category(.activity).warning("activity stale")
        logger.category(.weather).error("weather timeout")
        logger.category(.notifications).info("notif armed")
        logger.category(.background).info("bg scheduled")
        logger.category(.metrics).info("metrics ready")

        XCTAssertEqual(logger.recentEntries().count, 6)
        XCTAssertEqual(logger.recentEntries(category: .weather).map(\.message), ["weather timeout"])
        XCTAssertEqual(logger.recentEntries(category: .activity).map(\.level), [.warning])

        let dump = logger.formattedDump(category: .weather)
        XCTAssertTrue(dump.contains("[ERROR]"))
        XCTAssertTrue(dump.contains("[weather]"))
        XCTAssertTrue(dump.contains("weather timeout"))

        logger.clear()
        XCTAssertTrue(logger.recentEntries().isEmpty)
    }

    func testSanitizerRedactsTokensJWTsAndExactCoordinatesWhileKeepingCoarseGridKeys() {
        let deviceToken = String(repeating: "ab", count: 32)
        let activityToken = String(repeating: "cd", count: 32)
        let jwt = "Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.signature123"

        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 10)
        logger.category(.push).error(
            "HTTP 503 code=coverage_at_capacity grid=37.75,-122.40 token=\(deviceToken) url=https://api.push.apple.com/3/device/\(activityToken) auth=\(jwt) lat=37.774929 lon=-122.419416"
        )

        let message = logger.recentEntries().first?.message ?? ""
        XCTAssertTrue(message.contains("HTTP 503"))
        XCTAssertTrue(message.contains("code=coverage_at_capacity"))
        XCTAssertTrue(message.contains("grid=37.75,-122.40"))
        XCTAssertFalse(message.contains(deviceToken), "Raw APNs device token must be redacted")
        XCTAssertFalse(message.contains(activityToken), "Raw Live Activity token must be redacted")
        XCTAssertFalse(message.contains("eyJhbGciOiJFUzI1NiJ9"), "Bearer JWT must be redacted")
        XCTAssertFalse(message.contains("37.774929"), "Exact latitude must be redacted")
        XCTAssertFalse(message.contains("-122.419416"), "Exact longitude must be redacted")
    }

    func testConcurrentWritesAreThreadSafe() async {
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 150)
        await withTaskGroup(of: Void.self) { group in
            for worker in 0..<8 {
                group.addTask {
                    for i in 0..<30 {
                        logger.category(.background).info("w\(worker)-\(i)")
                    }
                }
            }
        }
        XCTAssertEqual(logger.recentEntries().count, 150)
    }

    // MARK: - PushRegistrationService -> AppLogger integration

    private final class StubURLProtocol: URLProtocol {
        static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            guard let handler = Self.handler else { return }
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
    }

    @MainActor
    func testPushRegistrationLogsStatusAndServerErrorCodeToAppLoggerWithoutLeakingToken() async {
        let suiteName = "AppLoggerTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer {
            StubURLProtocol.handler = nil
            defaults.removePersistentDomain(forName: suiteName)
        }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        StubURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!,
                Data("{\"error\":\"At limit\",\"code\":\"coverage_at_capacity\"}".utf8)
            )
        }

        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 20)
        let service = PushRegistrationService(
            baseURL: URL(string: "https://worker.test")!,
            defaults: defaults,
            session: session,
            scheduleReplay: { _ in },
            logger: logger
        )

        let rawToken = String(repeating: "ef", count: 32)
        service.storeToken(Data(repeating: 0xef, count: 32))
        let result = await service.registerLocation(lat: 37.774929, lon: -122.419416, leadTimeMinutes: 20)

        XCTAssertEqual(result, .rejected)
        let pushEntries = logger.recentEntries(category: .push)
        let rejection = pushEntries.first { $0.level == .error }
        XCTAssertNotNil(rejection)
        XCTAssertTrue(rejection?.message.contains("HTTP 503") == true)
        XCTAssertTrue(rejection?.message.contains("code=coverage_at_capacity") == true)
        XCTAssertFalse(pushEntries.contains { $0.message.contains(rawToken) })
        XCTAssertFalse(pushEntries.contains { $0.message.contains("37.774929") })
    }

    // MARK: - MetricKitDiagnostics

    func testMetricKitStartAndStopAreIdempotent() {
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 20)
        var added = 0
        var removed = 0
        let diagnostics = MetricKitDiagnostics(
            logger: logger,
            registerSubscriber: { _ in added += 1 },
            unregisterSubscriber: { _ in removed += 1 }
        )

        XCTAssertFalse(diagnostics.isStarted)
        diagnostics.start()
        diagnostics.start()
        XCTAssertTrue(diagnostics.isStarted)
        XCTAssertEqual(added, 1)

        diagnostics.stop()
        diagnostics.stop()
        XCTAssertFalse(diagnostics.isStarted)
        XCTAssertEqual(removed, 1)
    }

    func testMetricKitLogsMetricSummariesAndEscalatesAbnormalExits() {
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 20)
        let diagnostics = MetricKitDiagnostics(
            logger: logger,
            registerSubscriber: { _ in },
            unregisterSubscriber: { _ in }
        )

        diagnostics.record(
            metricSummary: .init(
                windowSeconds: 86_400,
                cumulativeCPUTimeSeconds: 12.5,
                cumulativeLogicalWritesMB: 4.25,
                launchTimeToFirstDrawBuckets: 3,
                launchResumeBuckets: 2,
                hangTimeBuckets: 0,
                foregroundAbnormalExits: 0,
                backgroundAbnormalExits: 0
            )
        )

        diagnostics.record(
            metricSummary: .init(
                windowSeconds: 86_400,
                cumulativeCPUTimeSeconds: 30.0,
                cumulativeLogicalWritesMB: 18.0,
                launchTimeToFirstDrawBuckets: 1,
                launchResumeBuckets: 1,
                hangTimeBuckets: 2,
                foregroundAbnormalExits: 1,
                backgroundAbnormalExits: 2
            )
        )

        let entries = logger.recentEntries(category: .metrics)
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].level, .info)
        XCTAssertTrue(entries[0].message.contains("cpu=12.50s"))
        XCTAssertTrue(entries[0].message.contains("diskWrites=4.25MB"))
        XCTAssertTrue(entries[0].message.contains("launchBuckets(firstDraw=3,resume=2)"))

        XCTAssertEqual(entries[1].level, .warning)
        XCTAssertTrue(entries[1].message.contains("abnormalExits(fg=1,bg=2)"))
        XCTAssertTrue(entries[1].message.contains("hangBuckets=2"))
    }

    func testMetricKitLogsCrashHangCPUAndDiskDiagnosticsAndSanitizesSecrets() {
        let logger = AppLogger(subsystem: "com.willitrain.test", capacity: 20)
        let diagnostics = MetricKitDiagnostics(
            logger: logger,
            registerSubscriber: { _ in },
            unregisterSubscriber: { _ in }
        )
        let leakedToken = String(repeating: "ab", count: 32)

        diagnostics.record(
            diagnosticSummary: .init(
                windowSeconds: 3_600,
                crashes: [
                    .init(
                        signal: 11,
                        exceptionType: 1,
                        exceptionCode: 1,
                        terminationReason: "Namespace SIGNAL, Code 11 token=\(leakedToken)"
                    )
                ],
                hangs: [.init(durationSeconds: 2.75)],
                cpuExceptions: [.init(totalCPUTimeSeconds: 95.0, totalSampledTimeSeconds: 100.0)],
                diskWriteExceptions: [.init(totalWritesMB: 1200.5)]
            )
        )

        let entries = logger.recentEntries(category: .metrics)
        XCTAssertEqual(entries.count, 4)
        XCTAssertTrue(entries.allSatisfy { $0.level == .error })
        XCTAssertTrue(entries[0].message.contains("crash diagnostic") && entries[0].message.contains("signal=11"))
        XCTAssertFalse(entries[0].message.contains(leakedToken))
        XCTAssertTrue(entries[1].message.contains("hang diagnostic") && entries[1].message.contains("duration=2.75s"))
        XCTAssertTrue(entries[2].message.contains("CPU exception diagnostic") && entries[2].message.contains("cpuTime=95.00s"))
        XCTAssertTrue(entries[3].message.contains("disk-write exception diagnostic") && entries[3].message.contains("writes=1200.50MB"))

        // Empty diagnostic payload logs cleanly at info level
        diagnostics.record(
            diagnosticSummary: .init(
                windowSeconds: 3_600,
                crashes: [],
                hangs: [],
                cpuExceptions: [],
                diskWriteExceptions: []
            )
        )
        XCTAssertEqual(logger.recentEntries(category: .metrics).last?.level, .info)

        #if canImport(MetricKit)
        // Real delegate entry points accept empty arrays cleanly in Simulator
        diagnostics.didReceive([MXMetricPayload]())
        diagnostics.didReceive([MXDiagnosticPayload]())
        #endif
    }
}
