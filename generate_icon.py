#!/usr/bin/env python3
"""Generate icon.png (128x128) for the ChatLeak VS Code extension.

Rounded-square indigo-to-rose gradient drawn at 4x and downscaled with LANCZOS. Glyph: a bold
white speech bubble with a drop leaking from its tail.
"""

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (79, 70, 229)      # indigo
BOTTOM_COLOR = (244, 63, 94)   # rose
WHITE = (255, 255, 255, 255)


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    gradient = Image.new("RGB", (size, size))
    gdraw = ImageDraw.Draw(gradient)
    for d in range(2 * size - 1):
        t = d / (2 * size - 2)
        c = tuple(int(top_color[i] + (bottom_color[i] - top_color[i]) * t) for i in range(3))
        gdraw.line([(d, 0), (0, d)], fill=c, width=2)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def draw_glyph(img):
    s = img.size[0]
    d = ImageDraw.Draw(img)
    # Speech bubble body.
    left, top, right, bottom = s * 0.17, s * 0.18, s * 0.83, s * 0.60
    d.rounded_rectangle([(left, top), (right, bottom)], radius=int(s * 0.12), fill=WHITE)
    # Tail pointing down-left.
    d.polygon([(s * 0.30, bottom - s * 0.02), (s * 0.46, bottom - s * 0.02), (s * 0.30, s * 0.72)], fill=WHITE)
    # Three "text" dots punched out of the bubble (transparent to the gradient).
    cy = (top + bottom) / 2
    r = s * 0.045
    hole = Image.new("L", img.size, 0)
    hd = ImageDraw.Draw(hole)
    for cx in (s * 0.35, s * 0.50, s * 0.65):
        hd.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=255)
    bg = rounded_gradient_bg(s, TOP_COLOR, BOTTOM_COLOR)
    img.paste(bg, (0, 0), hole)
    # Drip: a drop falling from the bubble's lower right edge.
    dx, dy = s * 0.66, s * 0.78
    dr = s * 0.065
    d.ellipse([(dx - dr, dy - dr), (dx + dr, dy + dr)], fill=WHITE)
    d.polygon([(dx - dr * 0.98, dy - dr * 0.25), (dx + dr * 0.98, dy - dr * 0.25), (dx, dy - dr * 2.6)], fill=WHITE)
    # Small trail drop between bubble and drip.
    tr = s * 0.022
    d.ellipse([(dx - tr, s * 0.635 - tr), (dx + tr, s * 0.635 + tr)], fill=WHITE)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    final = big.resize((SIZE, SIZE), Image.LANCZOS)
    final.save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
