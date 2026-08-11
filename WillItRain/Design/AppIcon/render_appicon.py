#!/usr/bin/env python3
"""Render AppIcon.svg (the adopted `drift-scatter` mark) into the asset catalogue.

`AppIcon.svg` next to this script is the *source of truth* for the app icon.
Every PNG in `WillItRain/Assets.xcassets/AppIcon.appiconset/` is rasterised
natively from it at its own pixel size -- nothing is upscaled or downscaled
from another PNG, so the small sizes keep the crisp strokes the design round
measured rather than a blurred copy of the 1024.

    python3 WillItRain/Design/AppIcon/render_appicon.py

Rasterising goes through AppKit's own SVG support via the small Swift program
in `rasterise.swift`, so this needs nothing installed beyond Xcode. Output was
diffed against the design round's Chrome renders at 40px and 1024px and is
pixel-equivalent.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "AppIcon.svg")
RASTERISER = os.path.join(HERE, "rasterise.swift")
OUT = os.path.abspath(
    os.path.join(HERE, "..", "..", "WillItRain", "Assets.xcassets", "AppIcon.appiconset")
)

# Every pixel size iOS asks an iPhone or iPad app icon for. Named by pixel
# dimension so one file serves every slot that wants those pixels (e.g. 120 is
# both iPhone 40pt@3x spotlight and iPhone 60pt@2x app).
PIXEL_SIZES = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180]

# The three iOS 18+ appearance variants at marketing size. The mark is white
# line art on #0E0F12 -- already monochrome on a dark ground -- so dark and
# tinted use the same geometry. They are separate files so a later revision can
# diverge them without restructuring the catalogue.
APPEARANCES = ["AppIcon-1024", "AppIcon-1024-dark", "AppIcon-1024-tinted"]


# PNG colour type 2 is truecolour with no alpha channel, which is what an
# asset-catalogue App Store icon must be: App Store Connect rejects an icon
# carrying an alpha channel (ITMS-90717) even when it is fully opaque.
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
COLOUR_TYPE_RGB = 2


def assert_opaque(paths):
    """Refuse to leave an icon with an alpha channel in the catalogue.

    The colour type is the last byte of the IHDR chunk's data, at offset 25 of
    the file. Checking it here is the only chance to catch the problem: the
    symptom otherwise appears at App Store upload, long after the PNGs are
    committed.
    """
    offenders = []
    for path in paths:
        with open(path, "rb") as handle:
            header = handle.read(26)
        if len(header) < 26 or not header.startswith(PNG_MAGIC):
            offenders.append((path, "not a PNG"))
        elif header[25] != COLOUR_TYPE_RGB:
            offenders.append((path, f"PNG colour type {header[25]}"))

    if offenders:
        listing = "\n".join(f"  {os.path.basename(p)}: {why}" for p, why in offenders)
        sys.exit(
            f"{len(offenders)} icon(s) are not alpha-free RGB:\n{listing}\n\n"
            f"App Store Connect rejects an app icon with an alpha channel "
            f"(ITMS-90717). Check the NSBitmapImageRep allocation in "
            f"{os.path.basename(RASTERISER)} -- it must ask for "
            f"samplesPerPixel: 3, hasAlpha: false."
        )


def main():
    os.makedirs(OUT, exist_ok=True)

    targets = [(size, os.path.join(OUT, f"AppIcon-{size}.png")) for size in PIXEL_SIZES]
    targets += [(1024, os.path.join(OUT, name + ".png")) for name in APPEARANCES]
    specs = [f"{size}:{path}" for size, path in targets]
    written = [path for _, path in targets]

    result = subprocess.run(["swift", RASTERISER, SVG, *specs], capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"rasterise failed:\n{result.stdout}\n{result.stderr}")

    print(result.stdout.strip())
    assert_opaque(written)
    print(f"{len(specs)} files written to {OUT}")


if __name__ == "__main__":
    main()
