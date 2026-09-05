import XCTest
@testable import WillItRain

/// The on-device alert gate. A notification exists only because the user asked
/// for a lead time, arrives inside it, and never repeats — so every path through
/// `evaluateAndSchedule` is driven here at explicit instants, with delivery
/// recorded instead of handed to the system and settings kept in an isolated
/// UserDefaults suite.
final class NotificationServiceTests: XCTestCase {

    private struct Delivered: Equatable {
        let title: String
        let body: String
        let identifier: String
    }

    private var suiteName = ""
    private var defaults: UserDefaults!
    private var settings: NotificationSettings!
    private var delivered: [Delivered] = []
    private var service: NotificationService!

    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    /// The steady state of an install that has seen rain before: the last dry
    /// spell began long ago. Without it the very first dry evaluation is taken
    /// as "the rain just stopped" and the resume path fires on its own; see the
    /// resume tests for the transition that is meant to trigger it.
    private var longAgo: Date { t0.addingTimeInterval(-24 * 3600) }

    override func setUp() {
        super.setUp()
        suiteName = "NotificationServiceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        settings = NotificationSettings(defaults: defaults)
        settings.lastRainEndTime = longAgo
        delivered = []
        service = NotificationService { [weak self] title, body, identifier in
            self?.delivered.append(Delivered(title: title, body: body, identifier: identifier))
        }
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Fixtures

    private func minutes(_ m: Int, from base: Date? = nil) -> Date {
        (base ?? t0).addingTimeInterval(TimeInterval(m * 60))
    }

    /// A forecast with the given periods, expressed in minutes relative to `t0`.
    private func forecast(
        _ periods: [(start: Int, end: Int)],
        type: PrecipitationType = .rain,
        peak: PrecipitationIntensity = .moderate
    ) -> RainForecast {
        let points = stride(from: 0, through: 12 * 60, by: 60).map { m in
            ChartDataPoint(date: minutes(m), probability: 0, intensity: .none, type: .none, precipitationAmount: 0)
        }
        let built = periods.map {
            PrecipitationPeriod(start: minutes($0.start), end: minutes($0.end), type: type, peakIntensity: peak)
        }
        return RainForecast(
            dataPoints: points,
            precipitationPeriods: built,
            dailySummaries: [],
            currentCondition: .clear,
            currentType: .none,
            locationName: "Testville",
            fetchedAt: t0
        )
    }

    /// The top of the hour containing `t0`, which is 13:20 into it.
    private var hour0: Date { t0.addingTimeInterval(-800) }

    /// Twelve hourly readings on the hour from `hour0`, the wet ones by index.
    private func hourlyReadings(wetHours: Set<Int>) -> [ChartDataPoint] {
        (0..<12).map { h in
            ChartDataPoint(
                date: hour0.addingTimeInterval(TimeInterval(h) * 3600),
                probability: wetHours.contains(h) ? 0.7 : 0.1,
                intensity: wetHours.contains(h) ? .light : .none,
                type: wetHours.contains(h) ? .rain : .none,
                precipitationAmount: wetHours.contains(h) ? 1.0 : 0,
                resolution: .hour
            )
        }
    }

    /// Sixty minute readings from `now`, the wet ones by index.
    private func minuteReadings(from now: Date, wetMinutes: Set<Int>) -> [ChartDataPoint] {
        (0..<60).map { m in
            ChartDataPoint(
                date: now.addingTimeInterval(TimeInterval(m) * 60),
                probability: wetMinutes.contains(m) ? 0.8 : 0.05,
                intensity: wetMinutes.contains(m) ? .moderate : .none,
                type: wetMinutes.contains(m) ? .rain : .none,
                precipitationAmount: wetMinutes.contains(m) ? 3.0 : 0
            )
        }
    }

    /// A forecast built the way `WeatherService` builds one at `now`.
    private func merged(minute: [ChartDataPoint]?, wetHours: Set<Int>, at now: Date) -> RainForecast {
        let merged = ForecastMerge.merge(minute: minute, hourly: hourlyReadings(wetHours: wetHours), now: now)
        let periods = PrecipitationPeriod.detect(in: merged.dataPoints)
        return RainForecast(
            dataPoints: merged.dataPoints,
            precipitationPeriods: periods,
            dailySummaries: [],
            currentCondition: .clear,
            currentType: periods.first { $0.contains(now) }?.type ?? .none,
            locationName: "Testville",
            fetchedAt: now,
            hasMinuteForecast: merged.hasMinuteForecast
        )
    }

    /// Where WeatherKit has no minute forecast: hourly readings only, from the
    /// hour that contains `t0`, so hour 1 begins 46:40 later.
    private func hourlyOnlyForecast(wetHours: Set<Int>) -> RainForecast {
        merged(minute: nil, wetHours: wetHours, at: t0)
    }

    /// Inside minute coverage, polled at `now`: a nowcast from `now`, then the
    /// hourly readings from where it ends.
    private func nowcastForecast(at now: Date, wetMinutes: Set<Int> = [], wetHours: Set<Int> = []) -> RainForecast {
        merged(minute: minuteReadings(from: now, wetMinutes: wetMinutes), wetHours: wetHours, at: now)
    }

    private func evaluate(_ forecast: RainForecast, at now: Date) {
        service.evaluateAndSchedule(forecast: forecast, settings: settings, now: now)
    }

    private var identifiers: [String] { delivered.map(\.identifier) }

    // MARK: - Rain starting

    func testRainStartIsConfirmedOnTheSecondPassInsideLeadTime() {
        settings.leadTime = 20
        let rainAt15 = forecast([(15, 45)])

        evaluate(rainAt15, at: t0)
        XCTAssertEqual(delivered, [], "The first sighting only arms the confirmation")
        XCTAssertEqual(settings.pendingPrecipStart, minutes(15))

        evaluate(rainAt15, at: minutes(5))
        XCTAssertEqual(identifiers, ["precip-start"])
        XCTAssertEqual(delivered.first?.title, "Rain in ~10 min")
        XCTAssertEqual(settings.lastNotifiedPrecipStart, minutes(15))
        XCTAssertNil(settings.pendingPrecipStart)
    }

    func testRainStartTitleSaysSoonInsideFiveMinutes() {
        settings.leadTime = 20
        let rainAt4 = forecast([(4, 45)], type: .snow, peak: .light)

        evaluate(rainAt4, at: t0)
        evaluate(rainAt4, at: minutes(1))

        XCTAssertEqual(delivered.first?.title, "Snow starting soon")
        XCTAssertTrue(delivered.first?.body.hasPrefix("Light snow expected around") == true)
    }

    func testRainOutsideLeadTimeIsNotEvenPending() {
        settings.leadTime = 20
        evaluate(forecast([(45, 90)]), at: t0)
        evaluate(forecast([(45, 90)]), at: minutes(5))

        XCTAssertEqual(delivered, [])
        XCTAssertNil(settings.pendingPrecipStart)
    }

    func testTheSameRainIsNeverAnnouncedTwice() {
        settings.leadTime = 20
        let rainAt15 = forecast([(15, 45)])
        evaluate(rainAt15, at: t0)
        evaluate(rainAt15, at: minutes(5))
        XCTAssertEqual(identifiers, ["precip-start"])

        // Later polls of the same event, including one where the forecast nudges
        // the start by a few minutes, add nothing.
        evaluate(rainAt15, at: minutes(8))
        evaluate(forecast([(18, 45)]), at: minutes(10))
        evaluate(forecast([(18, 45)]), at: minutes(12))
        XCTAssertEqual(identifiers, ["precip-start"])
    }

    func testRainThatMovesOutOfTheWindowDisarmsTheConfirmation() {
        settings.leadTime = 20
        evaluate(forecast([(15, 45)]), at: t0)
        XCTAssertNotNil(settings.pendingPrecipStart)

        evaluate(forecast([(50, 90)]), at: minutes(5))
        XCTAssertNil(settings.pendingPrecipStart)
        XCTAssertEqual(delivered, [])

        // Coming back inside the window starts the two passes over.
        evaluate(forecast([(24, 45)]), at: minutes(5))
        XCTAssertEqual(delivered, [])
        XCTAssertEqual(settings.pendingPrecipStart, minutes(24))
    }

    func testADifferentLaterRainIsAnnouncedOnItsOwn() {
        settings.leadTime = 20
        let first = forecast([(15, 30)])
        evaluate(first, at: t0)
        evaluate(first, at: minutes(5))
        XCTAssertEqual(identifiers, ["precip-start"])

        // A separate event, more than 10 minutes from the first, goes through
        // its own two passes and is delivered.
        let second = forecast([(50, 70)])
        evaluate(second, at: minutes(35))
        evaluate(second, at: minutes(40))
        XCTAssertEqual(identifiers, ["precip-start", "precip-start"])
    }

    func testRainStartAlertsCanBeSwitchedOff() {
        settings.leadTime = 20
        settings.rainStartEnabled = false
        let rainAt15 = forecast([(15, 45)])

        evaluate(rainAt15, at: t0)
        evaluate(rainAt15, at: minutes(5))

        XCTAssertEqual(delivered, [])
        XCTAssertNil(settings.pendingPrecipStart)
    }

    // MARK: - Hourly-only data (no minute forecast in this region)

    func testHourlyOnlyRainNextHourGoesThroughTheLeadTimeGate() {
        // Rain in the coming hour, 46 minutes off. Outside a 20-minute lead
        // time it is not even pending; once inside, the usual two passes fire it.
        settings.leadTime = 20
        let f = hourlyOnlyForecast(wetHours: [1])
        XCTAssertFalse(f.hasMinuteForecast)

        evaluate(f, at: t0)
        XCTAssertEqual(delivered, [])
        XCTAssertNil(settings.pendingPrecipStart)

        evaluate(f, at: minutes(30))
        XCTAssertEqual(delivered, [])
        XCTAssertEqual(settings.pendingPrecipStart, t0.addingTimeInterval(2800))

        evaluate(f, at: minutes(35))
        XCTAssertEqual(identifiers, ["precip-start"])
        XCTAssertEqual(delivered.first?.title, "Rain in ~11 min")
    }

    func testHourlyOnlyRainThisHourIsRainingNowAndItsEndIsAnnounced() {
        // The hourly reading containing now is wet: that is rain now, and its
        // end is the next hourly reading, 46 minutes off — inside the 30-minute
        // end window once 20 minutes have passed.
        let f = hourlyOnlyForecast(wetHours: [0])
        XCTAssertTrue(f.isPrecipitating(at: t0))
        XCTAssertEqual(f.currentType, .rain)

        evaluate(f, at: t0)
        XCTAssertNil(settings.lastRainEndTime, "Raining, so no dry spell has begun")
        XCTAssertNil(settings.pendingPrecipEnd)

        evaluate(f, at: minutes(20))
        XCTAssertEqual(settings.pendingPrecipEnd, t0.addingTimeInterval(2800))
        evaluate(f, at: minutes(25))
        XCTAssertEqual(identifiers, ["precip-end"])
        XCTAssertEqual(delivered.first?.title, "Rain ending soon")
    }

    // MARK: - Minute coverage: only rain the nowcast has seen arms the gate

    func testAWetHourTheNowcastHasNotReachedIsNotAlertedOnPollAfterPoll() {
        // The hourly feed calls the coming hour wet; the nowcast, dry to its end
        // on every poll, never sees the rain. The merged onset sits where the
        // nowcast ends and moves with the clock, so taken as an event it was a
        // fresh one every ten minutes — at a 60-minute lead time, an alert for
        // each. The hero line keeps saying "Rains in 1h"; the gate stays quiet.
        settings.leadTime = 60
        for k in stride(from: 5, through: 55, by: 5) {
            let now = hour0.addingTimeInterval(TimeInterval(k * 60))
            let f = nowcastForecast(at: now, wetHours: [1])
            XCTAssertEqual(f.heroStatus(for: .cloudy, at: now).title, "Rains in 1h", "Poll at :\(k)")

            evaluate(f, at: now)
            XCTAssertEqual(delivered, [], "Poll at :\(k)")
            XCTAssertNil(settings.pendingPrecipStart, "Poll at :\(k)")
        }
    }

    func testRainTheNowcastDoesSeeGoesThroughTheGateAsUsual() {
        // The same wet hour, but the nowcast now shows the rain from :50. That
        // onset is one it saw, so the ordinary two passes fire the alert.
        settings.leadTime = 60
        let first = hour0.addingTimeInterval(30 * 60)
        evaluate(nowcastForecast(at: first, wetMinutes: Set(20..<60), wetHours: [1]), at: first)
        XCTAssertEqual(delivered, [])
        XCTAssertEqual(settings.pendingPrecipStart, hour0.addingTimeInterval(50 * 60))

        let second = hour0.addingTimeInterval(35 * 60)
        evaluate(nowcastForecast(at: second, wetMinutes: Set(15..<60), wetHours: [1]), at: second)
        XCTAssertEqual(identifiers, ["precip-start"])
        XCTAssertEqual(delivered.first?.title, "Rain in ~15 min")
    }

    // MARK: - Rain ending

    func testRainEndIsConfirmedOnTheSecondPassInsideThirtyMinutes() {
        let endsAt20 = forecast([(-30, 20)])

        evaluate(endsAt20, at: t0)
        XCTAssertEqual(delivered, [])
        XCTAssertEqual(settings.pendingPrecipEnd, minutes(20))

        evaluate(endsAt20, at: minutes(5))
        XCTAssertEqual(identifiers, ["precip-end"])
        XCTAssertEqual(delivered.first?.title, "Rain ending soon")
        XCTAssertEqual(settings.lastNotifiedPrecipEnd, minutes(20))
        XCTAssertNil(settings.pendingPrecipEnd)

        evaluate(endsAt20, at: minutes(10))
        XCTAssertEqual(identifiers, ["precip-end"], "Not repeated for the same end")
    }

    func testRainEndingMoreThanThirtyMinutesOutIsNotPending() {
        evaluate(forecast([(-30, 45)]), at: t0)
        XCTAssertNil(settings.pendingPrecipEnd)
        XCTAssertEqual(delivered, [])
    }

    func testRainEndAlertsCanBeSwitchedOff() {
        settings.rainEndEnabled = false
        let endsAt20 = forecast([(-30, 20)])
        evaluate(endsAt20, at: t0)
        evaluate(endsAt20, at: minutes(5))

        XCTAssertEqual(delivered, [])
        XCTAssertNil(settings.pendingPrecipEnd)
    }

    // MARK: - Rain resuming

    func testRainReturningWithinTheHourOfStoppingIsAnnouncedAtOnce() {
        settings.leadTime = 20
        settings.rainEndEnabled = false

        // Raining at t0, stops five minutes later.
        evaluate(forecast([(-30, 5)]), at: t0)
        XCTAssertNil(settings.lastRainEndTime, "While raining there is no end to remember")

        // Eight minutes on it is dry, with more rain twenty minutes ahead.
        let base = minutes(8)
        let resuming = forecast([(28, 60)])
        evaluate(resuming, at: base)
        XCTAssertEqual(settings.lastRainEndTime, base)
        XCTAssertEqual(identifiers, ["precip-resume"])
        XCTAssertEqual(delivered.first?.title, "More rain coming")
        XCTAssertEqual(delivered.first?.body, "Rain returns in about 20 min.")

        // The resume alert already covered this event: the ordinary start alert
        // must not follow it up on the next pass.
        evaluate(resuming, at: minutes(5, from: base))
        XCTAssertEqual(identifiers, ["precip-resume"])
    }

    func testRainReturningWellAfterTheGapWasNoticedGoesThroughTheNormalGate() {
        settings.leadTime = 20
        settings.rainEndEnabled = false
        evaluate(forecast([(-30, 5)]), at: t0)

        // The gap is timed from the first dry evaluation, not from the forecast's
        // end time. A dry poll with nothing ahead records it ...
        evaluate(forecast([]), at: minutes(8))
        XCTAssertEqual(settings.lastRainEndTime, minutes(8))
        XCTAssertEqual(delivered, [])

        // ... and rain appearing more than ten minutes after that is an ordinary
        // event: no resume alert, just the first of the two passes.
        evaluate(forecast([(40, 60)]), at: minutes(25))
        XCTAssertEqual(delivered, [])
        XCTAssertEqual(settings.pendingPrecipStart, minutes(40))
    }

    // MARK: - Quiet hours

    func testQuietHoursSuppressEveryAlertAndLeaveStateUntouched() {
        settings.leadTime = 20
        settings.quietHoursEnabled = true
        let calendar = Calendar.current
        settings.quietHoursStart = calendar.date(from: DateComponents(hour: 22, minute: 0))!
        settings.quietHoursEnd = calendar.date(from: DateComponents(hour: 7, minute: 0))!

        let quietNow = calendar.date(bySettingHour: 23, minute: 30, second: 0, of: t0)!
        let rain = forecast([(15, 45)])
        // Rain 15 minutes after the quiet instant, so the gate would otherwise arm.
        let shifted = RainForecast(
            dataPoints: rain.dataPoints,
            precipitationPeriods: [PrecipitationPeriod(
                start: quietNow.addingTimeInterval(15 * 60),
                end: quietNow.addingTimeInterval(45 * 60),
                type: .rain,
                peakIntensity: .moderate
            )],
            dailySummaries: [],
            currentCondition: .clear,
            currentType: .none,
            locationName: "Testville",
            fetchedAt: quietNow
        )

        evaluate(shifted, at: quietNow)
        evaluate(shifted, at: quietNow.addingTimeInterval(5 * 60))

        XCTAssertEqual(delivered, [])
        XCTAssertNil(settings.pendingPrecipStart)
        XCTAssertEqual(settings.lastRainEndTime, longAgo, "Nothing is recorded during quiet hours")
    }
}
