import XCTest
@testable import WillItRain

/// `LiveActivityService.makeState` is pure over its inputs, so the content
/// state the app pushes into an activity can be pinned without ActivityKit.
/// What matters most here is `precip`: it is what the widget styles from, and
/// a period type that resolves to the wrong value draws a cyan track through a
/// snowstorm.
final class LiveActivityServiceTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func minutes(_ m: Int) -> Date {
        now.addingTimeInterval(TimeInterval(m * 60))
    }

    private func period(from start: Int, to end: Int, type: PrecipitationType) -> PrecipitationPeriod {
        PrecipitationPeriod(start: minutes(start), end: minutes(end), type: type, peakIntensity: .moderate)
    }

    private func forecast(periods: [PrecipitationPeriod]) -> RainForecast {
        let points = stride(from: 0, through: 4 * 60, by: 60).map { m in
            ChartDataPoint(date: minutes(m), probability: 0, intensity: .none, type: .none, precipitationAmount: 0)
        }
        return RainForecast(
            dataPoints: points,
            precipitationPeriods: periods,
            dailySummaries: [],
            currentCondition: .clear,
            currentType: periods.first { $0.contains(now) }?.type ?? .none,
            locationName: "Testville",
            fetchedAt: now
        )
    }

    private func state(periods: [PrecipitationPeriod]) throws -> RainActivityAttributes.ContentState {
        let sorted = periods.sorted { $0.start < $1.start }
        return try XCTUnwrap(
            LiveActivityService().makeState(
                now: now,
                periods: sorted,
                current: sorted.first { $0.contains(now) },
                forecast: forecast(periods: sorted)
            )
        )
    }

    // MARK: - State A: approaching

    func testApproachingRainIsRain() throws {
        let s = try state(periods: [period(from: 20, to: 50, type: .rain)])
        XCTAssertEqual(s.precip, .rain)
        XCTAssertEqual(s.statusText, "Rain incoming")
    }

    func testApproachingSnowIsWintry() throws {
        let s = try state(periods: [period(from: 20, to: 50, type: .snow)])
        XCTAssertEqual(s.precip, .wintry)
        XCTAssertEqual(s.statusText, "Snow incoming")
    }

    func testEveryIcyTypeIsWintryAndRainIsNot() throws {
        for type in [PrecipitationType.snow, .sleet, .hail, .mixed] {
            XCTAssertEqual(try state(periods: [period(from: 20, to: 50, type: type)]).precip, .wintry,
                           "\(type) should draw the wintry treatment")
        }
        XCTAssertEqual(try state(periods: [period(from: 20, to: 50, type: .rain)]).precip, .rain)
    }

    func testApproachingMixedReadsAsWintryMix() throws {
        let s = try state(periods: [period(from: 20, to: 50, type: .mixed)])
        XCTAssertEqual(s.statusText, "Wintry mix incoming")
        XCTAssertEqual(s.subBold, "Moderate wintry mix")
    }

    // MARK: - State B: falling now

    func testFallingSnowIsWintry() throws {
        let s = try state(periods: [period(from: -10, to: 30, type: .snow)])
        XCTAssertEqual(s.precip, .wintry)
        XCTAssertEqual(s.statusText, "Snowing now")
        XCTAssertEqual(s.subRest, "Snowing · ")
    }

    func testFallingMixedReadsAsWintryMix() throws {
        let s = try state(periods: [period(from: -10, to: 30, type: .mixed)])
        XCTAssertEqual(s.precip, .wintry)
        XCTAssertEqual(s.statusText, "Wintry mix now")
        XCTAssertEqual(s.subRest, "Wintry mix · ")
    }

    // MARK: - State C: intermittent

    func testIntermittentBurstsTakeTheirTypeFromTheNextBurst() throws {
        let snow = try state(periods: [period(from: 15, to: 25, type: .snow), period(from: 60, to: 80, type: .snow)])
        XCTAssertEqual(snow.precip, .wintry)
        XCTAssertEqual(snow.heroText, "Flurries")

        let sleet = try state(periods: [period(from: 15, to: 25, type: .sleet), period(from: 60, to: 80, type: .sleet)])
        XCTAssertEqual(sleet.precip, .wintry)
        XCTAssertEqual(sleet.heroText, "Wintry mix")

        let rain = try state(periods: [period(from: 15, to: 25, type: .rain), period(from: 60, to: 80, type: .rain)])
        XCTAssertEqual(rain.precip, .rain)
        XCTAssertEqual(rain.heroText, "Showers")
    }

    /// The app never sends a state without `precip`; only a pre-1.1.2 Worker does.
    func testEveryStateTheAppBuildsCarriesPrecip() throws {
        let states = [
            try state(periods: [period(from: 20, to: 50, type: .rain)]),
            try state(periods: [period(from: -10, to: 30, type: .rain)]),
            try state(periods: [period(from: 15, to: 25, type: .rain), period(from: 60, to: 80, type: .rain)]),
        ]
        XCTAssertTrue(states.allSatisfy { $0.precip != nil })
    }
}
