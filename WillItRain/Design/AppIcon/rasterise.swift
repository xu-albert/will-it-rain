// Rasterises an SVG to square PNGs at arbitrary pixel sizes, using AppKit's
// built-in SVG support so the icon pipeline needs no third-party tooling.
//
//   swift rasterise.swift <input.svg> <pixels>:<out.png> [<pixels>:<out.png> ...]
//
// Driven by render_appicon.py; run that rather than this directly.

import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: rasterise.swift <svg> <size>:<png> ...\n".utf8))
    exit(2)
}

let source = URL(fileURLWithPath: arguments[1])
guard let image = NSImage(contentsOf: source) else {
    FileHandle.standardError.write(Data("could not load \(source.path)\n".utf8))
    exit(3)
}

for spec in arguments.dropFirst(2) {
    let parts = spec.split(separator: ":", maxSplits: 1)
    guard parts.count == 2, let size = Int(parts[0]) else {
        FileHandle.standardError.write(Data("malformed spec \(spec)\n".utf8))
        exit(2)
    }
    let destination = URL(fileURLWithPath: String(parts[1]))

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else {
        FileHandle.standardError.write(Data("could not allocate \(size)px bitmap\n".utf8))
        exit(4)
    }
    bitmap.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.imageInterpolation = .high
    // Drawing the vector directly into a canvas of the target size rasterises
    // at that size rather than resampling a larger raster.
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
               from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write(Data("could not encode \(destination.path)\n".utf8))
        exit(5)
    }
    try png.write(to: destination)
    print("  \(destination.lastPathComponent) — \(size)x\(size)")
}
