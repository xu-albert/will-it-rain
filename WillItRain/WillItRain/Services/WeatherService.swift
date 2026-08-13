import Foundation
import WeatherKit
import CoreLocation

final class WeatherService {
    private let service = WeatherService.weatherKitService

    private static let weatherKitService = WeatherKit.WeatherService.shared

    func fetch(location: CLLocation, locationName: String) async throws -> RainForecast {
        let weather = try await Self.weatherKitService.weather(
            for: location,
            including: .minute, .hourly, .current, .daily
        )

        let now = Date()
        var dataPoints: [ChartDataPoint] = []

        // Minute-by-minute for next hour
        if let minuteForecast = weather.0 {
            for minute in minuteForecast.forecast {
                let type = precipitationType(from: minute.precipitation)
                let mmPerHr = minute.precipitationIntensity.value
                let intensity = PrecipitationIntensity.from(millimetersPerHour: mmPerHr)
                dataPoints.append(ChartDataPoint(
                    date: minute.date,
                    probability: minute.precipitationChance,
                    intensity: intensity,
                    type: type,
                    precipitationAmount: mmPerHr
                ))
            }
        }

        // Hourly for remaining hours
        let hourlyForecast = weather.1
        let oneHourFromNow = now.addingTimeInterval(3600)
        for hour in hourlyForecast.forecast {
            guard hour.date >= oneHourFromNow else { continue }
            let type = precipitationType(from: hour.precipitation)
            let intensity = PrecipitationIntensity.from(millimetersPerHour: hour.precipitationAmount.converted(to: .millimeters).value)
            dataPoints.append(ChartDataPoint(
                date: hour.date,
                probability: hour.precipitationChance,
                intensity: intensity,
                type: type,
                precipitationAmount: hour.precipitationAmount.converted(to: .millimeters).value
            ))
        }

        dataPoints.sort { $0.date < $1.date }

        let periods = findPrecipitationPeriods(from: dataPoints)
        let condition = currentWeatherCondition(current: weather.2, periods: periods)

        let dailySummaries = weather.3.forecast.prefix(7).map { day in
            DaySummary(
                date: day.date,
                precipChance: day.precipitationChance,
                type: precipitationType(from: day.precipitation),
                highTemp: day.highTemperature.converted(to: .celsius).value,
                lowTemp: day.lowTemperature.converted(to: .celsius).value
            )
        }

        return RainForecast(
            dataPoints: dataPoints,
            precipitationPeriods: periods,
            dailySummaries: Array(dailySummaries),
            currentCondition: condition,
            currentType: periods.first { $0.contains(now) }?.type ?? .none,
            locationName: locationName,
            fetchedAt: now
        )
    }

    private func precipitationType(from precip: WeatherKit.Precipitation) -> PrecipitationType {
        switch precip {
        case .rain: return .rain
        case .snow: return .snow
        case .hail: return .hail
        case .sleet: return .sleet
        case .mixed: return .mixed
        case .none: return .none
        // Unknown future cases fall back to rain — the right default for a rain app.
        default: return .rain
        }
    }

    /// A point counts as precipitation when a specific amount is predicted (`intensity != .none`)
    /// OR when rain is more likely than not (`probability >= 0.5`). Keying off amount alone made the
    /// app show "Clear" when WeatherKit reported a high chance but a low probability-weighted amount —
    /// the "says nothing's happening when it's going to rain" bug. Adding the chance gate only *adds*
    /// detections (never removes), and 0.5 keeps marginal <50% forecasts from crying wolf. This makes
    /// the in-app status agree with the backend, which already gates on precipitation chance.
    private static let likelyRainProbability = 0.5

    private func findPrecipitationPeriods(from dataPoints: [ChartDataPoint]) -> [PrecipitationPeriod] {
        var periods: [PrecipitationPeriod] = []
        var periodStart: Date?
        var periodType: PrecipitationType = .none
        var peakIntensity: PrecipitationIntensity = .none

        for point in dataPoints {
            let isWet = point.intensity != .none || point.probability >= Self.likelyRainProbability
            if isWet {
                // If it's likely to rain but the predicted amount rounds to "none", call it light.
                let intensity = point.intensity == .none ? .light : point.intensity
                if periodStart == nil {
                    periodStart = point.date
                    periodType = point.type == .none ? .rain : point.type
                    peakIntensity = intensity
                } else {
                    if intensity > peakIntensity {
                        peakIntensity = intensity
                    }
                    if point.type != .none && point.type != periodType {
                        // Type changed — keep the dominant type
                    }
                }
            } else if let start = periodStart {
                periods.append(PrecipitationPeriod(
                    start: start,
                    end: point.date,
                    type: periodType,
                    peakIntensity: peakIntensity
                ))
                periodStart = nil
                peakIntensity = .none
            }
        }

        // Close any open period
        if let start = periodStart, let lastDate = dataPoints.last?.date {
            periods.append(PrecipitationPeriod(
                start: start,
                end: lastDate,
                type: periodType,
                peakIntensity: peakIntensity
            ))
        }

        return periods
    }

    private func currentWeatherCondition(
        current: CurrentWeather,
        periods: [PrecipitationPeriod]
    ) -> WeatherCondition {
        let now = Date()

        if let currentPeriod = periods.first(where: { $0.contains(now) }) {
            let isNight = current.isDaylight == false
            switch currentPeriod.type {
            case .snow: return isNight ? .snowingNight : .snowing
            default: return isNight ? .rainingNight : .raining
            }
        }

        if current.isDaylight == false {
            return .night
        }

        switch current.condition {
        case .cloudy, .mostlyCloudy, .partlyCloudy, .foggy, .haze:
            return .cloudy
        default:
            return .clear
        }
    }
}
