import XCTest
@testable import WillItRain

/// `NotificationSettings` is the alert gate's memory across polls and launches.
/// These pin that every value survives a round trip through UserDefaults under
/// its existing key and format, and how the quiet-hours window is read.
final class NotificationSettingsTests: XCTestCase {

    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "NotificationSettingsTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testDefaultsForAFreshInstall() {
        let settings = NotificationSettings(defaults: defaults)
        XCTAssertEqual(settings.leadTime, 20)
        XCTAssertFalse(settings.quietHoursEnabled)
        XCTAssertTrue(settings.rainStartEnabled)
        XCTAssertTrue(settings.rainEndEnabled)
        XCTAssertEqual(settings.chartHours, 12)
        XCTAssertFalse(settings.useCelsius)
        XCTAssertNil(settings.lastNotifiedPrecipStart)
        XCTAssertNil(settings.lastNotifiedPrecipEnd)
        XCTAssertNil(settings.pendingPrecipStart)
        XCTAssertNil(settings.pendingPrecipEnd)
        XCTAssertNil(settings.lastRainEndTime)

        let calendar = Calendar.current
        XCTAssertEqual(calendar.component(.hour, from: settings.quietHoursStart), 22)
        XCTAssertEqual(calendar.component(.hour, from: settings.quietHoursEnd), 7)
    }

    func testEveryValueSurvivesARelaunch() {
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        let first = NotificationSettings(defaults: defaults)
        first.leadTime = 30
        first.quietHoursEnabled = true
        first.rainStartEnabled = false
        first.rainEndEnabled = false
        first.chartHours = 6
        first.useCelsius = true
        first.quietHoursStart = stamp
        first.quietHoursEnd = stamp.addingTimeInterval(3600)
        first.lastNotifiedPrecipStart = stamp.addingTimeInterval(60)
        first.lastNotifiedPrecipEnd = stamp.addingTimeInterval(120)
        first.pendingPrecipStart = stamp.addingTimeInterval(180)
        first.pendingPrecipEnd = stamp.addingTimeInterval(240)
        first.lastRainEndTime = stamp.addingTimeInterval(300)

        let second = NotificationSettings(defaults: defaults)
        XCTAssertEqual(second.leadTime, 30)
        XCTAssertTrue(second.quietHoursEnabled)
        XCTAssertFalse(second.rainStartEnabled)
        XCTAssertFalse(second.rainEndEnabled)
        XCTAssertEqual(second.chartHours, 6)
        XCTAssertTrue(second.useCelsius)
        XCTAssertEqual(second.quietHoursStart, stamp)
        XCTAssertEqual(second.quietHoursEnd, stamp.addingTimeInterval(3600))
        XCTAssertEqual(second.lastNotifiedPrecipStart, stamp.addingTimeInterval(60))
        XCTAssertEqual(second.lastNotifiedPrecipEnd, stamp.addingTimeInterval(120))
        XCTAssertEqual(second.pendingPrecipStart, stamp.addingTimeInterval(180))
        XCTAssertEqual(second.pendingPrecipEnd, stamp.addingTimeInterval(240))
        XCTAssertEqual(second.lastRainEndTime, stamp.addingTimeInterval(300))
    }

    func testDatesAreStoredUnderTheirExistingKeysAsReferenceSeconds() {
        // Installed devices already hold these keys in this format; a relaunch
        // after an update must read them back unchanged.
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        let settings = NotificationSettings(defaults: defaults)
        XCTAssertNil(defaults.object(forKey: "quietHoursStart"),
                     "Built-in defaults are not written until the user changes them")
        settings.pendingPrecipStart = stamp
        settings.lastRainEndTime = stamp
        settings.quietHoursStart = stamp

        XCTAssertEqual(defaults.double(forKey: "pendingPrecipStart"), stamp.timeIntervalSinceReferenceDate)
        XCTAssertEqual(defaults.double(forKey: "lastRainEndTime"), stamp.timeIntervalSinceReferenceDate)
        XCTAssertEqual(defaults.double(forKey: "quietHoursStart"), stamp.timeIntervalSinceReferenceDate)
    }

    func testClearingADateRemovesItsKey() {
        let settings = NotificationSettings(defaults: defaults)
        settings.pendingPrecipStart = Date()
        XCTAssertNotNil(defaults.object(forKey: "pendingPrecipStart"))

        settings.pendingPrecipStart = nil
        XCTAssertNil(defaults.object(forKey: "pendingPrecipStart"),
                     "A cleared date must not read back as the reference date")
        XCTAssertNil(NotificationSettings(defaults: defaults).pendingPrecipStart)
    }

    func testIsSameEventIsWithinTenMinutes() {
        let settings = NotificationSettings(defaults: defaults)
        let a = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertTrue(settings.isSameEvent(a, a.addingTimeInterval(9 * 60 + 59)))
        XCTAssertTrue(settings.isSameEvent(a.addingTimeInterval(9 * 60 + 59), a))
        XCTAssertFalse(settings.isSameEvent(a, a.addingTimeInterval(10 * 60)))
        XCTAssertFalse(settings.isSameEvent(nil, a))
        XCTAssertFalse(settings.isSameEvent(a, nil))
    }

    func testQuietHoursWrapPastMidnight() {
        let calendar = Calendar.current
        let settings = NotificationSettings(defaults: defaults)
        settings.quietHoursEnabled = true
        settings.quietHoursStart = calendar.date(from: DateComponents(hour: 22, minute: 0))!
        settings.quietHoursEnd = calendar.date(from: DateComponents(hour: 7, minute: 0))!

        func at(_ hour: Int, _ minute: Int = 0) -> Date {
            calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date())!
        }

        XCTAssertTrue(settings.isInQuietHours(at: at(22)))
        XCTAssertTrue(settings.isInQuietHours(at: at(23, 30)))
        XCTAssertTrue(settings.isInQuietHours(at: at(3)))
        XCTAssertTrue(settings.isInQuietHours(at: at(6, 59)))
        XCTAssertFalse(settings.isInQuietHours(at: at(7)))
        XCTAssertFalse(settings.isInQuietHours(at: at(12)))
        XCTAssertFalse(settings.isInQuietHours(at: at(21, 59)))
    }

    func testQuietHoursWithinOneDay() {
        let calendar = Calendar.current
        let settings = NotificationSettings(defaults: defaults)
        settings.quietHoursEnabled = true
        settings.quietHoursStart = calendar.date(from: DateComponents(hour: 9, minute: 0))!
        settings.quietHoursEnd = calendar.date(from: DateComponents(hour: 17, minute: 0))!

        func at(_ hour: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: 0, second: 0, of: Date())!
        }

        XCTAssertTrue(settings.isInQuietHours(at: at(9)))
        XCTAssertTrue(settings.isInQuietHours(at: at(12)))
        XCTAssertFalse(settings.isInQuietHours(at: at(17)))
        XCTAssertFalse(settings.isInQuietHours(at: at(3)))
    }

    func testQuietHoursAreIgnoredWhenDisabled() {
        let calendar = Calendar.current
        let settings = NotificationSettings(defaults: defaults)
        settings.quietHoursEnabled = false
        XCTAssertFalse(settings.isInQuietHours(at: calendar.date(bySettingHour: 23, minute: 0, second: 0, of: Date())!))
    }
}
