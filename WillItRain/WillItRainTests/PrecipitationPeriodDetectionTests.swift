import XCTest
@testable import WillItRain

/// `PrecipitationPeriod.detect(in:)` is the seam every downstream reading — hero
/// status, alert gate, Live Activity, poll interval — is derived from. These pin
/// what counts as wet and how a stretch of wet points becomes one period.
final class PrecipitationPeriodDetectionTests: XCTestCase {

    private let base = Date(timeIntervalSince1970: 1_700_000_000)

    private func at(_ minute: Int) -> Date {
        base.addingTimeInterval(TimeInterval(minute * 60))
    }

    private func point(
        _ minute: Int,
        probability: Double = 0,
        intensity: PrecipitationIntensity = .none,
        type: PrecipitationType = .none
    ) -> ChartDataPoint {
        ChartDataPoint(
            date: at(minute),
            probability: probability,
            intensity: intensity,
            type: type,
            precipitationAmount: intensity.numericValue
        )
    }

    func testDrySeriesHasNoPeriods() {
        let points = (0..<6).map { point($0, probability: 0.2) }
        XCTAssertTrue(PrecipitationPeriod.detect(in: points).isEmpty)
    }

    func testOneWetStretchBecomesOnePeriodEndingAtTheFirstDryPoint() {
        let points = [
            point(0),
            point(10, probability: 0.8, intensity: .light, type: .rain),
            point(20, probability: 0.8, intensity: .moderate, type: .rain),
            point(30),
            point(40),
        ]
        let periods = PrecipitationPeriod.detect(in: points)

        XCTAssertEqual(periods.count, 1)
        XCTAssertEqual(periods.first?.start, at(10))
        XCTAssertEqual(periods.first?.end, at(30))
        XCTAssertEqual(periods.first?.type, .rain)
    }

    func testPeakIntensityIsTheStrongestReadingInTheStretch() {
        let points = [
            point(0, intensity: .light, type: .rain),
            point(10, intensity: .heavy, type: .rain),
            point(20, intensity: .moderate, type: .rain),
            point(30),
        ]
        XCTAssertEqual(PrecipitationPeriod.detect(in: points).first?.peakIntensity, .heavy)
    }

    func testLikelyRainWithNoPredictedAmountStillCountsAsLightRain() {
        // The "says nothing's happening when it's going to rain" bug: WeatherKit
        // reported a high chance but an amount that rounded to nothing.
        let points = [
            point(0, probability: 0.5),
            point(10, probability: 0.7),
            point(20, probability: 0.1),
        ]
        let periods = PrecipitationPeriod.detect(in: points)

        XCTAssertEqual(periods.count, 1)
        XCTAssertEqual(periods.first?.start, at(0))
        XCTAssertEqual(periods.first?.end, at(20))
        XCTAssertEqual(periods.first?.type, .rain, "A wet point with no type is called rain")
        XCTAssertEqual(periods.first?.peakIntensity, .light)
    }

    func testAMarginalChanceWithNoAmountIsDry() {
        let points = [point(0, probability: 0.49), point(10, probability: 0.3)]
        XCTAssertTrue(PrecipitationPeriod.detect(in: points).isEmpty)
    }

    func testAPredictedAmountCountsEvenWhenTheChanceIsLow() {
        let points = [point(0, probability: 0.1, intensity: .light, type: .rain), point(10)]
        XCTAssertEqual(PrecipitationPeriod.detect(in: points).count, 1)
    }

    func testRainThatOutlastsTheDataClosesAtTheLastPoint() {
        let points = [
            point(0),
            point(10, intensity: .light, type: .rain),
            point(20, intensity: .light, type: .rain),
        ]
        let periods = PrecipitationPeriod.detect(in: points)

        XCTAssertEqual(periods.count, 1)
        XCTAssertEqual(periods.first?.end, at(20))
    }

    func testSeparateStretchesBecomeSeparatePeriods() {
        let points = [
            point(0, intensity: .light, type: .rain),
            point(10),
            point(20, intensity: .light, type: .snow),
            point(30, intensity: .moderate, type: .snow),
            point(40),
        ]
        let periods = PrecipitationPeriod.detect(in: points)

        XCTAssertEqual(periods.count, 2)
        XCTAssertEqual(periods[0].start, at(0))
        XCTAssertEqual(periods[0].end, at(10))
        XCTAssertEqual(periods[0].type, .rain)
        XCTAssertEqual(periods[1].start, at(20))
        XCTAssertEqual(periods[1].end, at(40))
        XCTAssertEqual(periods[1].type, .snow)
        XCTAssertEqual(periods[1].peakIntensity, .moderate,
                       "Peak intensity is reset between periods")
    }

    func testAPeriodKeepsTheTypeOfItsFirstWetPoint() {
        let points = [
            point(0, intensity: .light, type: .rain),
            point(10, intensity: .heavy, type: .snow),
            point(20),
        ]
        XCTAssertEqual(PrecipitationPeriod.detect(in: points).first?.type, .rain)
    }
}
