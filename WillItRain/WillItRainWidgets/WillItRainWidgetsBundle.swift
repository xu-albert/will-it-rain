import SwiftUI
import WidgetKit

@main
struct WillItRainWidgetsBundle: WidgetBundle {
    var body: some Widget {
        RainLiveActivity()
        // Home-screen widgets still live in the app target (dormant);
        // add them here when they move over.
    }
}
