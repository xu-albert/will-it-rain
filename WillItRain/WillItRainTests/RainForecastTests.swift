import XCTest
@testable import WillItRain

/// Smoke tests over pure forecast-model logic.
final class RainForecastTests: XCTestCase {

    func testIntensityFromMillimetersPerHour() {
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 0), .none)
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 0.09), .none)
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 0.1), .light)
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 2.5), .moderate)
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 7.5), .heavy)
        XCTAssertEqual(PrecipitationIntensity.from(millimetersPerHour: 100), .heavy)
    }

    func testIntensityOrdering() {
        XCTAssertLessThan(PrecipitationIntensity.none, .light)
        XCTAssertLessThan(PrecipitationIntensity.light, .moderate)
        XCTAssertLessThan(PrecipitationIntensity.moderate, .heavy)
        XCTAssertEqual([PrecipitationIntensity.heavy, .none, .moderate, .light].sorted(),
                       [.none, .light, .moderate, .heavy])
    }

    func testPrecipitationPeriodContains() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let end = start.addingTimeInterval(3600)
        let period = PrecipitationPeriod(start: start, end: end, type: .rain, peakIntensity: .moderate)

        XCTAssertTrue(period.contains(start))
        XCTAssertTrue(period.contains(start.addingTimeInterval(1800)))
        XCTAssertTrue(period.contains(end))
        XCTAssertFalse(period.contains(start.addingTimeInterval(-1)))
        XCTAssertFalse(period.contains(end.addingTimeInterval(1)))
    }

    func testPrecipitationTypeIcons() {
        XCTAssertEqual(PrecipitationType.rain.icon, "cloud.rain.fill")
        XCTAssertEqual(PrecipitationType.none.icon, "sun.max.fill")
    }
}
