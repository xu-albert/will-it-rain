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
                span: ChartDataPoint.hourSpan
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

    // MARK: - With minute data: the cut

    func testTheHourlyReadingContainingNowPlusOneHourIsKept() {
        // At 10:05 the minute data reaches 11:04. The old cut kept the first
        // hourly reading at or after 11:05 — 12:00 — leaving 11:00's hour blank.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        XCTAssertTrue(result.hasMinuteForecast)
        let hourlyKept = result.dataPoints.filter { $0.span == ChartDataPoint.hourSpan }
        XCTAssertEqual(hourlyKept.first?.date, hour(1), "The 11:00 reading contains 11:05 and stays")
        XCTAssertEqual(hourlyKept.count, 11)
    }

    func testMinuteReadingsStopWhereTheKeptHourlyReadingBegins() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        let minuteKept = result.dataPoints.filter { $0.span == ChartDataPoint.minuteSpan }
        XCTAssertEqual(minuteKept.count, 55, "10:05 through 10:59")
        XCTAssertEqual(minuteKept.last?.date, minute(59, from: hour0))
        XCTAssertEqual(result.dataPoints.map(\.date), result.dataPoints.map(\.date).sorted())
    }

    func testAtTheTopOfTheHourEveryMinuteReadingIsKept() {
        let now = hour0
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(), now: now)

        XCTAssertEqual(result.dataPoints.filter { $0.span == ChartDataPoint.minuteSpan }.count, 60)
        XCTAssertEqual(result.dataPoints.first { $0.span == ChartDataPoint.hourSpan }?.date, hour(1))
    }

    func testAShowerInTheHourAfterTheMinuteDataIsVisible() {
        // Dry minute data to 11:04; the hourly feed says rain in the 11:00 hour.
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        let next = f.nextPrecipitationPeriod(at: now)
        XCTAssertEqual(next?.start, hour(1))
        XCTAssertEqual(next?.end, hour(2), "An hourly reading's period runs to the next hourly reading")
        XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).title, "Rains in 55 min")
        XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).subtitle, "Will last 1h")
    }

    func testMinuteRainRunningIntoTheKeptHourlyReadingIsOnePeriod() {
        let now = minute(5, from: hour0)
        let wetMinutes = Set(40..<60)
        let result = ForecastMerge.merge(minute: minutes(from: now, wet: wetMinutes), hourly: hourly(wet: [1]), now: now)
        let f = forecast(from: result, at: now)

        XCTAssertEqual(f.precipitationPeriods.count, 1)
        XCTAssertEqual(f.precipitationPeriods.first?.start, minute(45, from: hour0))
        XCTAssertEqual(f.precipitationPeriods.first?.end, hour(2))
    }

    func testWithoutAnyHourlyReadingTheMinuteDataStands() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: minutes(from: now), hourly: [], now: now)
        XCTAssertEqual(result.dataPoints.count, 60)
        XCTAssertTrue(result.hasMinuteForecast)
    }

    // MARK: - Without minute data: hourly from now

    func testWithoutMinuteDataTheSeriesStartsAtTheHourContainingNow() {
        let now = minute(5, from: hour0)
        let result = ForecastMerge.merge(minute: nil, hourly: hourly(), now: now)

        XCTAssertFalse(result.hasMinuteForecast)
        XCTAssertEqual(result.dataPoints.first?.date, hour(0), "The 10:00 reading contains 10:05")
        XCTAssertEqual(result.dataPoints.count, 12)
        XCTAssertTrue(result.dataPoints.allSatisfy { $0.span == ChartDataPoint.hourSpan })
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

    // MARK: - The reading model

    func testAReadingCoversItsSpanFromItsDate() {
        let hourly = ChartDataPoint(date: hour0, probability: 0, intensity: .none, type: .none, precipitationAmount: 0, span: ChartDataPoint.hourSpan)
        XCTAssertTrue(hourly.covers(hour0))
        XCTAssertTrue(hourly.covers(minute(59, from: hour0)))
        XCTAssertFalse(hourly.covers(hour(1)))
        XCTAssertFalse(hourly.covers(hour0.addingTimeInterval(-1)))

        let minutely = ChartDataPoint(date: hour0, probability: 0, intensity: .none, type: .none, precipitationAmount: 0)
        XCTAssertEqual(minutely.span, ChartDataPoint.minuteSpan, "A reading is a minute one unless said otherwise")
        XCTAssertFalse(minutely.covers(minute(1, from: hour0)))
    }
}
