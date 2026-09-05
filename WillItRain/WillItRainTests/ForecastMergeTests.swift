import XCTest
@testable import WillItRain

/// The seam between WeatherKit's minute forecast and its hourly one. Every
/// series is built at an explicit instant, so nothing here reads the clock.
///
/// The bug these guard (edge-case report, finding 10): a hard cut at now + 1h
/// dropped the hourly reading for the hour the minute data ends in, and with no
/// minute forecast at all left nothing for the next hour — so the app was never
/// "raining" and no rain-start alert could ever fire.
final class ForecastMergeTests: XCTestCase {

    /// 22:00:00 UTC on a fixed day; every hourly reading is on the hour from here.
    private let hour0 = Date(timeIntervalSince1970: 1_699_999_200)

    private func hour(_ h: Int) -> Date { hour0.addingTimeInterval(TimeInterval(h) * 3600) }
    private func minute(_ m: Int, from base: Date) -> Date { base.addingTimeInterval(TimeInterval(m) * 60) }

    private func hourly(wet: Set<Int> = [], hours: Range<Int> = 0..<12) -> [ChartDataPoint] {
        hours.map { h in
            ChartDataPoint(
                date: hour(h),
                probability: wet.contains(h) ? 0.7 : 0.1,
                intensity: wet.contains(h) ? .light : .none,
                type: wet.contains(h) ? .rain : .none,
                precipitationAmount: wet.contains(h) ? 1.0 : 0,
                resolution: .hour
            )
        }
    }

    /// Sixty dry minute readings from `now`, the shape WeatherKit returns.
    private func minutes(from now: Date, wet: Set<Int> = []) -> [ChartDataPoint] {
        (0..<60).map { m in
            ChartDataPoint(
                date: minute(m, from: now),
                probability: wet.contains(m) ? 0.8 : 0.05,
                intensity: wet.contains(m) ? .moderate : .none,
                type: wet.contains(m) ? .rain : .none,
                precipitationAmount: wet.contains(m) ? 3.0 : 0
            )
        }
    }

    private func forecast(from result: ForecastMerge.Result, at now: Date) -> RainForecast {
        let periods = PrecipitationPeriod.detect(in: result.dataPoints)
        return RainForecast(
            dataPoints: result.dataPoints,
            precipitationPeriods: periods,
            dailySummaries: [],
            currentCondition: .clear,
            currentType: periods.first { $0.contains(now) }?.type ?? .none,
            locationName: "Testville",
            fetchedAt: now,
            hasMinuteForecast: result.hasMinuteForecast
        )
    }

    // MARK: - With minute data: the seam

    func testTheHourlyReadingContainingNowPlusOneHourIsKept() {
        // At 10:05 the minute data reaches 11:04. The old cut kept the first
        // hourly reading at or after 11:05 — 12:00 — leaving 11:00's hour blank.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        XCTAssertTrue(result.hasMinuteForecast)
        let hourlyKept = result.dataPoints.filter { $0.resolution == .hour }
        XCTAssertEqual(hourlyKept.first?.date, minute(5, from: hour(1)), "The 11:00 reading contains 11:05 and stays, from where the minute data ends")
        XCTAssertEqual(hourlyKept.first?.span, 55 * 60, "What is left of its hour")
        XCTAssertEqual(hourlyKept.count, 11)
    }

