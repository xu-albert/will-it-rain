import SwiftUI

struct HailStone {
    var x: CGFloat
    var y: CGFloat
    var speedY: CGFloat
    var speedX: CGFloat
    var opacity: Double
    var size: CGFloat
    var bouncing: Bool
    var bounceVelocity: CGFloat
}

final class HailState {
    var stones: [HailStone] = []
    var lastUpdate: Date = .now

    func setup(count: Int, width: CGFloat, height: CGFloat) {
        guard stones.isEmpty else { return }
        stones = (0..<count).map { _ in
            HailStone(
                x: .random(in: 0...width),
                y: .random(in: -80...height),
                speedY: .random(in: 10...18),
                speedX: .random(in: -1...1),
                opacity: .random(in: 0.4...0.8),
                size: .random(in: 4...9),
                bouncing: false,
                bounceVelocity: 0
            )
        }
        lastUpdate = .now
    }

    func update(now: Date, width: CGFloat, height: CGFloat) {
        let dt = now.timeIntervalSince(lastUpdate)
        lastUpdate = now
        let scale = CGFloat(dt * 60)
        let ground = height * 0.85

        for i in stones.indices {
            if stones[i].bouncing {
                stones[i].y -= stones[i].bounceVelocity * scale
                stones[i].bounceVelocity -= 0.8 * scale
                stones[i].x += stones[i].speedX * 2 * scale
                if stones[i].bounceVelocity < -stones[i].speedY {
                    stones[i].y = .random(in: -80 ... -10)
                    stones[i].x = .random(in: 0...width)
                    stones[i].bouncing = false
                }
            } else {
                stones[i].y += stones[i].speedY * scale
                stones[i].x += stones[i].speedX * scale
                if stones[i].y >= ground {
                    stones[i].bouncing = true
                    stones[i].bounceVelocity = stones[i].speedY * 0.4
                }
            }
        }
    }
}

struct HailAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var state = HailState()

    private var stoneCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 20
        case .moderate: return 40
        case .heavy: return 65
        }
    }

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation) { timeline in
                Canvas { context, size in
                    state.setup(count: stoneCount, width: size.width, height: size.height)
                    state.update(now: timeline.date, width: size.width, height: size.height)

                    for stone in state.stones {
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
                .id(timeline.date)
            }
        }
        .allowsHitTesting(false)
    }
}
