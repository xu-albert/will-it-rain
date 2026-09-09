import XCTest
@testable import WillItRain

/// The Live Activity payload contract between the Worker, the app and the
/// widget extension. `content-state` is JSON-decoded by ActivityKit straight
/// off the push, so what these pin is the wire shape, not a Swift convenience.
final class RainActivityAttributesTests: XCTestCase {

    private func state(precip: RainActivityAttributes.Precip?) -> RainActivityAttributes.ContentState {
        .init(
            statusText: "Rain incoming",
            countdownTarget: nil,
            heroText: nil,
            subBold: "Rain expected",
            subRest: " · next hour",
            boldFirst: true,
            rightText: "",
            segments: [.init(start: 0.2, end: 0.6)],
            windowMinutes: 90,
            midLabel: "+45 min",
            endLabel: "+90 min",
            flagText: nil,
            flagPosition: nil,
            precip: precip
        )
    }

    /// A push from a Worker that predates `precip` carries no such key at all.
    /// If this ever fails to decode, ActivityKit drops the update silently and
    /// the card freezes — no crash, no log — which is why the field is Optional
    /// and why this test exists.
    func testPayloadWithoutPrecipStillDecodesAndRendersAsRain() throws {
        var json = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state(precip: .rain))
        ) as! [String: Any]
        json.removeValue(forKey: "precip")
        XCTAssertNil(json["precip"])

        let data = try JSONSerialization.data(withJSONObject: json)
        let decoded = try JSONDecoder().decode(RainActivityAttributes.ContentState.self, from: data)

        XCTAssertNil(decoded.precip)
        XCTAssertEqual(LAStyle.of(decoded).glyph, LAStyle.rain.glyph)
    }

    func testPrecipEncodesAsTheBareStringsTheWorkerSends() throws {
        let rain = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state(precip: .rain))
        ) as! [String: Any]
        XCTAssertEqual(rain["precip"] as? String, "rain")

        let wintry = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state(precip: .wintry))
        ) as! [String: Any]
        XCTAssertEqual(wintry["precip"] as? String, "wintry")
    }

    func testWintryDecodesFromTheWorkerString() throws {
        var json = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(state(precip: nil))
        ) as! [String: Any]
        json["precip"] = "wintry"
        let data = try JSONSerialization.data(withJSONObject: json)
        let decoded = try JSONDecoder().decode(RainActivityAttributes.ContentState.self, from: data)
        XCTAssertEqual(decoded.precip, .wintry)
    }

    /// Only an explicit `wintry` gets the pale treatment. `rain` and a missing
    /// value both draw what 1.1.1 drew.
    func testOnlyWintrySelectsTheWintryStyle() {
        XCTAssertEqual(LAStyle.of(state(precip: .wintry)).glyph, "snowflake")
        XCTAssertEqual(LAStyle.of(state(precip: .rain)).glyph, "drop.fill")
        XCTAssertEqual(LAStyle.of(state(precip: nil)).glyph, "drop.fill")
    }

    /// The DEBUG scenarios are the screenshot harness's fixtures; the BX one
    /// exists specifically to stand in for a legacy payload, so it must keep
    /// `precip` absent, and the S variants must keep it wintry.
    func testDebugScenariosCarryThePrecipTheirNamesPromise() {
        XCTAssertNil(LiveActivityService.DebugScenario.bLegacy.contentState.precip)
        XCTAssertEqual(LiveActivityService.DebugScenario.b.contentState.precip, .rain)
        XCTAssertEqual(LiveActivityService.DebugScenario.aWintry.contentState.precip, .wintry)
        XCTAssertEqual(LiveActivityService.DebugScenario.bWintry.contentState.precip, .wintry)
        XCTAssertEqual(LiveActivityService.DebugScenario.cWintry.contentState.precip, .wintry)

        // BX is B with the field removed and nothing else changed.
        let b = LiveActivityService.DebugScenario.b.contentState
        let bx = LiveActivityService.DebugScenario.bLegacy.contentState
        XCTAssertEqual(bx.statusText, b.statusText)
        XCTAssertEqual(bx.segments, b.segments)
        XCTAssertEqual(bx.subRest, b.subRest)
    }

    /// `scripts/test-live-activity.sh` launches the card screen with the codes
    /// upper-cased and comma-joined, exactly as the scenario enum spells them.
    /// The parser accepts that shape and nothing else.
    func testCardPreviewParsesCommaJoinedCodesExactly() {
        let parsed = LiveActivityCardPreview.fromLaunchArgs(["-liveActivityCards", "A,BS,BX"])
        XCTAssertEqual(parsed?.scenarios, [.a, .bWintry, .bLegacy])

        XCTAssertNil(LiveActivityCardPreview.fromLaunchArgs(["-liveActivityCards", "a,bs"]))
        XCTAssertNil(LiveActivityCardPreview.fromLaunchArgs(["-liveActivityCards", "A BS"]))
        XCTAssertNil(LiveActivityCardPreview.fromLaunchArgs(["-liveActivityCards"]))
        XCTAssertNil(LiveActivityCardPreview.fromLaunchArgs([]))
    }
}
