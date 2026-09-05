import Foundation

/// Joins WeatherKit's minute-by-minute forecast (about the next hour, and only in
/// some regions) with its hourly forecast into the one time-ordered series that
/// `PrecipitationPeriod.detect(in:)` and the charts read.
///
/// The seam between the two resolutions used to be a hard cut at `now + 1h`:
/// every hourly reading before that instant was dropped. That left two holes.
/// With minute data, at 10:05 the 11:00 hourly reading fell (11:00 < 11:05) and
/// the next reading kept was 12:00, so a shower confined to 11:10–11:40 was
/// invisible until the minute data reached it. Without minute data the series
/// began at the first hourly reading past `now + 1h` and, because the cut moved
/// with the clock, the hole never closed: nothing was ever "now", so the app was
/// never raining and no rain-start alert could fire for any lead time it offers.
///
/// Here an hourly reading stands for the whole hour it starts. Without minute
/// data the series is the hourly readings from the one that contains `now`.
/// With it, every minute reading is kept and the hourly readings take over where
/// they end: the one whose hour contains that instant is clipped to begin there,
/// so it neither repeats what the minute data already said nor sits among minute
/// readings, where a wet hour would end at the very next minute reading. A
/// period that begins on that clipped reading starts at the nowcast's horizon,
/// not at anything the nowcast saw; `PrecipitationPeriod.detect` marks it
/// unconfirmed and the alert gate leaves it alone. Pure so it can be tested at
/// an explicit instant, without WeatherKit.
enum ForecastMerge {
    struct Result {
        let dataPoints: [ChartDataPoint]
        /// False when there were no minute readings: the series is hourly
        /// readings from the one containing `now`.
        let hasMinuteForecast: Bool
    }

    /// - Parameters:
    ///   - minute: the minute forecast's readings, or nil where WeatherKit has none.
    ///   - hourly: the hourly forecast's readings, ascending, each spanning its hour.
    ///   - now: the instant the forecast is being built for.
    static func merge(minute: [ChartDataPoint]?, hourly: [ChartDataPoint], now: Date) -> Result {
        let hourly = hourly.sorted { $0.date < $1.date }
        let minute = (minute ?? []).sorted { $0.date < $1.date }

        guard let lastMinute = minute.last else {
            // No minute forecast: hourly from the reading that contains now. If
            // the feed starts after now (it starts on the current hour, so this
            // is defensive), keep everything rather than nothing.
            let start = hourly.lastIndex { $0.date <= now } ?? hourly.startIndex
            return Result(dataPoints: Array(hourly[start...]), hasMinuteForecast: false)
        }

        let minuteEnd = lastMinute.date.addingTimeInterval(lastMinute.span)
        var rest = Array(hourly.drop(while: { $0.date.addingTimeInterval($0.span) <= minuteEnd }))
        if let first = rest.first, first.date < minuteEnd {
            rest[0] = ChartDataPoint(
                date: minuteEnd,
                probability: first.probability,
                intensity: first.intensity,
                type: first.type,
                precipitationAmount: first.precipitationAmount,
                resolution: .hour,
                span: first.date.addingTimeInterval(first.span).timeIntervalSince(minuteEnd)
            )
        }
        return Result(dataPoints: minute + rest, hasMinuteForecast: true)
    }
}
