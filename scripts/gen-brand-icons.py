#!/usr/bin/env python3
"""Regenerate every favicon / PWA icon from the brand logo source.

Usage:  python3 scripts/gen-brand-icons.py

Reads  ghostkey-web/brand/logo-source.png  (the full lockup mockup:
shield mark + key + wordmark on a dark navy ground) and writes the
derived assets into ghostkey-web/public/.

The shield+ghost-G portion of the mark is nearly square, so small
icons (favicon, navbar tile) crop to just the shield; it stays
legible at 16px where the full shield+key lockup would not. All
crops keep the source's native dark-navy ground — the mark's shield
interior is itself navy, so true background removal would hollow it
out on light themes.
"""

import base64
import io
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "ghostkey-web"
SRC = ROOT / "brand" / "logo-source.png"
PUB = ROOT / "public"

# Measured geometry in the 1408x768 source (see git history for the
# detection script): shield spans x 458-695, y 178-410; the key
# continues to x 952 after a 6px gap.
SHIELD_CX, SHIELD_CY = 576, 294
SHIELD_W = 237

im = Image.open(SRC).convert("RGB")

# Icons use the shield alone, but a 300px square around it still
# reaches x 726 — into the key bars that start at x 701. Erase the
# key by pasting plain background texture from the empty area right
# of the lockup over it before cropping.
im.paste(im.crop((1028, 150, 1330, 440)), (698, 150))


def square(side: int) -> Image.Image:
    """Square crop of the source centred on the shield."""
    half = side // 2
    return im.crop(
        (SHIELD_CX - half, SHIELD_CY - half, SHIELD_CX + half, SHIELD_CY + half)
    )


def save(img: Image.Image, name: str, size: int) -> None:
    out = img.resize((size, size), Image.LANCZOS)
    # Palette-quantise: the gradient art is photographic, and 24-bit
    # PNGs of it run ~280 KB at 512px. 256 colours with dithering is
    # indistinguishable at icon size and ~4x smaller.
    out = out.quantize(256)
    out.save(PUB / name, optimize=True)
    print(f"  {name}  {size}x{size}")


# Standard icons: shield fills ~80% of the tile.
tile = square(300)
save(tile, "pwa-512x512.png", 512)
save(tile, "pwa-192x192.png", 192)
save(tile, "pwa-64x64.png", 64)
save(tile, "apple-touch-icon-180x180.png", 180)
save(tile, "brand-mark.png", 128)  # navbar tile

# Maskable: the OS may crop to a circle/squircle covering the central
# 80%, so the shield must sit inside that safe zone -> more padding.
save(square(320), "maskable-icon-512x512.png", 512)

# favicon.ico: classic multi-size.
tile.resize((48, 48), Image.LANCZOS).save(
    PUB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
)
print("  favicon.ico  16/32/48")

# favicon.svg: modern browsers prefer SVG; ours wraps a 64px raster of
# the mark with rounded corners. (The mark itself is gradient-shaded
# art, not flat vector shapes — a hand-traced path would lose it.)
buf = io.BytesIO()
tile.resize((64, 64), Image.LANCZOS).save(buf, format="PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <clipPath id="r"><rect width="64" height="64" rx="12"/></clipPath>
  <image href="data:image/png;base64,{b64}" width="64" height="64" clip-path="url(#r)"/>
</svg>
"""
(PUB / "favicon.svg").write_text(svg)
print("  favicon.svg  64 (embedded raster)")
