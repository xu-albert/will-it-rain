import SwiftUI

struct WeeklyForecastView: View {
    let days: [DaySummary]
    var useCelsius: Bool = false

    private let barMaxHeight: CGFloat = 80

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("7-Day Rain Chance")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 16)

            HStack(alignment: .bottom, spacing: 0) {
                ForEach(days) { day in
                    VStack(spacing: 6) {
                        Text("\(Int(day.precipChance * 100))%")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundColor(day.precipChance > 0 ? .white : .white.opacity(0.35))

                        RoundedRectangle(cornerRadius: 4)
                            .fill(barColor(for: day.precipChance))
                            .frame(height: max(4, barMaxHeight * day.precipChance))

                        Image(systemName: day.type == .none ? "sun.max.fill" : day.type.icon)
                            .font(.system(size: 12))
                            .foregroundColor(day.type == .none ? .yellow.opacity(0.8) : .cyan)

                        if let high = day.highTemp {
                            Text("\(displayTemp(high))°")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.white.opacity(0.6))
                        }

                        Text(day.dayName.prefix(3))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.white.opacity(0.7))
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
        }
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial.opacity(0.3))
                .padding(.horizontal, 8)
        )
    }

    private func displayTemp(_ celsius: Double) -> Int {
        if useCelsius {
            return Int(celsius.rounded())
        } else {
            return Int((celsius * 9 / 5 + 32).rounded())
        }
    }

    private func barColor(for chance: Double) -> Color {
        if chance > 0.6 {
            return .cyan
        } else if chance > 0.3 {
            return .cyan.opacity(0.6)
        } else if chance > 0 {
            return .cyan.opacity(0.35)
        } else {
            return .white.opacity(0.08)
        }
    }
}
