import SwiftUI

struct RainDrop {
    var x: CGFloat
    var y: CGFloat
    var speed: CGFloat
    var opacity: Double
    var length: CGFloat
}

final class RainState {
    var drops: [RainDrop] = []
    var lastUpdate: Date = .now

    func setup(count: Int, width: CGFloat, height: CGFloat) {
        guard drops.isEmpty else { return }
        drops = (0..<count).map { _ in
            RainDrop(
                x: .random(in: 0...width),
                y: .random(in: -50...height),
                speed: .random(in: 8...16),
                opacity: .random(in: 0.2...0.5),
                length: .random(in: 10...25)
            )
        }
        lastUpdate = .now
    }

    func update(now: Date, width: CGFloat, height: CGFloat) {
        let dt = now.timeIntervalSince(lastUpdate)
        lastUpdate = now
        let scale = CGFloat(dt * 60)
        for i in drops.indices {
            drops[i].y += drops[i].speed * scale
            if drops[i].y > height + 30 {
                drops[i].y = .random(in: -50 ... -5)
                drops[i].x = .random(in: 0...width)
            }
        }
    }
}

struct RainAnimationView: View {
    let intensity: PrecipitationIntensity

    @State private var state = RainState()
    @State private var lastIntensity: PrecipitationIntensity?

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
            TimelineView(.animation) { timeline in
                Canvas { context, size in
                    if intensity != lastIntensity {
                        state.drops = []
                        DispatchQueue.main.async { lastIntensity = intensity }
                    }
                    state.setup(count: dropCount, width: size.width, height: size.height)
                    state.update(now: timeline.date, width: size.width, height: size.height)

                    for drop in state.drops {
                        let rect = CGRect(
                            x: drop.x - 0.75,
                            y: drop.y,
                            width: 1.5,
                            height: drop.length
                        )
                        context.opacity = drop.opacity
                        context.fill(
                            Path(roundedRect: rect, cornerRadius: 1),
                            with: .color(.white.opacity(0.5))
                        )
                    }
                }
                .id(timeline.date)
            }
        }
        .allowsHitTesting(false)
    }
}
