import XCTest

/// Regression tests over the built app's generated Info.plist.
///
/// The app relies on GENERATE_INFOPLIST_FILE merging INFOPLIST_KEY_* build settings
/// into the final Info.plist (the portrait lock shipped in 1.1.1 works this way), so
/// these assertions run against Bundle.main of the test host — the real build product —
/// not the checked-in plist source.
final class BuildProductTests: XCTestCase {

    private var info: [String: Any] {
        Bundle.main.infoDictionary ?? [:]
    }

    func testAppIsLockedToPortrait() throws {
        let orientations = try XCTUnwrap(
            info["UISupportedInterfaceOrientations"] as? [String],
            "UISupportedInterfaceOrientations missing from generated Info.plist"
        )
        XCTAssertEqual(orientations, ["UIInterfaceOrientationPortrait"],
                       "App must remain locked to portrait (see 1.1.1 portrait-lock fix)")
    }

    func testBundleIdentifier() {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.willitrain.WillItRain")
    }

    func testDisplayName() {
        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "Gonna Rain?")
    }

    func testLiveActivitiesEnabled() {
        XCTAssertEqual(info["NSSupportsLiveActivities"] as? Bool, true)
        XCTAssertEqual(info["NSSupportsLiveActivitiesFrequentUpdates"] as? Bool, true)
    }

    func testBackgroundRefreshTaskRegistered() throws {
        let identifiers = try XCTUnwrap(info["BGTaskSchedulerPermittedIdentifiers"] as? [String])
        XCTAssertTrue(identifiers.contains("com.willitrain.refresh"))
    }

    func testLocationUsageDescriptionsPresent() {
        XCTAssertNotNil(info["NSLocationWhenInUseUsageDescription"])
        XCTAssertNotNil(info["NSLocationAlwaysAndWhenInUseUsageDescription"])
    }

    /// The deployment floor, read off the built product rather than the pbxproj:
    /// `MinimumOSVersion` is the key iOS and the App Store actually consult to decide
    /// whether the app may be installed. Raised from 16.6 to 17.0 (2026-08-18 ruling)
    /// to unlock NavigationStack, the two-parameter `onChange` and `@Observable`; the
    /// project-level default was normalised to the same value at the same time, so a
    /// stale per-target override reappearing would show up here.
    func testAppMinimumOSVersionIsTheRaisedFloor() throws {
        let minimum = try XCTUnwrap(
            info["MinimumOSVersion"] as? String,
            "MinimumOSVersion missing from generated Info.plist"
        )
        XCTAssertEqual(minimum, "17.0")
    }

    /// The widget extension ships inside the app bundle and must carry the same floor:
    /// an appex whose MinimumOSVersion is above its host's is simply not loaded on the
    /// devices in between, which reads as "the widget disappeared", not as a build error.
    func testWidgetExtensionCarriesTheSameFloorAsTheApp() throws {
        let plugIns = try XCTUnwrap(Bundle.main.builtInPlugInsURL)
        let widget = try XCTUnwrap(
            Bundle(url: plugIns.appendingPathComponent("WillItRainWidgets.appex")),
            "WillItRainWidgets.appex is not embedded in the built app"
        )
        let minimum = try XCTUnwrap(widget.infoDictionary?["MinimumOSVersion"] as? String)
        XCTAssertEqual(minimum, info["MinimumOSVersion"] as? String)
        XCTAssertEqual(minimum, "17.0")
    }

    func testVersionKeysPresent() throws {
        let short = try XCTUnwrap(info["CFBundleShortVersionString"] as? String)
        let build = try XCTUnwrap(info["CFBundleVersion"] as? String)
        XCTAssertFalse(short.isEmpty)
        XCTAssertFalse(build.isEmpty)
    }
}
