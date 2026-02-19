import SwiftUI

struct RainAnimationView: View {
    let intensity: PrecipitationIntensity

    private var dropCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 30
        case .moderate: return 60
        case .heavy: return 100
        }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                ForEach(0..<dropCount, id: \.self) { i in
                    RainDropView(
                        containerWidth: geo.size.width,
                        containerHeight: geo.size.height
                    )
                }
            }
        }
        .allowsHitTesting(false)
    }
}

struct RainDropView: View {
    let containerWidth: CGFloat
    let containerHeight: CGFloat

    @State private var yOffset: CGFloat = 0
    @State private var xPos: CGFloat = 0
    @State private var opacity: Double = 0.3
    @State private var length: CGFloat = 15
    @State private var started = false

    private var duration: Double { .random(in: 0.4...0.9) }

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.white.opacity(0.5))
            .frame(width: 1.5, height: length)
            .opacity(opacity)
            .position(x: xPos, y: yOffset)
            .onAppear {
                xPos = .random(in: 0...containerWidth)
                opacity = .random(in: 0.2...0.5)
                length = .random(in: 10...25)
                // Start at random y so they don't all begin at top
                let startY = CGFloat.random(in: -50...containerHeight)
                yOffset = startY
                started = true
                startFalling()
            }
    }

    private func startFalling() {
        let fallDuration = Double.random(in: 0.4...0.9)
        withAnimation(.linear(duration: fallDuration)) {
            yOffset = containerHeight + 30
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + fallDuration) {
            // Reset to top without animation
            withAnimation(.none) {
                yOffset = .random(in: -50 ... -10)
                xPos = .random(in: 0...containerWidth)
            }
            // Fall again
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) {
                startFalling()
            }
        }
    }
}
