import Foundation
import OSLog

/// Lightweight structured logger backed by Apple's `os.Logger` plus a bounded,
/// thread-safe in-memory ring buffer of sanitized entries.
///
/// Privacy invariant: raw APNs device tokens, Live Activity push tokens, bearer
/// JWTs, and high-precision latitude/longitude pairs are scrubbed before writing
/// to either `os.Logger` or the ring buffer.
nonisolated final class AppLogger: @unchecked Sendable {
    enum Category: String, CaseIterable, Sendable {
        case push
        case activity
        case weather
        case notifications
        case background
        case metrics
    }

    enum Level: String, Sendable {
        case debug
        case info
        case warning
        case error
    }

    struct Entry: Equatable, Sendable {
        let timestamp: Date
        let category: Category
        let level: Level
        let message: String
    }

    struct CategoryLogger: Sendable {
        private let parent: AppLogger
        let category: Category

        fileprivate init(parent: AppLogger, category: Category) {
            self.parent = parent
            self.category = category
        }

        func debug(_ message: String) {
            parent.log(category: category, level: .debug, message)
        }

        func info(_ message: String) {
            parent.log(category: category, level: .info, message)
        }

        func warning(_ message: String) {
            parent.log(category: category, level: .warning, message)
        }

        func error(_ message: String) {
            parent.log(category: category, level: .error, message)
        }
    }

    static let defaultCapacity = 150
    static let defaultSubsystem = Bundle.main.bundleIdentifier ?? "com.willitrain.WillItRain"
    static let shared = AppLogger()

    static var push: CategoryLogger { shared.category(.push) }
    static var activity: CategoryLogger { shared.category(.activity) }
    static var weather: CategoryLogger { shared.category(.weather) }
    static var notifications: CategoryLogger { shared.category(.notifications) }
    static var background: CategoryLogger { shared.category(.background) }
    static var metrics: CategoryLogger { shared.category(.metrics) }

    let subsystem: String
    let capacity: Int

    private let now: @Sendable () -> Date
    private let loggers: [Category: Logger]
    private let lock = NSLock()
    private var ringBuffer: [Entry] = []

    init(
        subsystem: String = AppLogger.defaultSubsystem,
        capacity: Int = AppLogger.defaultCapacity,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.subsystem = subsystem
        self.capacity = max(1, capacity)
        self.now = now
        var built: [Category: Logger] = [:]
        for category in Category.allCases {
            built[category] = Logger(subsystem: subsystem, category: category.rawValue)
        }
        self.loggers = built
    }

    func category(_ category: Category) -> CategoryLogger {
        CategoryLogger(parent: self, category: category)
    }

    func log(category: Category, level: Level, _ message: String) {
        let sanitized = Self.sanitize(message)
        let entry = Entry(
            timestamp: now(),
            category: category,
            level: level,
            message: sanitized
        )

        lock.lock()
        if ringBuffer.count >= capacity {
            ringBuffer.removeFirst(ringBuffer.count - capacity + 1)
        }
        ringBuffer.append(entry)
        lock.unlock()

        guard let osLogger = loggers[category] else { return }
        switch level {
        case .debug:
            osLogger.debug("\(sanitized, privacy: .public)")
        case .info:
            osLogger.info("\(sanitized, privacy: .public)")
        case .warning:
            osLogger.warning("\(sanitized, privacy: .public)")
        case .error:
            osLogger.error("\(sanitized, privacy: .public)")
        }
    }

    /// Returns stored entries in chronological order, optionally filtered by category.
    func recentEntries(category: Category? = nil) -> [Entry] {
        lock.lock()
        let snapshot = ringBuffer
        lock.unlock()
        guard let category else { return snapshot }
        return snapshot.filter { $0.category == category }
    }

    /// Human-readable newline-delimited dump for debug inspection and sysdiagnose capture.
    func formattedDump(category: Category? = nil) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return recentEntries(category: category)
            .map { entry in
                "[\(formatter.string(from: entry.timestamp))] [\(entry.level.rawValue.uppercased())] [\(entry.category.rawValue)] \(entry.message)"
            }
            .joined(separator: "\n")
    }

    func clear() {
        lock.lock()
        ringBuffer.removeAll()
        lock.unlock()
    }

    // MARK: - Privacy sanitization

    private static let apnsDevicePathRegex = try! NSRegularExpression(
        pattern: #"/3/device/[^\s"'/?]+"#
    )
    private static let bearerJWTRegex = try! NSRegularExpression(
        pattern: #"\bBearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"#,
        options: [.caseInsensitive]
    )
    private static let longHexTokenRegex = try! NSRegularExpression(
        pattern: #"\b[0-9a-fA-F]{64,}\b"#
    )
    private static let labeledCoordinateRegex = try! NSRegularExpression(
        pattern: #"\b(lat|lon|lng|latitude|longitude)\s*[:=]\s*-?\d+\.\d{3,}\b"#,
        options: [.caseInsensitive]
    )

    static func sanitize(_ raw: String) -> String {
        var result = raw
        result = replace(apnsDevicePathRegex, in: result, with: "/3/device/[redacted]")
        result = replace(bearerJWTRegex, in: result, with: "Bearer [redacted]")
        result = replace(longHexTokenRegex, in: result, with: "[redacted-token]")
        result = replace(labeledCoordinateRegex, in: result, with: "$1=[redacted-coord]")
        return result
    }

    private static func replace(
        _ regex: NSRegularExpression,
        in text: String,
        with template: String
    ) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }
}
