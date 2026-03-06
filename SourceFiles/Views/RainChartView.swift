import SwiftUI
import Charts

struct RainChartView: View {
    let dataPoints: [ChartDataPoint]
    let chartHours: Int

    private var nextHourPoints: [ChartDataPoint] {
        let cutoff = Date().addingTimeInterval(3600)
        return dataPoints.filter { $0.date <= cutoff }
    }

    private var hourlyPoints: [ChartDataPoint] {
        let oneHour = Date().addingTimeInterval(3600)
        let cutoff = Date().addingTimeInterval(TimeInterval(chartHours * 3600))
        let candidates = dataPoints.filter { $0.date >= oneHour && $0.date <= cutoff }
        // Keep only one point per hour to avoid clustering
        var seen = Set<Int>()
        let calendar = Calendar.current
        return candidates.filter { point in
            let hour = calendar.component(.hour, from: point.date)
            let day = calendar.component(.day, from: point.date)
            let key = day * 100 + hour
            if seen.contains(key) { return false }
            seen.insert(key)
            return true
        }
    }

    var body: some View {
        VStack(spacing: 20) {
            if !nextHourPoints.isEmpty {
                chartSection(
                    title: "Next Hour",
                    subtitle: "Minute-by-minute",
                    points: nextHourPoints,
                    strideBy: .minute,
                    strideCount: 15,
                    barWidth: 2
                )
            }

            if !hourlyPoints.isEmpty {
                chartSection(
                    title: "Next \(chartHours) Hours",
                    subtitle: "Hourly",
                    points: hourlyPoints,
                    strideBy: .hour,
                    strideCount: 2,
                    barWidth: 6
                )
            }
        }
    }

    @ViewBuilder
    private func chartSection(title: String, subtitle: String, points: [ChartDataPoint], strideBy: Calendar.Component, strideCount: Int, barWidth: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white)
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.7))
                }
                Spacer()
                legend
            }
            .padding(.horizontal, 16)

            PrecipChart(points: points, strideBy: strideBy, strideCount: strideCount, barWidth: barWidth)
                .frame(height: 150)
                .padding(.horizontal, 16)
        }
        .padding(.vertical, 12)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.black.opacity(0.15))
                RoundedRectangle(cornerRadius: 16)
                    .fill(.ultraThinMaterial.opacity(0.5))
            }
            .padding(.horizontal, 8)
        )
    }

    private var legend: some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 2).fill(Color.cyan.opacity(0.6)).frame(width: 10, height: 8)
                Text("Intensity").font(.system(size: 10)).foregroundColor(.white.opacity(0.7))
            }
            HStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 1).fill(Color.white).frame(width: 10, height: 2)
                Text("Chance").font(.system(size: 10)).foregroundColor(.white.opacity(0.7))
            }
        }
    }
}

struct PrecipChart: View {
    let points: [ChartDataPoint]
    let strideBy: Calendar.Component
    let strideCount: Int
    let barWidth: CGFloat

    @State private var selectedPoint: ChartDataPoint?

    var body: some View {
        VStack(spacing: 4) {
            if let selected = selectedPoint {
                tooltipRow(selected)
            } else {
                Color.clear.frame(height: 18)
            }

            chartContent
        }
    }

    private func tooltipRow(_ point: ChartDataPoint) -> some View {
        HStack(spacing: 8) {
            Text(timeString(point.date))
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white)
            Text("\(Int(point.probability * 100))% chance")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.7))
            if point.intensity != .none {
                Text(point.intensity.rawValue.lowercased())
                    .font(.system(size: 12))
                    .foregroundColor(.cyan)
            }
        }
        .frame(height: 18)
    }

    private var chartContent: some View {
        Chart {
            intensityBars
            chanceLine
            nowLine
            selectionMarks
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: strideBy, count: strideCount)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                    .foregroundStyle(.white.opacity(0.1))
                AxisValueLabel(format: strideBy == .minute ? .dateTime.hour().minute() : .dateTime.hour(.defaultDigits(amPM: .abbreviated)))
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: [0, 25, 50, 75, 100]) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3))
                    .foregroundStyle(.white.opacity(0.12))
                AxisValueLabel {
                    if let v = value.as(Int.self) {
                        Text("\(v)%")
                            .font(.system(size: 9))
                            .foregroundColor(.white.opacity(0.55))
                    }
                }
            }
        }
        .chartYScale(domain: 0...100)
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle()
                    .fill(Color.clear)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                let plotArea = proxy.plotAreaSize
                                let plotOrigin = CGPoint(
                                    x: geo.size.width - plotArea.width,
                                    y: 0
                                )
                                let xInPlot = value.location.x - plotOrigin.x
                                guard let date: Date = proxy.value(atX: xInPlot) else { return }
                                selectedPoint = points.min(by: {
                                    abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date))
                                })
                            }
                            .onEnded { _ in
                                selectedPoint = nil
                            }
                    )
            }
        }
    }

    @ChartContentBuilder
    private var intensityBars: some ChartContent {
        ForEach(points) { point in
            BarMark(
                x: .value("Time", point.date),
                y: .value("Intensity", intensityPercent(point.intensity)),
                width: .fixed(barWidth)
            )
            .foregroundStyle(
                LinearGradient(
                    colors: [Color.cyan.opacity(0.7), Color.cyan.opacity(0.3)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 1))
        }
    }

    @ChartContentBuilder
    private var chanceLine: some ChartContent {
        ForEach(points) { point in
            LineMark(
                x: .value("Time", point.date),
                y: .value("Chance", point.probability * 100)
            )
            .foregroundStyle(.white.opacity(0.8))
            .lineStyle(StrokeStyle(lineWidth: 2))
            .interpolationMethod(.catmullRom)
        }
    }

    @ChartContentBuilder
    private var nowLine: some ChartContent {
        RuleMark(x: .value("Now", Date()))
            .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            .foregroundStyle(.white.opacity(0.5))
    }

    @ChartContentBuilder
    private var selectionMarks: some ChartContent {
        if let selected = selectedPoint {
            RuleMark(x: .value("Sel", selected.date))
                .lineStyle(StrokeStyle(lineWidth: 1))
                .foregroundStyle(.white.opacity(0.25))
        }
    }

    private func intensityPercent(_ intensity: PrecipitationIntensity) -> Double {
        switch intensity {
        case .none: return 0
        case .light: return 33
        case .moderate: return 66
        case .heavy: return 100
        }
    }

    private func timeString(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f.string(from: date)
    }

}
