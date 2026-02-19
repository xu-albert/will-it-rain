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
            return [Color(red: 0.53, green: 0.81, blue: 0.98), Color(red: 0.95, green: 0.97, blue: 1.0)]
        case .cloudy:
            return [Color(red: 0.55, green: 0.6, blue: 0.7), Color(red: 0.4, green: 0.45, blue: 0.55)]
        case .raining:
            return [Color(red: 0.25, green: 0.3, blue: 0.4), Color(red: 0.1, green: 0.12, blue: 0.25)]
        case .snowing:
            return [Color(red: 0.85, green: 0.88, blue: 0.92), Color(red: 0.65, green: 0.7, blue: 0.78)]
        case .night:
            return [Color(red: 0.12, green: 0.1, blue: 0.25), Color(red: 0.05, green: 0.04, blue: 0.1)]
        }
    }
}
