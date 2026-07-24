import SwiftUI

/// Apple Weather attribution required by App Store Guideline 5.2.5.
/// Displays the "Weather" trademark and links to the legal source page.
/// Designed to be legible on both light (clear-day) and dark (rain) backgrounds.
struct AttributionView: View {
    private let legalURL = URL(string: "https://weatherkit.apple.com/legal-attribution.html")!

    var body: some View {
        Link(destination: legalURL) {
            HStack(spacing: 4) {
                Image(systemName: "apple.logo")
                    .font(.system(size: 13))
                Text("Weather")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Color.black.opacity(0.28))
            )
        }
        .accessibilityLabel("Apple Weather. Legal attribution.")
    }
}
