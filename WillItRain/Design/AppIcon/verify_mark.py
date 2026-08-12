#!/usr/bin/env python3
"""Check that the Live Activity's vector mark still matches the app icon.

`WillItRainWidgets/AppIconMark.swift` transcribes `AppIcon.svg` into a SwiftUI
`Shape` so the Live Activity's identity badge draws the same silhouette the
home screen does. Nothing enforces that by construction, so this renders both
and compares them:

  * the SwiftUI shape, via `verify_mark.swift` + `ImageRenderer` (AppKit);
  * the SVG, via the same `rasterise.swift` the catalogue is built with.

    python3 WillItRain/Design/AppIcon/verify_mark.py

Exits non-zero if the two disagree by more than the per-size tolerance below.
Some disagreement is expected and legitimate: the two go through different
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

# The metric is the percentage of pixels where the two renders disagree by more
# than HARD_DIFF out of 255 -- i.e. where one drew ink and the other drew ground.
#
# A mean absolute difference over the whole frame cannot do this job. More than
# half the frame is flat background, which dilutes a real geometry error down
# into the antialiasing noise: measured on this mark, deleting a whole raindrop
# moves the 1024px mean by only ~2.2, well inside the 12.0 mean-difference
# tolerance this check used to carry.
HARD_DIFF = 128

# Sizes to compare at, and the percentage of hard-disagreeing pixels each
# allows. 1024 is where a geometry error is unmissable; 180 and 87 are the
# home-screen and Settings slots, and 87 is the size the shaped cloud underside
# was questioned at.
#
# Calibrated by measurement, not by guesswork -- rendering the real mark and
# then five mutants, each with one raindrop deleted:
#
#            clean   worst mutant (the shortest drop deleted)
#   1024px   0.000   0.784
#    180px   0.000   0.772
#     87px   0.859   1.625
#
# 1024 and 180 carry the detection: there a missing drop is three times the
# bound. At 87 the stroke is about one pixel wide, so subpixel placement genuinely
# flips whole pixels between the two rasterisers and the clean run is not zero;
# that bound is a sanity check rather than a geometry test.
TOLERANCE = {1024: 0.25, 180: 0.25, 87: 1.50}


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


def hard_disagreement(a, b):
    """Percentage of pixels the two renders disagree about by more than HARD_DIFF."""
    from PIL import Image

    ia = Image.open(a).convert("L")
    ib = Image.open(b).convert("L")
    if ia.size != ib.size:
        sys.exit(f"size mismatch: {ia.size} vs {ib.size}")
    pa, pb = ia.tobytes(), ib.tobytes()
    hard = sum(1 for x, y in zip(pa, pb) if abs(x - y) > HARD_DIFF)
    return 100.0 * hard / len(pa)


def main():
    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        for size in sorted(TOLERANCE, reverse=True):
            swiftui = os.path.join(tmp, f"swiftui-{size}.png")
            svg = os.path.join(tmp, f"svg-{size}.png")
            render_swiftui(tmp, size, swiftui)
            render_svg(size, svg)
            diff = hard_disagreement(swiftui, svg)
            allowed = TOLERANCE[size]
            ok = diff <= allowed
            failed = failed or not ok
            print(f"{size:>5}px  {diff:6.3f}% of pixels disagree "
                  f"(allowed {allowed:.2f}%)  {'ok' if ok else 'FAIL'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
