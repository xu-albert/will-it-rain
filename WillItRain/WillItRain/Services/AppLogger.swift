import Foundation
import OSLog

/// Lightweight structured logger backed by Apple's `os.Logger`.
///
/// Privacy invariant: raw APNs device tokens, Live Activity push tokens, bearer
/// JWTs, and high-precision latitude/longitude pairs are scrubbed before writing
/// to `os.Logger`.
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

    static let defaultSubsystem = Bundle.main.bundleIdentifier ?? "com.willitrain.WillItRain"
    static let shared = AppLogger()

    static var push: CategoryLogger { shared.category(.push) }
    static var activity: CategoryLogger { shared.category(.activity) }
    static var weather: CategoryLogger { shared.category(.weather) }
    static var notifications: CategoryLogger { shared.category(.notifications) }
    static var background: CategoryLogger { shared.category(.background) }
    static var metrics: CategoryLogger { shared.category(.metrics) }

    let subsystem: String

    private let loggers: [Category: Logger]
    private let sink: (@Sendable (Entry) -> Void)?

    init(
        subsystem: String = AppLogger.defaultSubsystem,
        sink: (@Sendable (Entry) -> Void)? = nil
    ) {
        self.subsystem = subsystem
        self.sink = sink
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
        sink?(Entry(category: category, level: level, message: sanitized))

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
