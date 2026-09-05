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
/// Here an hourly reading stands for the whole hour it starts, so the reading
/// that *contains* an instant is kept for it. Pure so it can be tested at an
/// explicit instant, without WeatherKit.
enum ForecastMerge {
    struct Result {
        let dataPoints: [ChartDataPoint]
        /// False when `minute` was nil: the series is hourly readings from the
        /// one containing `now`.
        let hasMinuteForecast: Bool
    }

    /// - Parameters:
    ///   - minute: the minute forecast's readings, or nil where WeatherKit has none.
    ///   - hourly: the hourly forecast's readings, ascending, each spanning its hour.
    ///   - now: the instant the forecast is being built for.
    static func merge(minute: [ChartDataPoint]?, hourly: [ChartDataPoint], now: Date) -> Result {
        let hourly = hourly.sorted { $0.date < $1.date }

        guard let minute else {
            // No minute forecast: hourly from the reading that contains now. If
            // the feed starts after now (it starts on the current hour, so this
            // is defensive), keep everything rather than nothing.
            let start = hourly.lastIndex { $0.date <= now } ?? hourly.startIndex
            return Result(dataPoints: Array(hourly[start...]), hasMinuteForecast: false)
        }

        // Minute readings, then hourly from the reading that contains now + 1h.
        // Minute readings past that hourly reading's start are dropped rather
        // than interleaved: an hourly reading among minute ones would end the
        // hour's period at the very next minute reading — "rains in 55 min,
        // will last 1 min" — instead of at the next hourly one.
        let oneHourOn = now.addingTimeInterval(ChartDataPoint.hourSpan)
        let cutIndex = hourly.lastIndex { $0.date <= oneHourOn } ?? hourly.firstIndex { $0.date > oneHourOn }
        guard let cutIndex else {
            return Result(dataPoints: minute.sorted { $0.date < $1.date }, hasMinuteForecast: true)
        }
        let cut = hourly[cutIndex].date
        let kept = minute.filter { $0.date < cut }.sorted { $0.date < $1.date }
        return Result(dataPoints: kept + hourly[cutIndex...], hasMinuteForecast: true)
    }
}
