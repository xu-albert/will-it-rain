import Foundation

enum ScreenshotScenario: String, CaseIterable {
    case nycRain = "nyc-rain"
    case chicagoSnowNight = "chicago-snow-night"
    case sfClear = "sf-clear"
    case seattleRainSoon = "seattle-rain-soon"

    static func from(launchArgs: [String]) -> ScreenshotScenario? {
        guard let idx = launchArgs.firstIndex(of: "-screenshot"),
              idx + 1 < launchArgs.count else { return nil }
        return ScreenshotScenario(rawValue: launchArgs[idx + 1])
    }

    var forecast: RainForecast {
        switch self {
        case .nycRain: return Self.makeNYCRain()
        case .chicagoSnowNight: return Self.makeChicagoSnowNight()
        case .sfClear: return Self.makeSFClear()
        case .seattleRainSoon: return Self.makeSeattleRainSoon()
        }
    }

    var condition: WeatherCondition {
        switch self {
        case .nycRain: return .raining
        case .chicagoSnowNight: return .snowingNight
        case .sfClear: return .clear
        case .seattleRainSoon: return .cloudy
        }
    }

    // MARK: - NYC: Currently raining, stops in ~40 min

    private static func makeNYCRain() -> RainForecast {
        let now = Date()
        let minutePoints = (0..<60).map { i -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(i) * 60)
            let inRain = i < 40
            let prob = inRain ? Double.random(in: 0.7...0.95) : Double.random(in: 0.05...0.15)
            let amount = inRain ? Double.random(in: 2.0...6.0) : 0.0
            let intensity: PrecipitationIntensity = inRain ? (i < 15 ? .heavy : .moderate) : .none
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .rain, precipitationAmount: amount)
        }

        let hourlyPoints = (1...12).map { h -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(h) * 3600)
            let prob = h <= 1 ? 0.8 : Double.random(in: 0.05...0.25)
            let intensity: PrecipitationIntensity = h <= 1 ? .light : .none
            let amount = h <= 1 ? 1.5 : 0.0
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .rain, precipitationAmount: amount)
        }

        let periods = [
            PrecipitationPeriod(start: now.addingTimeInterval(-600), end: now.addingTimeInterval(40 * 60), type: .rain, peakIntensity: .heavy)
        ]

        let daily = makeDailySummaries(baseTemp: 16, chances: [0.85, 0.40, 0.20, 0.10, 0.55, 0.30, 0.15], types: [.rain, .rain, .none, .none, .rain, .rain, .none])

        return RainForecast(dataPoints: minutePoints + hourlyPoints, precipitationPeriods: periods, dailySummaries: daily, currentCondition: .raining, currentType: .rain, locationName: "New York", fetchedAt: now)
    }

    // MARK: - Chicago: Snowing at night

    private static func makeChicagoSnowNight() -> RainForecast {
        let now = Date()
        let minutePoints = (0..<60).map { i -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(i) * 60)
            let prob = Double.random(in: 0.6...0.9)
            let amount = Double.random(in: 1.0...3.0)
            let intensity: PrecipitationIntensity = i % 10 < 3 ? .heavy : .moderate
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .snow, precipitationAmount: amount)
        }

        let hourlyPoints = (1...12).map { h -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(h) * 3600)
            let prob = h <= 6 ? Double.random(in: 0.5...0.85) : Double.random(in: 0.1...0.3)
            let intensity: PrecipitationIntensity = h <= 4 ? .moderate : (h <= 6 ? .light : .none)
            let amount = h <= 6 ? Double.random(in: 0.5...2.5) : 0.0
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .snow, precipitationAmount: amount)
        }

        let periods = [
            PrecipitationPeriod(start: now.addingTimeInterval(-1800), end: now.addingTimeInterval(6 * 3600), type: .snow, peakIntensity: .heavy)
        ]

        let daily = makeDailySummaries(baseTemp: -2, chances: [0.90, 0.70, 0.45, 0.10, 0.05, 0.30, 0.60], types: [.snow, .snow, .snow, .none, .none, .snow, .snow])

        return RainForecast(dataPoints: minutePoints + hourlyPoints, precipitationPeriods: periods, dailySummaries: daily, currentCondition: .snowingNight, currentType: .snow, locationName: "Chicago", fetchedAt: now)
    }

    // MARK: - SF: Clear skies

    private static func makeSFClear() -> RainForecast {
        let now = Date()
        let minutePoints = (0..<60).map { i -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(i) * 60)
            return ChartDataPoint(date: date, probability: Double.random(in: 0.0...0.05), intensity: .none, type: .none, precipitationAmount: 0)
        }

        let hourlyPoints = (1...12).map { h -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(h) * 3600)
            return ChartDataPoint(date: date, probability: Double.random(in: 0.0...0.08), intensity: .none, type: .none, precipitationAmount: 0)
        }

        let daily = makeDailySummaries(baseTemp: 18, chances: [0.02, 0.05, 0.03, 0.08, 0.04, 0.10, 0.06], types: [.none, .none, .none, .none, .none, .none, .none])

        return RainForecast(dataPoints: minutePoints + hourlyPoints, precipitationPeriods: [], dailySummaries: daily, currentCondition: .clear, currentType: .none, locationName: "San Francisco", fetchedAt: now)
    }

    // MARK: - Seattle: Rain starting in 25 min

    private static func makeSeattleRainSoon() -> RainForecast {
        let now = Date()
        let minutePoints = (0..<60).map { i -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(i) * 60)
            let inRain = i >= 25
            let rampUp = inRain ? min(Double(i - 25) / 15.0, 1.0) : 0.0
            let prob = inRain ? 0.3 + rampUp * 0.55 : Double.random(in: 0.05...0.20)
            let amount = inRain ? rampUp * 4.0 : 0.0
            let intensity: PrecipitationIntensity = !inRain ? .none : (rampUp < 0.3 ? .light : (rampUp < 0.7 ? .moderate : .heavy))
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .rain, precipitationAmount: amount)
        }

        let hourlyPoints = (1...12).map { h -> ChartDataPoint in
            let date = now.addingTimeInterval(Double(h) * 3600)
            let prob = h <= 4 ? Double.random(in: 0.6...0.9) : Double.random(in: 0.15...0.35)
            let intensity: PrecipitationIntensity = h <= 2 ? .heavy : (h <= 4 ? .moderate : .none)
            let amount = h <= 4 ? Double.random(in: 1.0...5.0) : 0.0
            return ChartDataPoint(date: date, probability: prob, intensity: intensity, type: .rain, precipitationAmount: amount)
        }

        let periods = [
            PrecipitationPeriod(start: now.addingTimeInterval(25 * 60), end: now.addingTimeInterval(4 * 3600), type: .rain, peakIntensity: .heavy)
        ]

        let daily = makeDailySummaries(baseTemp: 12, chances: [0.75, 0.60, 0.80, 0.45, 0.30, 0.20, 0.55], types: [.rain, .rain, .rain, .rain, .none, .none, .rain])

        return RainForecast(dataPoints: minutePoints + hourlyPoints, precipitationPeriods: periods, dailySummaries: daily, currentCondition: .cloudy, currentType: .none, locationName: "Seattle", fetchedAt: now)
    }

    // MARK: - Helpers

    private static func makeDailySummaries(baseTemp: Double, chances: [Double], types: [PrecipitationType]) -> [DaySummary] {
        let cal = Calendar.current
        return (0..<7).map { day in
            let date = cal.date(byAdding: .day, value: day, to: cal.startOfDay(for: Date()))!
            let high = baseTemp + Double.random(in: -2...4)
            let low = high - Double.random(in: 6...12)
            return DaySummary(date: date, precipChance: chances[day], type: types[day], highTemp: high, lowTemp: low)
        }
    }
}
