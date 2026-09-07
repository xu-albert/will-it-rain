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

        // Minute-by-minute for the next hour, where WeatherKit has it (regional).
        let minutePoints: [ChartDataPoint]? = weather.0.map { minuteForecast in
            minuteForecast.forecast.map { minute in
                let mmPerHr = minute.precipitationIntensity.value
                return ChartDataPoint(
                    date: minute.date,
                    probability: minute.precipitationChance,
                    intensity: PrecipitationIntensity.from(millimetersPerHour: mmPerHr),
                    type: precipitationType(from: minute.precipitation),
                    precipitationAmount: mmPerHr,
                    resolution: .minute
                )
            }
        }

        // Hourly, each reading standing for the hour it starts.
        let hourlyPoints = weather.1.forecast.map { hour in
            let mmPerHr = hour.precipitationAmount.converted(to: .millimeters).value
            return ChartDataPoint(
                date: hour.date,
                probability: hour.precipitationChance,
                intensity: PrecipitationIntensity.from(millimetersPerHour: mmPerHr),
                type: precipitationType(from: hour.precipitation),
                precipitationAmount: mmPerHr,
                resolution: .hour
            )
        }

        let merged = ForecastMerge.merge(minute: minutePoints, hourly: hourlyPoints, now: now)
        let dataPoints = merged.dataPoints

        let periods = PrecipitationPeriod.detect(in: dataPoints)
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
            fetchedAt: now,
            hasMinuteForecast: merged.hasMinuteForecast
        )
    }

    private func precipitationType(from precip: WeatherKit.Precipitation) -> PrecipitationType {
        switch precip {
        case .rain: return .rain
        case .snow: return .snow
        case .hail: return .hail
        case .sleet: return .sleet
        case .none: return .none
        default: return .rain
        }
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
