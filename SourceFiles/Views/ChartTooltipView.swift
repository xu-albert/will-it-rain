import SwiftUI

struct ChartTooltipView: View {
    let dataPoint: ChartDataPoint
    let position: CGPoint

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(timeString)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white)

            Text("\(Int(dataPoint.probability * 100))% \u{00B7} \(dataPoint.intensity.rawValue) \(dataPoint.type.rawValue.lowercased())")
                .font(.system(size: 12, weight: .regular))
                .foregroundColor(.white.opacity(0.85))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.black.opacity(0.75))
        )
        .position(x: position.x, y: position.y - 50)
    }

    private var timeString: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: dataPoint.date)
    }
}
