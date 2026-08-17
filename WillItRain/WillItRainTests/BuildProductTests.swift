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

    func testVersionKeysPresent() throws {
        let short = try XCTUnwrap(info["CFBundleShortVersionString"] as? String)
        let build = try XCTUnwrap(info["CFBundleVersion"] as? String)
        XCTAssertFalse(short.isEmpty)
        XCTAssertFalse(build.isEmpty)
    }
}
