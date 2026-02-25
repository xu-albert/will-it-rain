import SwiftUI

struct WeeklyForecastView: View {
    let days: [DaySummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("7-Day Forecast")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 16)

            VStack(spacing: 0) {
                ForEach(days) { day in
                    dayRow(day)
                    if day.id != days.last?.id {
                        Divider()
                            .background(Color.white.opacity(0.1))
                            .padding(.horizontal, 16)
                    }
                }
            }
        }
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial.opacity(0.3))
                .padding(.horizontal, 8)
        )
    }

    private func dayRow(_ day: DaySummary) -> some View {
        HStack {
            Text(day.dayName)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white)
                .frame(width: 70, alignment: .leading)

            Image(systemName: day.type == .none ? "sun.max.fill" : day.type.icon)
                .font(.system(size: 14))
                .foregroundColor(day.type == .none ? .yellow.opacity(0.8) : .cyan)
                .frame(width: 24)

            // Precipitation chance bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 6)

                    RoundedRectangle(cornerRadius: 3)
                        .fill(day.precipChance > 0.5 ? Color.cyan : Color.cyan.opacity(0.5))
                        .frame(width: max(0, geo.size.width * day.precipChance), height: 6)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }

            Text("\(Int(day.precipChance * 100))%")
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundColor(day.precipChance > 0 ? .white : .white.opacity(0.4))
                .frame(width: 38, alignment: .trailing)

            if let hi = day.highTemp, let lo = day.lowTemp {
                Text("\(Int(lo))° / \(Int(hi))°")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.5))
                    .frame(width: 70, alignment: .trailing)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
