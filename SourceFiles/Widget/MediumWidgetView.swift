import SwiftUI
import Charts
import WidgetKit

struct MediumWidgetView: View {
    let entry: RainWidgetEntry

    var body: some View {
        ZStack {
            gradientBackground(for: entry.condition)

            HStack(spacing: 16) {
                // Left: status
                VStack(spacing: 8) {
                    Image(systemName: entry.precipType.icon)
                        .font(.system(size: 28))
                        .foregroundColor(.white)

                    Text(entry.statusText)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                    Text(entry.subtitleText)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.7))
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)

                // Right: mini chart
                if !entry.chartData.isEmpty {
                    miniChart
                        .frame(maxWidth: .infinity)
                }
            }
            .padding()
        }
    }

    private var miniChart: some View {
        let cutoff = Date().addingTimeInterval(6 * 3600)
        let points = entry.chartData.filter { $0.date <= cutoff }

        return Chart {
            ForEach(points) { point in
                AreaMark(
                    x: .value("Time", point.date),
                    y: .value("Intensity", point.intensity.numericValue)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color.blue.opacity(0.6), Color.blue.opacity(0.2)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.catmullRom)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0...3.5)
        .frame(height: 60)
    }

    private func gradientBackground(for condition: WeatherCondition) -> some View {
        LinearGradient(
            colors: gradientColors(for: condition),
            startPoint: .top,
            endPoint: .bottom
        )
    }

    private func gradientColors(for condition: WeatherCondition) -> [Color] {
        switch condition {
        case .clear:
            return [Color(red: 0.30, green: 0.60, blue: 0.90), Color(red: 0.40, green: 0.65, blue: 0.85)]
        case .cloudy:
            return [Color(red: 0.55, green: 0.6, blue: 0.7), Color(red: 0.4, green: 0.45, blue: 0.55)]
        case .raining:
            return [Color(red: 0.25, green: 0.3, blue: 0.4), Color(red: 0.1, green: 0.12, blue: 0.25)]
        case .rainingNight:
            return [Color(red: 0.12, green: 0.14, blue: 0.28), Color(red: 0.08, green: 0.08, blue: 0.18)]
        case .snowing:
            return [Color(red: 0.55, green: 0.60, blue: 0.72), Color(red: 0.50, green: 0.55, blue: 0.65)]
        case .snowingNight:
            return [Color(red: 0.22, green: 0.25, blue: 0.35), Color(red: 0.15, green: 0.18, blue: 0.28)]
        case .night:
            return [Color(red: 0.12, green: 0.1, blue: 0.25), Color(red: 0.05, green: 0.04, blue: 0.1)]
        }
    }
}
