import SwiftUI

struct HailStone: Identifiable {
    let id = UUID()
    var x: CGFloat
    var y: CGFloat
    var speedY: Double
    var speedX: Double
    var opacity: Double
    var size: CGFloat
    var bouncing: Bool
    var bounceVelocity: Double
}

struct HailAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var stones: [HailStone] = []
    @State private var timer: Timer?

    private var stoneCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 20
        case .moderate: return 40
        case .heavy: return 65
        }
    }

    var body: some View {
        Canvas { context, size in
            for stone in stones {
                let rect = CGRect(
                    x: stone.x - stone.size / 2,
                    y: stone.y - stone.size / 2,
                    width: stone.size,
                    height: stone.size
                )
                context.opacity = stone.opacity
                context.fill(
                    Path(ellipseIn: rect),
                    with: .color(.white.opacity(0.9))
                )
            }
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
        .onChange(of: intensity) { _ in resetStones() }
        .allowsHitTesting(false)
    }

    private func startAnimation() {
        resetStones()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in
            updateStones()
        }
    }

    private func resetStones() {
        stones = (0..<stoneCount).map { _ in
            HailStone(
                x: CGFloat.random(in: 0...UIScreen.main.bounds.width),
                y: CGFloat.random(in: -80...UIScreen.main.bounds.height),
                speedY: Double.random(in: 10...18),
                speedX: Double.random(in: -1...1),
                opacity: Double.random(in: 0.4...0.8),
                size: CGFloat.random(in: 4...9),
                bouncing: false,
                bounceVelocity: 0
            )
        }
    }

    private func updateStones() {
        let height = UIScreen.main.bounds.height
        let width = UIScreen.main.bounds.width
        let ground = height * 0.85

        for i in stones.indices {
            if stones[i].bouncing {
                stones[i].y -= CGFloat(stones[i].bounceVelocity)
                stones[i].bounceVelocity -= 0.8
                stones[i].x += CGFloat(stones[i].speedX * 2)
                if stones[i].bounceVelocity < -stones[i].speedY {
                    stones[i].y = CGFloat.random(in: -80 ... -10)
                    stones[i].x = CGFloat.random(in: 0...width)
                    stones[i].bouncing = false
                }
            } else {
                stones[i].y += CGFloat(stones[i].speedY)
                stones[i].x += CGFloat(stones[i].speedX)
                if stones[i].y >= ground {
                    stones[i].bouncing = true
                    stones[i].bounceVelocity = stones[i].speedY * 0.4
                }
            }
        }
    }
}
