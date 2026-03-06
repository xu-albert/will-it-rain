import SwiftUI

struct RainStatusView: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 36, weight: .bold, design: .default))
                .foregroundColor(.white)
                .shadow(color: .black.opacity(0.3), radius: 6, y: 2)

            Text(subtitle)
                .font(.system(size: 18, weight: .medium, design: .default))
                .foregroundColor(.white.opacity(0.85))
                .shadow(color: .black.opacity(0.25), radius: 4, y: 1)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
    }
}
