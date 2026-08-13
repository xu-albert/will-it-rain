import ActivityKit
import SwiftUI
import WidgetKit

// The ActivityKit wiring only. The views and the rain/wintry palette live in
// Shared/LiveActivityCardViews.swift so the app can render the lock-screen card
// too — see the header there for why.

struct RainLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RainActivityAttributes.self) { context in
            LockScreenActivityView(state: context.state)
                .activityBackgroundTint(LACardPalette.bgBottom)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let style = LAStyle.of(context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        PrecipGlyph(style: style, size: 16)
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
                PrecipGlyph(style: style, size: 15)
            } compactTrailing: {
                CompactCountdownText(state: context.state)
            } minimal: {
                PrecipGlyph(style: style, size: 15)
            }
            .keylineTint(style.accent)
        }
    }
}
