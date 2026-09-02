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
            fetchedAt: now
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
