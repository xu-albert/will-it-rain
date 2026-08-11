# `drift-scatter` app icon — how it actually renders on iOS

Captured from a real iPhone 16 Pro Max simulator (iOS 26.2) running a Debug
build of this branch, not from mock-ups. Every file here is a straight crop of
a `simctl io screenshot`; nothing has been retouched, and the silhouette was
not changed.

Each capture comes as a pair:

* `*-icon.png` — the crop at **1:1**, i.e. the size the pixels really are.
* `*-icon-4x.png` — the same crop at 4x nearest-neighbour, for judging pixels.

Full-frame screenshots (45 MB) are left out of the repo to keep it light. The
capture script writes them to `data/wir-icon-adopt/native/` here, which is
git-ignored; every crop below is cut from the frame of the same name.

## The open question

> "i said accept it, but i'm not sure. i'll need to see it in the actual
> simulator to really confirm what i want."

The question is whether the cloud's **shaped underside** — the scalloped bottom
edge with the dip under the middle lobe — still reads once the icon gets small.
These are the renders to judge it from, smallest first:

| # | Where | Asset / size | Does the shaped underside read? |
|---|---|---|---|
| `03` | Settings ▸ Apps row | 29 pt @3x → the **87 px** asset | **No.** The cloud closes up into a rounded blob; the dip is gone. This is the size the question was about. |
| `02` | Spotlight top hit | small, on a light blurred ground | Marginal — the dip is present but reads as a soft waist rather than a shape. |
| `01` | Home screen | 60 pt @3x → the **180 px** asset | **Yes**, clearly. Five drops and the scalloped bottom all separate cleanly. |

So the caveat from the design round holds up in real renders: **the shaped
underside stops reading somewhere between the 180 px and 87 px assets.** It is
visible on the Home Screen and gone in Settings. Whether that matters is the
call to make — the icon still reads unmistakably as "cloud with rain" at 87 px,
it just reads as a *plain* cloud there.

Nothing here has been adjusted to hide that. If the answer is "reshape it", the
vector source is `WillItRain/Design/AppIcon/AppIcon.svg` and every catalogue PNG
regenerates from it with `render_appicon.py`.

## The Live Activity presentations

| # | Presentation | Mark | Size |
|---|---|---|---|
| `04-lockscreen-{A,B,C}` | Live Activity card, lock screen | `AppIconTile` — the icon on its `#0E0F12` ground | 20 pt identity badge |
| `05-island-expanded-{A,B,C}` | Dynamic Island, expanded | `AppIconGlyph` — **superseded, see below** | 19 pt |
| `06-island-compact-{A,B,C}` | Dynamic Island, compact | `AppIconGlyph` — **superseded, see below** | 18 pt |

`A` / `B` / `C` are the three debug scenarios: *rain incoming*, *raining now*,
*on & off showers*.

The 20 pt identity badge on the Live Activity card (`04-*`) is the smallest the
**filled tile** appears anywhere, and there the underside is gone for the same
reason as in Settings. That badge is what ships.

### The Dynamic Island captures show a state that was reverted

`05-*` and `06-*` were captured while the Dynamic Island's leading, compact and
minimal slots were also drawing the app mark. **They no longer are.** That was
reverted on the master's decision: those slots are weather-semantic, not app
identity, so `release-1.1.1-wintry-live-activity` can keep swapping them for a
snowflake on wintry activities. The Dynamic Island now carries no app branding
and is byte-identical to `main`.

The captures are kept because they are still the only real render of the mark
as line art at 18–19 pt, and they show something worth knowing: **as line art
the shaped underside survives at sizes where the filled tile loses it**, because
the open outline holds the bottom edge. If the mark is ever wanted in a small
line-art slot, this is the evidence that it would work there.

## Not captured

* **Dynamic Island minimal.** The minimal presentation only appears when a
  second app's activity is running alongside this one, which this harness does
  not stage. The previous round's `07-island-minimal-*` files were mislabelled
  — they are the compact presentation — so they were dropped rather than
  carried forward under a name that would mislead.

## Reproducing

`WillItRain/Design/AppIcon/capture-icon-shots.sh`. Read its header before
touching any coordinate: the Simulator draws this device **rotated 180°** and at
0.31 pt per device pixel, so taps must be mirrored, and the Dynamic Island has
to be screenshotted *while* the long press is held or it collapses back to
compact before the shutter.
