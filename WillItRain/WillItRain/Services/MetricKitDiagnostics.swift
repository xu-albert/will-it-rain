import Foundation

#if canImport(MetricKit)
import MetricKit
#endif

/// Subscribes to Apple MetricKit (`MXMetricManager`) at launch and records
/// incoming crash, hang, CPU, disk-write, exit, and launch diagnostic payloads
/// via `AppLogger.metrics`.
///
/// Safe in Simulator and unit tests: registration is idempotent, payloads are
/// summarized into bounded sanitized strings without user PII, and the summary
/// formatting path can be exercised directly in unit tests.
nonisolated final class MetricKitDiagnostics: NSObject, @unchecked Sendable {
    struct MetricSummary: Equatable, Sendable {
        let windowSeconds: Int
        let cumulativeCPUTimeSeconds: Double?
        let cumulativeLogicalWritesMB: Double?
        let launchTimeToFirstDrawBuckets: Int
        let launchResumeBuckets: Int
        let hangTimeBuckets: Int
        let foregroundAbnormalExits: Int
        let backgroundAbnormalExits: Int
    }

    struct DiagnosticSummary: Equatable, Sendable {
        struct CrashItem: Equatable, Sendable {
            let signal: Int?
            let exceptionType: Int?
            let exceptionCode: Int?
            let terminationReason: String?
        }

        struct HangItem: Equatable, Sendable {
            let durationSeconds: Double
        }

        struct CPUExceptionItem: Equatable, Sendable {
            let totalCPUTimeSeconds: Double
            let totalSampledTimeSeconds: Double
        }

        struct DiskWriteExceptionItem: Equatable, Sendable {
            let totalWritesMB: Double
        }

        let windowSeconds: Int
        let crashes: [CrashItem]
        let hangs: [HangItem]
        let cpuExceptions: [CPUExceptionItem]
        let diskWriteExceptions: [DiskWriteExceptionItem]

        var totalCount: Int {
            crashes.count + hangs.count + cpuExceptions.count + diskWriteExceptions.count
        }
    }

    static let shared = MetricKitDiagnostics()

    private let logger: AppLogger
    private let registerSubscriber: (MetricKitDiagnostics) -> Void
    private let unregisterSubscriber: (MetricKitDiagnostics) -> Void
    private let lock = NSLock()
    private var started = false

    init(
        logger: AppLogger = .shared,
        registerSubscriber: ((MetricKitDiagnostics) -> Void)? = nil,
        unregisterSubscriber: ((MetricKitDiagnostics) -> Void)? = nil
    ) {
        self.logger = logger
        #if canImport(MetricKit)
        self.registerSubscriber = registerSubscriber ?? { subscriber in
            MXMetricManager.shared.add(subscriber)
        }
        self.unregisterSubscriber = unregisterSubscriber ?? { subscriber in
            MXMetricManager.shared.remove(subscriber)
        }
        #else
        self.registerSubscriber = registerSubscriber ?? { _ in }
        self.unregisterSubscriber = unregisterSubscriber ?? { _ in }
        #endif
        super.init()
    }

    var isStarted: Bool {
        lock.lock()
        let value = started
        lock.unlock()
        return value
    }

    func start() {
        lock.lock()
        guard !started else {
            lock.unlock()
            return
        }
        started = true
        lock.unlock()

        registerSubscriber(self)
        logger.category(.metrics).info("MetricKit subscriber registered")
    }

    func stop() {
        lock.lock()
        guard started else {
            lock.unlock()
            return
        }
        started = false
        lock.unlock()

        unregisterSubscriber(self)
        logger.category(.metrics).info("MetricKit subscriber unregistered")
    }

    func record(metricSummary summary: MetricSummary) {
        var parts: [String] = ["window=\(summary.windowSeconds)s"]
        if let cpu = summary.cumulativeCPUTimeSeconds {
            parts.append(String(format: "cpu=%.2fs", cpu))
        }
        if let writes = summary.cumulativeLogicalWritesMB {
            parts.append(String(format: "diskWrites=%.2fMB", writes))
        }
        if summary.launchTimeToFirstDrawBuckets > 0 || summary.launchResumeBuckets > 0 {
            parts.append(
                "launchBuckets(firstDraw=\(summary.launchTimeToFirstDrawBuckets),resume=\(summary.launchResumeBuckets))"
            )
        }
        if summary.hangTimeBuckets > 0 {
            parts.append("hangBuckets=\(summary.hangTimeBuckets)")
        }
        parts.append(
            "abnormalExits(fg=\(summary.foregroundAbnormalExits),bg=\(summary.backgroundAbnormalExits))"
        )

        let message = "MetricKit metric payload: \(parts.joined(separator: " "))"
        let hasAbnormalExits = summary.foregroundAbnormalExits > 0 || summary.backgroundAbnormalExits > 0
        if hasAbnormalExits {
            logger.category(.metrics).warning(message)
        } else {
            logger.category(.metrics).info(message)
        }
    }

    func record(diagnosticSummary summary: DiagnosticSummary) {
        let log = logger.category(.metrics)
        if summary.totalCount == 0 {
            log.info("MetricKit diagnostic payload: window=\(summary.windowSeconds)s count=0")
            return
        }

        for crash in summary.crashes {
            var details: [String] = ["window=\(summary.windowSeconds)s"]
            if let signal = crash.signal { details.append("signal=\(signal)") }
            if let exceptionType = crash.exceptionType { details.append("exceptionType=\(exceptionType)") }
            if let exceptionCode = crash.exceptionCode { details.append("exceptionCode=\(exceptionCode)") }
            if let reason = crash.terminationReason, !reason.isEmpty {
                details.append("reason=\(reason.prefix(160))")
            }
            log.error("MetricKit crash diagnostic: \(details.joined(separator: " "))")
        }

        for hang in summary.hangs {
            log.error(
                String(
                    format: "MetricKit hang diagnostic: window=%ds duration=%.2fs",
                    summary.windowSeconds,
                    hang.durationSeconds
                )
            )
        }

        for cpu in summary.cpuExceptions {
            log.error(
                String(
                    format: "MetricKit CPU exception diagnostic: window=%ds cpuTime=%.2fs sampledTime=%.2fs",
                    summary.windowSeconds,
                    cpu.totalCPUTimeSeconds,
                    cpu.totalSampledTimeSeconds
                )
            )
        }

        for disk in summary.diskWriteExceptions {
            log.error(
                String(
                    format: "MetricKit disk-write exception diagnostic: window=%ds writes=%.2fMB",
                    summary.windowSeconds,
                    disk.totalWritesMB
                )
            )
        }
    }
}

