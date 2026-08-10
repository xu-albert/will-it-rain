#!/usr/bin/env python3
"""Check that the Live Activity's vector mark still matches the app icon.

`WillItRainWidgets/AppIconMark.swift` transcribes `AppIcon.svg` into a SwiftUI
`Shape` so the Live Activity and Dynamic Island draw the same silhouette the
home screen does. Nothing enforces that by construction, so this renders both
and compares them:

  * the SwiftUI shape, via `verify_mark.swift` + `ImageRenderer` (AppKit);
  * the SVG, via the same `rasterise.swift` the catalogue is built with.

    python3 WillItRain/Design/AppIcon/verify_mark.py

Exits non-zero if the two disagree by more than the tolerance below. Some
disagreement is expected and legitimate: the two go through different
rasterisers, and the SwiftUI path strokes with round caps/joins applied by Core
Graphics rather than by the SVG renderer, so edges land on slightly different
subpixels. The tolerance is set to catch a geometry mistake (a wrong arc, a
dropped drop, a bad fit transform), not antialiasing noise.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "AppIcon.svg")

# Sizes to compare at. 1024 is where a geometry error is unmissable; 180 and 87
# are the home-screen and Settings slots, and 87 is the size the shaped cloud
# underside was questioned at.
SIZES = [1024, 180, 87]

# Mean absolute per-pixel difference, 0-255. Measured noise between the two
# rasterisers is ~4-6 at these sizes; a missing drop moves it past 20.
TOLERANCE = 12.0


def render_swiftui(tmp, size, out):
    """Compile AppIconMark.swift with the driver and render the shape."""
    main = os.path.join(tmp, "main.swift")
    shutil.copy(os.path.join(HERE, "verify_mark.swift"), main)
    mark = os.path.abspath(
        os.path.join(HERE, "..", "..", "WillItRainWidgets", "AppIconMark.swift")
    )
    binary = os.path.join(tmp, "verify_mark")
    if not os.path.exists(binary):
        # Top-level code is only allowed in a file called main.swift, hence the
        # copy above rather than compiling verify_mark.swift under its own name.
        build = subprocess.run(
            ["swiftc", "-O", mark, main, "-o", binary], capture_output=True, text=True
        )
        if build.returncode != 0:
            sys.exit(f"swiftc failed:\n{build.stdout}\n{build.stderr}")
    run = subprocess.run([binary, str(size), out], capture_output=True, text=True)
    if run.returncode != 0:
        sys.exit(f"render failed:\n{run.stdout}\n{run.stderr}")


def render_svg(size, out):
    run = subprocess.run(
        ["swift", os.path.join(HERE, "rasterise.swift"), SVG, f"{size}:{out}"],
        capture_output=True,
        text=True,
    )
    if run.returncode != 0:
        sys.exit(f"rasterise failed:\n{run.stdout}\n{run.stderr}")


def mean_abs_diff(a, b):
    from PIL import Image

    ia = Image.open(a).convert("L")
    ib = Image.open(b).convert("L")
    if ia.size != ib.size:
        sys.exit(f"size mismatch: {ia.size} vs {ib.size}")
    pa, pb = list(ia.tobytes()), list(ib.tobytes())
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)


def main():
    worst = 0.0
    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        for size in SIZES:
            swiftui = os.path.join(tmp, f"swiftui-{size}.png")
            svg = os.path.join(tmp, f"svg-{size}.png")
            render_swiftui(tmp, size, swiftui)
            render_svg(size, svg)
            diff = mean_abs_diff(swiftui, svg)
            worst = max(worst, diff)
            ok = diff <= TOLERANCE
            failed = failed or not ok
            print(f"{size:>5}px  mean abs diff {diff:6.2f}  {'ok' if ok else 'FAIL'}")
    print(f"\nworst {worst:.2f} against tolerance {TOLERANCE}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
