import ActivityKit
import SwiftUI
import WidgetKit

// Palette from docs/design/live-activity/rain-mockup-v3.html
private enum LA {
    static let cyan = Color(red: 0x54 / 255, green: 0xC3 / 255, blue: 0xF5 / 255)
    static let cyanDeep = Color(red: 0x38 / 255, green: 0xAD / 255, blue: 0xE7 / 255)
    static let bgTop = Color(red: 0x28 / 255, green: 0x39 / 255, blue: 0x4F / 255)
    static let bgBottom = Color(red: 0x15 / 255, green: 0x23 / 255, blue: 0x3D / 255)
    static let flagBlue = Color(red: 0x9D / 255, green: 0xDC / 255, blue: 0xFF / 255)
    static let compactCyan = Color(red: 0xCF / 255, green: 0xEE / 255, blue: 0xFF / 255)

    static var background: LinearGradient {
        LinearGradient(colors: [bgTop, bgBottom], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static var segmentFill: LinearGradient {
        LinearGradient(colors: [cyan, cyanDeep], startPoint: .leading, endPoint: .trailing)
    }
}

struct RainLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RainActivityAttributes.self) { context in
            LockScreenActivityView(state: context.state)
                .activityBackgroundTint(LA.bgBottom)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        DropGlyph(size: 16)
                        Text(context.state.statusText)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HeroCountdownText(state: context.state, fontSize: 18)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    SlimTrackView(state: context.state)
                        .padding(.horizontal, 4)
                        .padding(.top, 10)
                }
            } compactLeading: {
                DropGlyph(size: 15)
            } compactTrailing: {
                CompactCountdownText(state: context.state)
            } minimal: {
                DropGlyph(size: 15)
            }
            .keylineTint(LA.cyan)
        }
    }
}

// MARK: - Lock screen

private struct LockScreenActivityView: View {
    let state: RainActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
            heroRow
                .padding(.top, 11)
            SlimTrackView(state: state)
                .padding(.top, 18)
                .padding(.horizontal, 4)
        }
        .padding(.init(top: 14, leading: 16, bottom: 16, trailing: 16))
        .background(LA.background)
    }

    private var headerRow: some View {
        HStack(spacing: 7) {
            // The app icon itself, not a stand-in: this slot is the activity's
            // identity badge, so it shows the same tile the home screen does.
            AppIconTile(size: 20)
            Text("Gonna Rain?")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.72))
            Spacer()
            HStack(spacing: 5) {
                Circle()
                    .fill(LA.cyan)
                    .frame(width: 6, height: 6)
                    .shadow(color: LA.cyan, radius: 3.5)
                Text(state.statusText)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    private var heroRow: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HeroCountdownText(state: state, fontSize: 31)
                contextLine
            }
            Spacer()
            Text(state.rightText)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.55))
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }

    private var contextLine: some View {
        let bold = Text(state.subBold)
            .fontWeight(.semibold)
            .foregroundColor(.white)
        let rest = Text(state.subRest)
            .fontWeight(.medium)
            .foregroundColor(.white.opacity(0.72))
        return (state.boldFirst ? bold + rest : rest + bold)
            .font(.system(size: 13))
            .lineLimit(1)
    }
}

// MARK: - Hero countdown

/// Big ticking countdown ("12:34" + "min") when there's a target, else the
/// static hero word ("Showers").
private struct HeroCountdownText: View {
    let state: RainActivityAttributes.ContentState
    let fontSize: CGFloat

    var body: some View {
        if let target = state.countdownTarget, target > .now {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                // No .fixedSize here: forcing ideal-width measurement of the
                // auto-ticking timer text crashes the extension's layout pass.
                // Cap generously and scale down rather than truncate or wrap.
                Text(timerInterval: Date.now...target, countsDown: true, showsHours: false)
                    .font(.system(size: fontSize, weight: .heavy))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: fontSize * 3.4, alignment: .leading)
                Text("min")
                    .font(.system(size: fontSize * 0.52, weight: .bold))
                    .foregroundStyle(.white.opacity(0.72))
            }
        } else {
            Text(state.heroText ?? state.statusText)
                .font(.system(size: fontSize * 0.84, weight: .heavy))
                .foregroundStyle(.white)
        }
    }
}

