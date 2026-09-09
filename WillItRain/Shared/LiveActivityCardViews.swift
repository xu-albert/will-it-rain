import SwiftUI

// The Live Activity's visual layer, shared by both targets.
//
// The widget extension renders these for real. The app compiles them too, so a
// DEBUG harness can put the lock-screen card on screen and screenshot it —
// otherwise the card is only reachable by locking the device, and `simctl` has
// no lock command. Everything the wintry palette touches (the track, its glow,
// the now-dot ring) lives on this card and nowhere in the Dynamic Island, so
// without this the palette could only be checked by eye against a mockup.
//
// Palette from docs/design/live-activity/rain-mockup-v3.html (rain) and
// snow-mockup-v3.html variant W1b (wintry); the decision record is
// docs/superpowers/specs/2026-07-27-wintry-live-activity-design.md.

enum LACardPalette {
    static let bgTop = Color(red: 0x28 / 255, green: 0x39 / 255, blue: 0x4F / 255)
    static let bgBottom = Color(red: 0x15 / 255, green: 0x23 / 255, blue: 0x3D / 255)

    static var background: LinearGradient {
        LinearGradient(colors: [bgTop, bgBottom], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// Everything that differs between falling rain and falling snow. Resolved once
/// from the content state and threaded down, so adding a treatment later means
/// adding a case here rather than hunting for hard-coded cyan.
struct LAStyle {
    let accent: Color        // track head, status dot, keyline
    let accentDeep: Color    // track tail
    let glow: Color          // halo under the track, status dot, wet hour dots
    /// Ring around the white "now" dot. It exists to keep that dot legible where
    /// the track passes underneath it — which happens in the "falling now" state,
    /// where the segment starts at 0. The paler the track, the more this matters.
    let nowRing: Color
    let flag: Color          // the little time flag above the track
    let compact: Color       // Dynamic Island compact/minimal foreground
    let glyph: String        // SF Symbol

    var segmentFill: LinearGradient {
        LinearGradient(colors: [accent, accentDeep], startPoint: .leading, endPoint: .trailing)
    }

    static let rain = LAStyle(
        accent: Color(red: 0x54 / 255, green: 0xC3 / 255, blue: 0xF5 / 255),
        accentDeep: Color(red: 0x38 / 255, green: 0xAD / 255, blue: 0xE7 / 255),
        glow: Color(red: 0x54 / 255, green: 0xC3 / 255, blue: 0xF5 / 255),
        nowRing: .white.opacity(0.22),
        flag: Color(red: 0x9D / 255, green: 0xDC / 255, blue: 0xFF / 255),
        compact: Color(red: 0xCF / 255, green: 0xEE / 255, blue: 0xFF / 255),
        glyph: "drop.fill"
    )

    // "W1b" from docs/design/live-activity/snow-mockup-v3.html: a white glow with
    // the blue tint pulled almost out of the track, and a blue-grey ring rather
    // than a dark one — bright enough to read as snow, with the now-dot still
    // separating from a nearly white track.
    static let wintry = LAStyle(
        accent: .white,
        accentDeep: Color(red: 0xDC / 255, green: 0xE8 / 255, blue: 0xF0 / 255),
        glow: .white,
        nowRing: Color(red: 0xB0 / 255, green: 0xCB / 255, blue: 0xE0 / 255).opacity(0.75),
        flag: Color(red: 0xEA / 255, green: 0xF4 / 255, blue: 0xFF / 255),
        compact: Color(red: 0xE8 / 255, green: 0xF4 / 255, blue: 0xFC / 255),
        glyph: "snowflake"
    )

    /// A missing `precip` means the payload predates the field — treat it as
    /// rain, which is exactly how those payloads rendered before.
    static func of(_ state: RainActivityAttributes.ContentState) -> LAStyle {
        state.precip == .wintry ? .wintry : .rain
    }
}

// MARK: - Lock screen

struct LockScreenActivityView: View {
    let state: RainActivityAttributes.ContentState

    private var style: LAStyle { LAStyle.of(state) }

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
        .background(LACardPalette.background)
    }

    private var headerRow: some View {
        HStack(spacing: 7) {
            // The app icon itself, not a stand-in: this slot is the activity's
            // identity badge, so it shows the same tile the home screen does.
            // It is the one element the wintry treatment leaves alone — the
            // weather shows on the track and the island glyph, not on who is
            // reporting it.
            AppIconTile(size: 20)
            Text("Gonna Rain?")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.72))
            Spacer()
            HStack(spacing: 5) {
                Circle()
                    .fill(style.accent)
                    .frame(width: 6, height: 6)
                    .shadow(color: style.glow, radius: 3.5)
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
struct HeroCountdownText: View {
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

struct CompactCountdownText: View {
    let state: RainActivityAttributes.ContentState

    private var style: LAStyle { LAStyle.of(state) }

    var body: some View {
        if let target = state.countdownTarget, target > .now {
            Text(timerInterval: Date.now...target, countsDown: true, showsHours: false)
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(style.compact)
                .frame(maxWidth: 46)
                .multilineTextAlignment(.trailing)
        } else {
            Image(systemName: state.precip == .wintry ? "cloud.snow.fill" : "cloud.rain.fill")
                .font(.system(size: 12))
                .foregroundStyle(style.compact)
        }
    }
}

/// The Dynamic Island's precipitation glyph. This slot is deliberately NOT the
/// app icon: it says what the weather is doing, not whose app is saying it,
/// which is why it is the one that turns into a snowflake on a wintry activity.
/// App identity lives on the lock-screen header badge only — see
/// `LockScreenActivityView.headerRow`.
struct PrecipGlyph: View {
    let style: LAStyle
    let size: CGFloat

    var body: some View {
        Image(systemName: style.glyph)
            .font(.system(size: size))
            .foregroundStyle(style.accent)
    }
}

// MARK: - Slim track

/// The thin Uber-style timeline: grey rail, cyan stretches where it rains,
/// faint hour dots, a white "now" dot, labels below, optional time flag above.
struct SlimTrackView: View {
    let state: RainActivityAttributes.ContentState

    private var style: LAStyle { LAStyle.of(state) }

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
                            .foregroundStyle(style.flag)
                            .fixedSize()
                            .position(x: min(max(pos * w, 12), w - 12), y: 0)
                    }
                    // Rail and segments carry no y-offset on purpose. The ZStack
                    // centres them in this 16pt frame, i.e. on y=8 — the same
                    // line the hour dots and the "now" dot are positioned on.
                    // An earlier `.offset(y: 6)` hung the rail 6pt BELOW that
                    // line (measured on device: dot centre y=8, rail centre
                    // y=14), so the dots floated above the track instead of
                    // sitting on it, and the now-dot only grazed the segment it
                    // is supposed to sit inside. The mockups put all three on
                    // one line; so does this.
                    Capsule()
                        .fill(.white.opacity(0.15))
                        .frame(height: 4)
                    // precip segments
                    ForEach(Array(state.segments.enumerated()), id: \.offset) { _, seg in
                        Capsule()
                            .fill(style.segmentFill)
                            .frame(width: max((seg.end - seg.start) * w, 4), height: 4)
                            .shadow(color: style.glow.opacity(0.55), radius: 4.5)
                            .offset(x: seg.start * w)
                    }
                    // hour dots
                    ForEach(hourFractions, id: \.self) { f in
                        Circle()
                            .fill(isWet(f) ? style.accent : .white.opacity(0.4))
                            .frame(width: 3, height: 3)
                            .shadow(color: isWet(f) ? style.glow : .clear, radius: 3.5)
                            .position(x: f * w, y: 8)
                    }
                    // now dot (window always starts at now)
                    Circle()
                        .fill(.white)
                        .frame(width: 10, height: 10)
                        .background {
                            Circle()
                                .stroke(style.nowRing, lineWidth: 3)
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
