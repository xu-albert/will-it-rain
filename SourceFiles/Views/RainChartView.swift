import SwiftUI
import Charts

struct RainChartView: View {
    let dataPoints: [ChartDataPoint]
    let chartHours: Int

    @State private var selectedPoint: ChartDataPoint?
    @State private var tooltipPosition: CGPoint = .zero

    private var filteredPoints: [ChartDataPoint] {
        let cutoff = Date().addingTimeInterval(TimeInterval(chartHours * 3600))
        return dataPoints.filter { $0.date <= cutoff }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Chart {
                // Probability background fill
                ForEach(filteredPoints) { point in
                    AreaMark(
                        x: .value("Time", point.date),
                        y: .value("Probability", point.probability * 3) // Scale to match intensity axis
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Color.blue.opacity(0.15), Color.blue.opacity(0.05)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }

                // Intensity foreground fill
                ForEach(filteredPoints) { point in
                    AreaMark(
                        x: .value("Time", point.date),
                        y: .value("Intensity", point.intensity.numericValue)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [intensityColor(point.type).opacity(0.7), intensityColor(point.type).opacity(0.3)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }

                // "Now" rule line
                RuleMark(x: .value("Now", Date()))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(.white.opacity(0.6))

                // Selected point indicator
                if let selected = selectedPoint {
                    PointMark(
                        x: .value("Time", selected.date),
                        y: .value("Intensity", selected.intensity.numericValue)
                    )
                    .foregroundStyle(.white)
                    .symbolSize(40)
                }
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .hour)) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                        .foregroundStyle(.white.opacity(0.15))
                    AxisValueLabel {
                        if let date = value.as(Date.self) {
                            Text(hourLabel(date))
                                .font(.system(size: 11))
                                .foregroundColor(.white.opacity(0.6))
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(values: [0, 1, 2, 3]) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                        .foregroundStyle(.white.opacity(0.1))
                    AxisValueLabel {
                        if let v = value.as(Int.self) {
                            Text(intensityLabel(v))
                                .font(.system(size: 10))
                                .foregroundColor(.white.opacity(0.5))
                        }
                    }
                }
            }
            .chartYScale(domain: 0...3.5)
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle()
                        .fill(Color.clear)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { value in
                                    let x = value.location.x
                                    guard let date: Date = proxy.value(atX: x) else { return }
                                    if let closest = filteredPoints.min(by: {
                                        abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date))
                                    }) {
                                        selectedPoint = closest
                                        tooltipPosition = value.location
                                    }
                                }
                                .onEnded { _ in
                                    selectedPoint = nil
                                }
                        )
                }
            }
            .frame(height: 180)
            .padding(.horizontal, 16)

            if let selected = selectedPoint {
                ChartTooltipView(dataPoint: selected, position: tooltipPosition)
            }
        }
    }

    private func intensityColor(_ type: PrecipitationType) -> Color {
        switch type {
        case .snow: return .white
        case .hail: return .gray
        default: return .blue
        }
    }

    private func hourLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "ha"
        return formatter.string(from: date).lowercased()
    }

    private func intensityLabel(_ value: Int) -> String {
        switch value {
        case 0: return ""
        case 1: return "Light"
        case 2: return "Mod"
        case 3: return "Heavy"
        default: return ""
        }
    }
}
