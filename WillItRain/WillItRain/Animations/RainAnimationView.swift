import SwiftUI

struct RainDrop: Identifiable {
    let id = UUID()
    var x: CGFloat
    var y: CGFloat
    var speed: Double
    var opacity: Double
    var length: CGFloat
}

struct RainAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var drops: [RainDrop] = []
    @State private var timer: Timer?

    private var dropCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 30
        case .moderate: return 60
        case .heavy: return 100
        }
    }

    var body: some View {
        Canvas { context, size in
            for drop in drops {
                let rect = CGRect(x: drop.x, y: drop.y, width: 1.5, height: drop.length)
                context.opacity = drop.opacity
                context.fill(
                    Path(roundedRect: rect, cornerRadius: 1),
                    with: .color(.white.opacity(0.6))
                )
            }
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
        .onChange(of: intensity) { _ in resetDrops() }
        .allowsHitTesting(false)
    }

    private func startAnimation() {
        resetDrops()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in
            updateDrops()
        }
    }

    private func resetDrops() {
        drops = (0..<dropCount).map { _ in
            RainDrop(
                x: CGFloat.random(in: 0...UIScreen.main.bounds.width),
                y: CGFloat.random(in: -100...UIScreen.main.bounds.height),
                speed: Double.random(in: 8...15),
                opacity: Double.random(in: 0.2...0.5),
                length: CGFloat.random(in: 10...25)
            )
        }
    }

    private func updateDrops() {
        let height = UIScreen.main.bounds.height
        let width = UIScreen.main.bounds.width
        for i in drops.indices {
            drops[i].y += CGFloat(drops[i].speed)
            if drops[i].y > height + 30 {
                drops[i].y = CGFloat.random(in: -80 ... -10)
                drops[i].x = CGFloat.random(in: 0...width)
            }
        }
    }
}
