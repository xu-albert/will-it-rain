import XCTest
@testable import WillItRain

/// Tests over pure forecast-model logic. The time-dependent readings are all
/// evaluated at an explicit instant, so nothing here depends on the wall clock.
final class RainForecastTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func minutes(_ m: Int) -> Date {
        now.addingTimeInterval(TimeInterval(m * 60))
    }

    private func period(
        from start: Int,
        to end: Int,
        type: PrecipitationType = .rain,
        peak: PrecipitationIntensity = .moderate
    ) -> PrecipitationPeriod {
        PrecipitationPeriod(start: minutes(start), end: minutes(end), type: type, peakIntensity: peak)
    }

    /// A forecast whose data points span `hoursOfData` hours from `now`.
    private func forecast(
        periods: [PrecipitationPeriod],
        hoursOfData: Int = 12,
        condition: WeatherCondition = .clear
    ) -> RainForecast {
        let points = stride(from: 0, through: hoursOfData * 60, by: 60).map { m in
            ChartDataPoint(date: minutes(m), probability: 0, intensity: .none, type: .none, precipitationAmount: 0)
        }
        return RainForecast(
            dataPoints: points,
            precipitationPeriods: periods,
            dailySummaries: [],
            currentCondition: condition,
            currentType: periods.first { $0.contains(now) }?.type ?? .none,
            locationName: "Testville",
            fetchedAt: now
        )
    }

    // MARK: - Model primitives

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

    func testMixedPrecipitationIsWintryAndHasItsOwnCopy() {
        // WeatherKit's `.mixed` used to fall into the rain default. It is ice,
        // so it takes the wintry Live Activity treatment and says so.
        XCTAssertTrue(PrecipitationType.mixed.isWintry)
        XCTAssertEqual(PrecipitationType.mixed.icon, "cloud.sleet.fill")
        for type in [PrecipitationType.snow, .sleet, .hail] {
            XCTAssertTrue(type.isWintry, "\(type) should be wintry")
        }
        XCTAssertFalse(PrecipitationType.rain.isWintry)
        XCTAssertFalse(PrecipitationType.none.isWintry)

        let fallingNow = forecast(periods: [period(from: -10, to: 20, type: .mixed)])
        XCTAssertEqual(fallingNow.heroStatus(for: .clear, at: now).title, "Wintry mix")

        let coming = forecast(periods: [period(from: 30, to: 60, type: .mixed)])
        XCTAssertEqual(coming.heroStatus(for: .clear, at: now).title, "Wintry mix in 30 min")
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

    // MARK: - Current / next period

    func testCurrentAndNextPeriodAreReadAtTheGivenInstant() {
        let f = forecast(periods: [period(from: -10, to: 20), period(from: 60, to: 90)])

        XCTAssertTrue(f.isPrecipitating(at: now))
        XCTAssertEqual(f.currentPrecipitationPeriod(at: now)?.start, minutes(-10))
        XCTAssertEqual(f.nextPrecipitationPeriod(at: now)?.start, minutes(60))

        // Half an hour on, the first period is over and the second is still ahead.
        XCTAssertFalse(f.isPrecipitating(at: minutes(30)))
        XCTAssertNil(f.currentPrecipitationPeriod(at: minutes(30)))
        XCTAssertEqual(f.nextPrecipitationPeriod(at: minutes(30))?.start, minutes(60))

        // Inside the second period nothing further is "next".
        XCTAssertEqual(f.currentPrecipitationPeriod(at: minutes(70))?.start, minutes(60))
        XCTAssertNil(f.nextPrecipitationPeriod(at: minutes(70)))
    }

    func testAPeriodStartingExactlyNowIsCurrentNotNext() {
        let f = forecast(periods: [period(from: 0, to: 30)])
        XCTAssertNotNil(f.currentPrecipitationPeriod(at: now))
        XCTAssertNil(f.nextPrecipitationPeriod(at: now))
    }

    // MARK: - Hero status

    func testHeroStatusWhileRaining() {
        let f = forecast(periods: [period(from: -10, to: 25)])
        let status = f.heroStatus(for: .clear, at: now)
        XCTAssertEqual(status.title, "Raining")
        XCTAssertEqual(status.subtitle, "Stops in 25 min")
    }

    func testHeroStatusWhileSnowingUsesTheSnowVerb() {
        let f = forecast(periods: [period(from: -10, to: 90, type: .snow)])
        let status = f.heroStatus(for: .clear, at: now)
        XCTAssertEqual(status.title, "Snowing")
        XCTAssertEqual(status.subtitle, "Stops in 1h 30m")
    }

    func testHeroStatusBeforeRainCountsDownAndGivesTheDuration() {
        let f = forecast(periods: [period(from: 40, to: 160)])
        let status = f.heroStatus(for: .cloudy, at: now)
        XCTAssertEqual(status.title, "Rains in 40 min")
        XCTAssertEqual(status.subtitle, "Will last 2h")
    }

    func testHeroStatusWithNoRainDescribesTheDryHorizon() {
        let twelveHours = forecast(periods: [], hoursOfData: 12)
        XCTAssertEqual(twelveHours.heroStatus(for: .clear, at: now).title, "Clear")
        XCTAssertEqual(twelveHours.heroStatus(for: .cloudy, at: now).title, "Cloudy")
        XCTAssertEqual(twelveHours.heroStatus(for: .clear, at: now).subtitle, "Chance of rain within 48 hours")

        let threeDays = forecast(periods: [], hoursOfData: 72)
        XCTAssertEqual(threeDays.heroStatus(for: .clear, at: now).subtitle, "No rain for the next 3 days")

        let week = forecast(periods: [], hoursOfData: 7 * 24)
        XCTAssertEqual(week.heroStatus(for: .clear, at: now).subtitle, "No rain expected this week")
    }

    func testHeroStatusIgnoresConditionWhileRaining() {
        // The weather condition only chooses between "Clear" and "Cloudy" for a dry
        // sky; rain in progress always wins the title.
        let f = forecast(periods: [period(from: -10, to: 25)])
        XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).title, "Raining")
    }

    // MARK: - Adaptive poll interval

    func testPollIntervalTightensAsTheRainEndApproaches() {
        XCTAssertEqual(forecast(periods: [period(from: -30, to: 5)]).nextPollInterval(at: now), 2 * 60)
        XCTAssertEqual(forecast(periods: [period(from: -30, to: 10)]).nextPollInterval(at: now), 2 * 60)
        XCTAssertEqual(forecast(periods: [period(from: -30, to: 30)]).nextPollInterval(at: now), 5 * 60)
        XCTAssertEqual(forecast(periods: [period(from: -30, to: 60)]).nextPollInterval(at: now), 15 * 60)
    }

    func testPollIntervalTightensAsTheRainStartApproaches() {
        // Inside lead time + 20 minutes: poll every five minutes so the two-pass
        // alert confirmation can actually complete before the rain.
        let soon = forecast(periods: [period(from: 40, to: 60)])
        XCTAssertEqual(soon.nextPollInterval(leadTimeMinutes: 20, at: now), 5 * 60)
        XCTAssertEqual(soon.nextPollInterval(leadTimeMinutes: 10, at: now), 30 * 60,
                       "A shorter lead time means the same rain is not yet urgent")

        XCTAssertEqual(forecast(periods: [period(from: 3 * 60, to: 4 * 60)]).nextPollInterval(at: now), 30 * 60)
        XCTAssertEqual(forecast(periods: [period(from: 8 * 60, to: 9 * 60)]).nextPollInterval(at: now), 60 * 60)
    }

    func testPollIntervalRelaxesWhenNothingIsComing() {
        XCTAssertEqual(forecast(periods: []).nextPollInterval(at: now), 60 * 60)
    }
}