#if canImport(MetricKit)
nonisolated extension MetricKitDiagnostics: MXMetricManagerSubscriber {
    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            record(metricSummary: Self.summarize(payload))
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            record(diagnosticSummary: Self.summarize(payload))
        }
    }

    private static func summarize(_ payload: MXMetricPayload) -> MetricSummary {
        let windowSeconds = max(0, Int(payload.timeStampEnd.timeIntervalSince(payload.timeStampBegin)))
        let cpuSeconds = payload.cpuMetrics?.cumulativeCPUTime.converted(to: .seconds).value
        let diskMB = payload.diskIOMetrics?.cumulativeLogicalWrites.converted(to: .megabytes).value
        let firstDrawBuckets = payload.applicationLaunchMetrics?.histogrammedTimeToFirstDraw.totalBucketCount ?? 0
        let resumeBuckets = payload.applicationLaunchMetrics?.histogrammedApplicationResumeTime.totalBucketCount ?? 0
        let hangBuckets = payload.applicationResponsivenessMetrics?.histogrammedApplicationHangTime.totalBucketCount ?? 0

        let fg = payload.applicationExitMetrics?.foregroundExitData
        let fgAbnormal = (fg?.cumulativeAbnormalExitCount ?? 0)
            + (fg?.cumulativeBadAccessExitCount ?? 0)
            + (fg?.cumulativeIllegalInstructionExitCount ?? 0)
            + (fg?.cumulativeMemoryResourceLimitExitCount ?? 0)
            + (fg?.cumulativeAppWatchdogExitCount ?? 0)

        let bg = payload.applicationExitMetrics?.backgroundExitData
        let bgAbnormal = (bg?.cumulativeAbnormalExitCount ?? 0)
            + (bg?.cumulativeBadAccessExitCount ?? 0)
            + (bg?.cumulativeIllegalInstructionExitCount ?? 0)
            + (bg?.cumulativeMemoryResourceLimitExitCount ?? 0)
            + (bg?.cumulativeCPUResourceLimitExitCount ?? 0)
            + (bg?.cumulativeAppWatchdogExitCount ?? 0)

        return MetricSummary(
            windowSeconds: windowSeconds,
            cumulativeCPUTimeSeconds: cpuSeconds,
            cumulativeLogicalWritesMB: diskMB,
            launchTimeToFirstDrawBuckets: firstDrawBuckets,
            launchResumeBuckets: resumeBuckets,
            hangTimeBuckets: hangBuckets,
            foregroundAbnormalExits: fgAbnormal,
            backgroundAbnormalExits: bgAbnormal
        )
    }

    private static func summarize(_ payload: MXDiagnosticPayload) -> DiagnosticSummary {
        let windowSeconds = max(0, Int(payload.timeStampEnd.timeIntervalSince(payload.timeStampBegin)))

        let crashes = (payload.crashDiagnostics ?? []).map { crash in
            DiagnosticSummary.CrashItem(
                signal: crash.signal?.intValue,
                exceptionType: crash.exceptionType?.intValue,
                exceptionCode: crash.exceptionCode?.intValue,
                terminationReason: crash.terminationReason
            )
        }

        let hangs = (payload.hangDiagnostics ?? []).map { hang in
            DiagnosticSummary.HangItem(
                durationSeconds: hang.hangDuration.converted(to: .seconds).value
            )
        }

        let cpuExceptions = (payload.cpuExceptionDiagnostics ?? []).map { cpu in
            DiagnosticSummary.CPUExceptionItem(
                totalCPUTimeSeconds: cpu.totalCPUTime.converted(to: .seconds).value,
                totalSampledTimeSeconds: cpu.totalSampledTime.converted(to: .seconds).value
            )
        }

        let diskExceptions = (payload.diskWriteExceptionDiagnostics ?? []).map { disk in
            DiagnosticSummary.DiskWriteExceptionItem(
                totalWritesMB: disk.totalWritesCaused.converted(to: .megabytes).value
            )
        }

        return DiagnosticSummary(
            windowSeconds: windowSeconds,
            crashes: crashes,
            hangs: hangs,
            cpuExceptions: cpuExceptions,
            diskWriteExceptions: diskExceptions
        )
    }
}
#endif
