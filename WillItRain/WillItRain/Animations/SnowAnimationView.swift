import SwiftUI

struct Snowflake: Identifiable {
    let id = UUID()
    var x: CGFloat
    var y: CGFloat
    var speed: Double
    var opacity: Double
    var size: CGFloat
    var wobble: CGFloat
    var wobbleSpeed: Double
    var phase: Double
}

struct SnowAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var flakes: [Snowflake] = []
    @State private var timer: Timer?
    @State private var elapsed: Double = 0

    private var flakeCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 25
        case .moderate: return 50
        case .heavy: return 80
        }
    }

    var body: some View {
        Canvas { context, size in
            for flake in flakes {
                let rect = CGRect(
                    x: flake.x + sin(elapsed * flake.wobbleSpeed + flake.phase) * flake.wobble,
                    y: flake.y,
                    width: flake.size,
                    height: flake.size
                )
                context.opacity = flake.opacity
                context.fill(
                    Path(ellipseIn: rect),
                    with: .color(.white.opacity(0.8))
                )
            }
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
        .onChange(of: intensity) { _ in resetFlakes() }
        .allowsHitTesting(false)
    }

    private func startAnimation() {
        resetFlakes()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in
            elapsed += 1.0 / 60.0
            updateFlakes()
        }
    }

    private func resetFlakes() {
        flakes = (0..<flakeCount).map { _ in
            Snowflake(
                x: CGFloat.random(in: 0...UIScreen.main.bounds.width),
                y: CGFloat.random(in: -50...UIScreen.main.bounds.height),
                speed: Double.random(in: 1.5...4),
                opacity: Double.random(in: 0.3...0.7),
                size: CGFloat.random(in: 3...8),
                wobble: CGFloat.random(in: 10...30),
                wobbleSpeed: Double.random(in: 0.5...2),
                phase: Double.random(in: 0...(.pi * 2))
            )
        }
    }

    private func updateFlakes() {
        let height = UIScreen.main.bounds.height
        let width = UIScreen.main.bounds.width
        for i in flakes.indices {
            flakes[i].y += CGFloat(flakes[i].speed)
            if flakes[i].y > height + 20 {
                flakes[i].y = CGFloat.random(in: -40 ... -5)
                flakes[i].x = CGFloat.random(in: 0...width)
            }
        }
    }
}
