import SwiftUI

/// The "Gonna Rain?" app icon mark, in vector form.
///
/// Geometry is transcribed literally from `WillItRain/Design/AppIcon/AppIcon.svg`
/// (the adopted `drift-scatter` design) so the Live Activity and Dynamic Island
/// show the same silhouette the home screen does: the shaped-underside cloud
/// over five forward-slash raindrops of varied length. Numbers below are the
/// SVG's own, in its 1024 x 1024 coordinate space — do not "clean them up";
/// they are meant to diff against the SVG.
///
/// Stroke weight is 50 units in that space and scales with the mark, which is
/// what keeps the drops separating at small sizes (the design round measured
/// five distinct marks down to 40px at this ratio).
struct AppIconMark: Shape {
    /// The SVG's design canvas.
    private static let canvas: CGFloat = 1024

    /// Stroke width in canvas units, from the SVG's `stroke-width="50"`.
    static let strokeUnits: CGFloat = 50

    /// Ink bounding box of the stroked art within the canvas, so the mark can
    /// be fitted to an arbitrary frame without leaving the SVG's padding in.
    private static let ink = CGRect(x: 163.86, y: 194.48, width: 696.32, height: 635.04)

    /// Line width to stroke this shape with when drawn at `size` points.
    static func lineWidth(forSize size: CGFloat) -> CGFloat {
        size * strokeUnits / max(ink.width, ink.height)
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()

        // Cloud: six circular arcs, all with large-arc-flag 0 and sweep 0,
        // matching the `A` commands in the SVG's cloud path.
        p.move(to: CGPoint(x: 797.16, y: 505.77))
        p.svgArc(radius: 117.88, to: CGPoint(x: 718.79, y: 301.20))
        p.svgArc(radius: 155.75, to: CGPoint(x: 493.45, y: 246.93))
        p.svgArc(radius: 147.78, to: CGPoint(x: 307.14, y: 311.34))
        p.svgArc(radius: 111.91, to: CGPoint(x: 225.37, y: 505.77))
        p.svgArc(radius: 306.41, to: CGPoint(x: 554.14, y: 505.77))
        p.svgArc(radius: 261.88, to: CGPoint(x: 797.16, y: 505.77))
        p.closeSubpath()

        // Rain: five drops, varied lengths, leaning 22° as `/`.
        for (x1, y1, x2, y2) in Self.drops {
            p.move(to: CGPoint(x: x1, y: y1))
            p.addLine(to: CGPoint(x: x2, y: y2))
        }

        return p.applying(Self.fit(into: rect))
    }

    private static let drops: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (334.20, 649.63, 278.21, 788.22),
        (453.90, 619.74, 379.24, 804.52),
        (546.22, 657.60, 499.19, 774.02),
        (666.73, 625.71, 600.28, 790.17),
        (767.91, 641.66, 714.15, 774.70),
    ]

    /// Uniformly scales the ink box to fill `rect` and centres it, so the mark
    /// keeps its aspect ratio in any frame.
    private static func fit(into rect: CGRect) -> CGAffineTransform {
        let scale = min(rect.width / ink.width, rect.height / ink.height)
        let w = ink.width * scale
        let h = ink.height * scale
        return CGAffineTransform(translationX: rect.minX + (rect.width - w) / 2,
                                 y: rect.minY + (rect.height - h) / 2)
            .scaledBy(x: scale, y: scale)
            .translatedBy(x: -ink.minX, y: -ink.minY)
    }
}

private extension Path {
    /// Appends an SVG `A rx,ry 0 0,0 x,y` arc from the current point.
    ///
    /// Only the flag combination the icon uses (large-arc 0, sweep 0) is
    /// supported, which is enough to reproduce the cloud exactly.
    mutating func svgArc(radius: CGFloat, to end: CGPoint) {
        guard let start = currentPoint else { return }

        let midX = (start.x - end.x) / 2
        let midY = (start.y - end.y) / 2

        // Grow the radius if the endpoints are further apart than it allows
        // (SVG's out-of-range radius correction). The icon never needs it, but
        // without it a future tweak could silently produce NaNs.
        var r = radius
        let lambda = (midX * midX + midY * midY) / (r * r)
        if lambda > 1 { r *= sqrt(lambda) }

        let numerator = r * r * r * r - r * r * (midY * midY) - r * r * (midX * midX)
        let denominator = r * r * (midY * midY) + r * r * (midX * midX)
        // large-arc == sweep would flip this sign; both are 0 here, so it is
        // negated exactly once.
        let coefficient = -sqrt(max(0, numerator / denominator))

        let centre = CGPoint(x: coefficient * midY + (start.x + end.x) / 2,
                             y: -coefficient * midX + (start.y + end.y) / 2)
        let startAngle = atan2(start.y - centre.y, start.x - centre.x)
        let endAngle = atan2(end.y - centre.y, end.x - centre.x)

        addArc(center: centre,
               radius: r,
               startAngle: .radians(startAngle),
               endAngle: .radians(endAngle),
               clockwise: true) // sweep 0 == counter-clockwise in SVG's
                                // y-down space, which is `clockwise: true` here
    }
}

/// The mark drawn as line art, sized to a square of `size` points.
struct AppIconGlyph: View {
    let size: CGFloat
    var tint: Color = .white

    var body: some View {
        AppIconMark()
            .stroke(tint,
                    style: StrokeStyle(lineWidth: AppIconMark.lineWidth(forSize: size),
                                       lineCap: .round,
                                       lineJoin: .round))
            .frame(width: size, height: size * 635.04 / 696.32)
    }
}

/// The app icon as a tile — the mark on its `#0E0F12` ground, corner-rounded —
/// for the places a Live Activity shows the app's identity rather than a glyph.
struct AppIconTile: View {
    let size: CGFloat

    private static let background = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x12 / 255)

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
            .fill(Self.background)
            .frame(width: size, height: size)
            .overlay {
                // The icon's art occupies 68% of its tile; matching that here
                // keeps the tile reading as the actual app icon.
                AppIconGlyph(size: size * 0.68)
            }
    }
}
