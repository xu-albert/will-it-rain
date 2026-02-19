import WidgetKit
import SwiftUI

struct RainWidgetEntry: TimelineEntry {
    let date: Date
    let statusText: String
    let subtitleText: String
    let precipType: PrecipitationType
    let condition: WeatherCondition
    let chartData: [ChartDataPoint]
}

struct RainWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> RainWidgetEntry {
        RainWidgetEntry(
            date: Date(),
            statusText: "No Rain",
            subtitleText: "Dry for now",
            precipType: .none,
            condition: .clear,
            chartData: []
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (RainWidgetEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RainWidgetEntry>) -> Void) {
        Task {
            do {
                let locationService = LocationService()
                let weatherService = WeatherService()
                let location = try await locationService.currentLocation()
                let name = await locationService.reverseGeocode(location)
                let forecast = try await weatherService.fetch(location: location, locationName: name)

                let status = forecast.heroStatus
                let entry = RainWidgetEntry(
                    date: Date(),
                    statusText: status.title,
                    subtitleText: status.subtitle,
                    precipType: forecast.currentType,
                    condition: forecast.currentCondition,
                    chartData: forecast.dataPoints
                )

                let nextUpdate = Date().addingTimeInterval(30 * 60)
                let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
                completion(timeline)
            } catch {
                let entry = RainWidgetEntry(
                    date: Date(),
                    statusText: "—",
                    subtitleText: "Unable to load",
                    precipType: .none,
                    condition: .clear,
                    chartData: []
                )
                let timeline = Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60)))
                completion(timeline)
            }
        }
    }
}

// @main — re-enable when this file moves to the Widget Extension target
struct WillItRainWidgetBundle: WidgetBundle {
    var body: some Widget {
        WillItRainSmallWidget()
        WillItRainMediumWidget()
    }
}

struct WillItRainSmallWidget: Widget {
    let kind = "WillItRainSmall"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RainWidgetProvider()) { entry in
            SmallWidgetView(entry: entry)
        }
        .configurationDisplayName("Will It Rain?")
        .description("Quick precipitation status.")
        .supportedFamilies([.systemSmall])
    }
}

struct WillItRainMediumWidget: Widget {
    let kind = "WillItRainMedium"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: RainWidgetProvider()) { entry in
            MediumWidgetView(entry: entry)
        }
        .configurationDisplayName("Will It Rain? (Wide)")
        .description("Status with precipitation chart.")
        .supportedFamilies([.systemMedium])
    }
}
