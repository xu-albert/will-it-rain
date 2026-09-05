// Renders the SwiftUI `AppIconMark` (the shape the Live Activity's identity
// badge draws) off-screen, so it can be diffed against the same geometry
// rasterised from AppIcon.svg. Proves the transcription in
// Shared/AppIconMark.swift still matches the icon's vector source
// without needing a simulator.
//
// Driven by verify_mark.py, which compiles this together with AppIconMark.swift
// and does the rasterising and the compare. It does NOT compile on its own —
// AppIconGlyph lives in AppIconMark.swift — so an editor opening this file
// alone will flag "cannot find AppIconGlyph in scope". Run verify_mark.py.

import SwiftUI
import AppKit
import ImageIO

let args = CommandLine.arguments
guard args.count == 3, let size = Double(args[1]) else {
    FileHandle.standardError.write("usage: verify_mark.swift <size> <out.png>\n".data(using: .utf8)!)
    exit(2)
}
let out = URL(fileURLWithPath: args[2])
let side = CGFloat(size)

// ImageRenderer is main-actor isolated, so the whole render hops onto the main
// actor and the process waits for it.
@MainActor
func render() {
    // The icon tile: mark on its #0E0F12 ground, art at 68% of the tile,
    // matching AppIconTile and the SVG's own padding.
    let view = ZStack {
        Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x12 / 255)
        AppIconGlyph(size: side * 0.68)
    }
    .frame(width: side, height: side)

    let renderer = ImageRenderer(content: view)
    renderer.scale = 1
    guard let cg = renderer.cgImage,
          let dest = CGImageDestinationCreateWithURL(out as CFURL, "public.png" as CFString, 1, nil) else {
        FileHandle.standardError.write("render failed\n".data(using: .utf8)!)
        exit(1)
    }
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
    print("wrote \(out.path) at \(Int(side))px")
    exit(0)
}

Task { @MainActor in render() }
RunLoop.main.run()
