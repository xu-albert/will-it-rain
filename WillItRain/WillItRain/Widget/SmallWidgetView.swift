import SwiftUI
import WidgetKit

struct SmallWidgetView: View {
    let entry: RainWidgetEntry

    var body: some View {
        ZStack {
            gradientBackground(for: entry.condition)

            VStack(spacing: 8) {
                Image(systemName: entry.precipType.icon)
                    .font(.system(size: 32))
                    .foregroundColor(.white)

                Text(entry.statusText)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .padding()
        }
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
