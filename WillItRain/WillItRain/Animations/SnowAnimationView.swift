import SwiftUI

struct Snowflake {
    var x: CGFloat
    var y: CGFloat
    var speed: CGFloat
    var opacity: Double
    var size: CGFloat
    var wobble: CGFloat
    var wobbleSpeed: Double
    var phase: Double
}

final class SnowState {
    var flakes: [Snowflake] = []
    var lastUpdate: Date = .now
    var elapsed: Double = 0

    func setup(count: Int, width: CGFloat, height: CGFloat) {
        guard flakes.isEmpty else { return }
        flakes = (0..<count).map { _ in
            Snowflake(
                x: .random(in: 0...width),
                y: .random(in: -50...height),
                speed: .random(in: 1.5...4),
                opacity: .random(in: 0.3...0.7),
                size: .random(in: 3...8),
                wobble: .random(in: 10...30),
                wobbleSpeed: .random(in: 0.5...2),
                phase: .random(in: 0...(.pi * 2))
            )
        }
        lastUpdate = .now
    }

    func update(now: Date, width: CGFloat, height: CGFloat) {
        let dt = now.timeIntervalSince(lastUpdate)
        lastUpdate = now
        elapsed += dt
        let scale = CGFloat(dt * 60)
        for i in flakes.indices {
            flakes[i].y += flakes[i].speed * scale
            if flakes[i].y > height + 20 {
                flakes[i].y = .random(in: -40 ... -5)
                flakes[i].x = .random(in: 0...width)
            }
        }
    }
}

struct SnowAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var state = SnowState()
    @State private var lastIntensity: PrecipitationIntensity?

    private var flakeCount: Int {
        switch intensity {
        case .none: return 0
        case .light: return 25
        case .moderate: return 50
        case .heavy: return 80
        }
    }

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation) { timeline in
                Canvas { context, size in
                    if intensity != lastIntensity {
                        state.flakes = []
                        DispatchQueue.main.async { lastIntensity = intensity }
                    }
                    state.setup(count: flakeCount, width: size.width, height: size.height)
                    state.update(now: timeline.date, width: size.width, height: size.height)

                    for flake in state.flakes {
                        let xOffset = sin(state.elapsed * flake.wobbleSpeed + flake.phase) * flake.wobble
                        let rect = CGRect(
                            x: flake.x + xOffset,
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
                .id(timeline.date)
            }
        }
        .allowsHitTesting(false)
    }
}