private struct CompactCountdownText: View {
    let state: RainActivityAttributes.ContentState

    var body: some View {
        if let target = state.countdownTarget, target > .now {
            Text(timerInterval: Date.now...target, countsDown: true, showsHours: false)
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(LA.compactCyan)
                .frame(maxWidth: 46)
                .multilineTextAlignment(.trailing)
        } else {
            Image(systemName: "cloud.rain.fill")
                .font(.system(size: 12))
                .foregroundStyle(LA.compactCyan)
        }
    }
}

/// The Dynamic Island's precipitation glyph. This slot is deliberately NOT the
/// app icon: it says what the weather is doing, not whose app is saying it, so
/// `release-1.1.1-wintry-live-activity` can keep swapping it for a snowflake on
/// wintry activities. App identity lives on the lock-screen header badge only —
/// see `LockScreenActivityView.headerRow`.
private struct DropGlyph: View {
    let size: CGFloat

    var body: some View {
        Image(systemName: "drop.fill")
            .font(.system(size: size))
            .foregroundStyle(LA.cyan)
    }
}

// MARK: - Slim track

/// The thin Uber-style timeline: grey rail, cyan stretches where it rains,
/// faint hour dots, a white "now" dot, labels below, optional time flag above.
private struct SlimTrackView: View {
    let state: RainActivityAttributes.ContentState

    private var hourFractions: [Double] {
        guard state.windowMinutes >= 60 else { return [] }
        return stride(from: 60, to: state.windowMinutes, by: 60)
            .map { Double($0) / Double(state.windowMinutes) }
    }

    private func isWet(_ fraction: Double) -> Bool {
        state.segments.contains { fraction >= $0.start && fraction <= $0.end }
    }

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                let w = geo.size.width
                ZStack(alignment: .leading) {
                    // flag above the track
                    if let flag = state.flagText, let pos = state.flagPosition {
                        Text(flag)
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(LA.flagBlue)
                            .fixedSize()
                            .position(x: min(max(pos * w, 12), w - 12), y: 0)
                    }
                    // rail
                    Capsule()
                        .fill(.white.opacity(0.15))
                        .frame(height: 4)
                        .offset(y: 6)
                    // cyan segments
                    ForEach(Array(state.segments.enumerated()), id: \.offset) { _, seg in
                        Capsule()
                            .fill(LA.segmentFill)
                            .frame(width: max((seg.end - seg.start) * w, 4), height: 4)
                            .shadow(color: LA.cyan.opacity(0.55), radius: 4.5)
                            .offset(x: seg.start * w, y: 6)
                    }
                    // hour dots
                    ForEach(hourFractions, id: \.self) { f in
                        Circle()
                            .fill(isWet(f) ? LA.cyan : .white.opacity(0.4))
                            .frame(width: 3, height: 3)
                            .shadow(color: isWet(f) ? LA.cyan : .clear, radius: 3.5)
                            .position(x: f * w, y: 8)
                    }
                    // now dot (window always starts at now)
                    Circle()
                        .fill(.white)
                        .frame(width: 10, height: 10)
                        .background {
                            Circle()
                                .stroke(.white.opacity(0.22), lineWidth: 3)
                        }
                        .shadow(color: .black.opacity(0.45), radius: 1.5, y: 1)
                        .position(x: 5, y: 8)
                }
            }
            .frame(height: 16)
            HStack {
                Text("Now")
                Spacer()
                Text(state.midLabel)
                Spacer()
                Text(state.endLabel)
            }
            .font(.system(size: 9.5, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(.white.opacity(0.4))
            .padding(.top, 5)
        }
    }
}
