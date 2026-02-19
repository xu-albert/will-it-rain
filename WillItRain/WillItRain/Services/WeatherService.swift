import Foundation
import WeatherKit
import CoreLocation

final class WeatherService {
    private let service = WeatherService.weatherKitService

    private static let weatherKitService = WeatherKit.WeatherService.shared

    func fetch(location: CLLocation, locationName: String) async throws -> RainForecast {
        let weather = try await Self.weatherKitService.weather(
            for: location,
            including: .minute, .hourly, .current
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

        return RainForecast(
            dataPoints: dataPoints,
            precipitationPeriods: periods,
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
        default: return .none
        }
    }

    private func findPrecipitationPeriods(from dataPoints: [ChartDataPoint]) -> [PrecipitationPeriod] {
        var periods: [PrecipitationPeriod] = []
        var periodStart: Date?
        var periodType: PrecipitationType = .none
        var peakIntensity: PrecipitationIntensity = .none

        for point in dataPoints {
            if point.intensity != .none {
                if periodStart == nil {
                    periodStart = point.date
                    periodType = point.type
                    peakIntensity = point.intensity
                } else {
                    if point.intensity > peakIntensity {
                        peakIntensity = point.intensity
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
            switch currentPeriod.type {
            case .snow: return .snowing
            default: return .raining
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