    func testEveryMinuteReadingIsKeptAndTheHourlyReadingsFollowThem() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        let dates = result.dataPoints.map(\.date)
        XCTAssertEqual(Array(dates.prefix(60)), (0..<60).map { minute($0, from: now) }, "10:05 through 11:04")
        XCTAssertEqual(dates[60], minute(5, from: hour(1)))
        XCTAssertEqual(dates[61], hour(2))
        XCTAssertEqual(result.dataPoints[61].span, ChartDataPoint.Resolution.hour.span)
        XCTAssertEqual(dates, dates.sorted())
    }

    func testAtTheTopOfTheHourEveryMinuteReadingIsKept() {
        let now = hour0
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        XCTAssertEqual(result.dataPoints.filter { $0.resolution == .minute }.count, 60)
        let firstHourly = result.dataPoints.first { $0.resolution == .hour }
        XCTAssertEqual(firstHourly?.date, hour(1))
        XCTAssertEqual(firstHourly?.span, ChartDataPoint.Resolution.hour.span, "Nothing to clip when the minute data ends on the hour")
    }

    func testLateInTheHourNoMinuteReadingIsLostToTheHourlyReading() {
        // Fetched at 10:59: the minute data runs 10:59–11:58 with a shower from
        // 11:10 to 11:30, and the hourly feed calls the 11:00 hour dry. A cut at
        // the 11:00 reading's start kept one minute reading of the sixty and
        // the shower vanished — "Clear", an hourly poll, no rain-start alert.
        let now = minute(59, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now, wet: Set(11..<31)), hourly: hourly(), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(result.dataPoints.filter { $0.date < minute(60, from: now) }.count, 60)
        XCTAssertEqual(result.dataPoints[60].date, minute(59, from: hour(1)), "The 11:00 reading, from where the minute data ends")
        XCTAssertEqual(result.dataPoints[60].resolution, .hour, "A one-minute sliver of the hour is still an hourly reading")
        XCTAssertEqual(result.dataPoints[61].date, hour(2))

        let status = f.heroStatus(for: .cloudy, at: now)
        XCTAssertEqual(status.title, "Rains in 11 min")
        XCTAssertEqual(status.subtitle, "Will last 20 min")
        XCTAssertEqual(f.nextPollInterval(leadTimeMinutes: 20, at: now), 5 * 60)
        XCTAssertEqual(f.nextConfirmedPrecipitationPeriod(at: now)?.start, minute(11, from: now), "Seen by the nowcast, so the gate may act on it")
    }

    func testAShowerInTheHourAfterTheMinuteDataIsVisible() {
        // Dry minute data to 11:04; the hourly feed says rain in the 11:00 hour.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        let next = f.nextPrecipitationPeriod(at: now)
        XCTAssertEqual(next?.start, minute(5, from: hour(1)), "Rain begins where the dry minute data ends, not before it")
        XCTAssertEqual(next?.end, hour(2), "An hourly reading's period runs to the next hourly reading")
        XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).title, "Rains in 1h")
        XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).subtitle, "Will last 55 min")
    }

    func testMinuteRainRunningIntoTheKeptHourlyReadingIsOnePeriod() {
        let now = minute(5, from: hour0)
        let wetMinutes = Set(40..<60)
        let result = ForecastMerge.merge(minute: minutes(from: now, wet: wetMinutes), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.precipitationPeriods.count, 1)
        XCTAssertEqual(f.precipitationPeriods.first?.start, minute(45, from: hour0))
        XCTAssertEqual(f.precipitationPeriods.first?.end, hour(2))
        XCTAssertEqual(f.confirmedPeriods.count, 1, "It began in the minute data, so the nowcast has seen it")
    }

    // MARK: - Which periods the alert gate may act on

    func testAPeriodBeginningWhereTheNowcastEndsIsUnconfirmed() {
        // Dry minute data to 11:04 and a wet 11:00 hour: the onset the merge
        // produces is the nowcast's horizon, which moves with every poll. The
        // hero line shows it; the alert gate and the Live Activity do not see it.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.precipitationPeriods.map(\.isConfirmed), [false])
        XCTAssertNotNil(f.nextPrecipitationPeriod(at: now))
        XCTAssertNil(f.nextConfirmedPrecipitationPeriod(at: now))
        XCTAssertTrue(f.confirmedPeriods.isEmpty)
    }

    func testAtTheTopOfTheHourTheHourAfterTheNowcastIsStillUnconfirmed() {
        // Fetched at 10:00 the minute data ends exactly at 11:00, so the 11:00
        // reading follows it whole — but it is still the reading at the
        // horizon, and the next poll will clip it: no event to alert on yet.
        let now = hour0
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.precipitationPeriods.first?.start, hour(1))
        XCTAssertEqual(f.precipitationPeriods.map(\.isConfirmed), [false])
    }

    func testAWetHourFurtherOutBeginsOnAWholeReadingAndStaysConfirmed() {
        // Only the reading right after the nowcast has the moving onset. The
        // 12:00 hour begins on a whole reading with a stable date, so it stays
        // an event the Live Activity may draw, as it was before the merge changed.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(wet: [2]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.precipitationPeriods.map(\.start), [hour(2)])
        XCTAssertEqual(f.confirmedPeriods.map(\.start), [hour(2)])
    }

    func testANowcastShowerAndAWetHourFurtherOutAreTwoConfirmedPeriods() {
        // Rain 10:05–10:29 in the minute data and a wet 13:00 hour: two bursts,
        // both placed by their own data, both for the Live Activity's track.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now, wet: Set(0..<25)), hourly: hourly(wet: [3]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.confirmedPeriods.map(\.start), [now, hour(3)])
        XCTAssertEqual(f.confirmedPeriods.map(\.end), [minute(25, from: now), hour(4)])
    }

    func testWithoutAnyHourlyReadingTheMinuteDataStands() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: [], now: now)
        XCTAssertEqual(result.dataPoints.count, 60)
        XCTAssertTrue(result.hasMinuteForecast)
    }

    func testAnEmptyMinuteForecastIsNoMinuteForecast() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: [], hourly: hourly(), now: now)
        XCTAssertFalse(result.hasMinuteForecast)
        XCTAssertEqual(result.dataPoints.first?.date, hour(0))
    }

    // MARK: - Without minute data: hourly from now

    func testWithoutMinuteDataTheSeriesStartsAtTheHourContainingNow() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly(), now: now)

        XCTAssertFalse(result.hasMinuteForecast)
        XCTAssertEqual(result.dataPoints.first?.date, hour(0), "The 10:00 reading contains 10:05")
        XCTAssertEqual(result.dataPoints.count, 12)
        XCTAssertTrue(result.dataPoints.allSatisfy { $0.resolution == .hour && $0.span == ChartDataPoint.Resolution.hour.span })
    }

    func testWithoutMinuteDataRainInTheCurrentHourIsRainingNow() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly(wet: [0]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertTrue(f.isPrecipitating(at: now))
        XCTAssertEqual(f.currentType, .rain)
        XCTAssertEqual(f.heroStatus(for: .clear, at: now).title, "Raining")
        XCTAssertEqual(f.heroStatus(for: .clear, at: now).subtitle, "Stops in 55 min")
    }

    func testWithoutMinuteDataRainNextHourIsInsideTheLongestLeadTime() {
        // The old series began at 12:00 here; 11:00 was unreachable for every
        // lead time the app offers, so no alert could ever fire.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertFalse(f.isPrecipitating(at: now))
        XCTAssertEqual(f.nextPrecipitationPeriod(at: now)?.start.timeIntervalSince(now), 55 * 60)
        XCTAssertEqual(f.nextConfirmedPrecipitationPeriod(at: now)?.start, hour(1), "With no nowcast, hourly data is what the gate acts on")
    }

    func testWithoutMinuteDataAFeedThatStartsLaterIsKeptWhole() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly(hours: 1..<12), now: now)
        XCTAssertEqual(result.dataPoints.first?.date, hour(1))
        XCTAssertEqual(result.dataPoints.count, 11)
    }

    func testHourlyReadingsAreOrderedByDateWhateverOrderTheyArrive() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly().reversed(), now: now)
        XCTAssertEqual(result.dataPoints.map(\.date), (0..<12).map(hour))
    }
}
