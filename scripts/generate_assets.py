#!/usr/bin/env python3
"""Generate the PWA/social assets for frontend/public (Plankton mark).

Pure-stdlib (zlib + struct) so it runs without PIL: writes RGBA PNGs and an
ICO that embeds a PNG (supported by every modern browser).

Run:  python3 scripts/generate_assets.py
"""
import os
import struct
import zlib

FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00000", "00100"],
}

# Plankton palette (frontend/tailwind.config.js): abyss → lagoon background,
# bioluminescent glow ring, sea-foam cilia and one coral cilium.
TOP = (8, 43, 51)        # #082b33
BOTTOM = (18, 123, 136)  # #127b88
GLOW = (124, 245, 198)   # #7cf5c6
FOAM = (173, 233, 232)   # #ade9e8
CORAL = (255, 138, 115)  # #ff8a73
LAGOON = (54, 185, 192)  # #36b9c0


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[(0, 0, 0, 0) for _ in range(w)] for _ in range(h)]

    def put(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = color

    def blend(self, x, y, rgb, alpha):
        """Alpha-composite rgb over the pixel at (x, y) with coverage alpha."""
        if alpha <= 0 or not (0 <= x < self.w and 0 <= y < self.h):
            return
        alpha = min(1.0, alpha)
        r, g, b, a = self.px[y][x]
        na = alpha + (a / 255) * (1 - alpha)
        if na <= 0:
            return
        mix = lambda c0, c1: int((c1 * alpha + c0 * (a / 255) * (1 - alpha)) / na)
        self.px[y][x] = (mix(r, rgb[0]), mix(g, rgb[1]), mix(b, rgb[2]), int(na * 255))

    def soft_circle(self, cx, cy, r, rgb, alpha=1.0, inner=None):
        """Anti-aliased disc (or ring when `inner` radius is given)."""
        x0, x1 = int(cx - r - 2), int(cx + r + 2)
        y0, y1 = int(cy - r - 2), int(cy + r + 2)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
                cov = max(0.0, min(1.0, r + 0.5 - d))
                if inner is not None:
                    cov = min(cov, max(0.0, min(1.0, d - inner + 0.5)))
                self.blend(x, y, rgb, cov * alpha)

    def glow(self, cx, cy, r, rgb, strength=0.6):
        """Radial falloff halo."""
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d < r:
                    self.blend(x, y, rgb, strength * (1 - d / r) ** 2)

    def diagonal_bg(self, a=TOP, b=BOTTOM, radius=0):
        for y in range(self.h):
            for x in range(self.w):
                t = (x / max(1, self.w - 1) + y / max(1, self.h - 1)) / 2
                c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
                if radius:
                    cx = min(x, self.w - 1 - x) + 0.5
                    cy = min(y, self.h - 1 - y) + 0.5
                    if cx < radius and cy < radius:
                        d = ((radius - cx) ** 2 + (radius - cy) ** 2) ** 0.5
                        cov = max(0.0, min(1.0, radius + 0.5 - d))
                        self.px[y][x] = (c[0], c[1], c[2], int(255 * cov))
                        continue
                self.px[y][x] = (c[0], c[1], c[2], 255)

    def gradient_bg(self, top=TOP, bottom=BOTTOM):
        for y in range(self.h):
            t = y / max(1, self.h - 1)
            c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
            for x in range(self.w):
                self.px[y][x] = (c[0], c[1], c[2], 255)

    def fill_rect(self, x0, y0, x1, y1, color, radius=0):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                if radius:
                    cx = min(x - x0, x1 - 1 - x) + 1
                    cy = min(y - y0, y1 - 1 - y) + 1
                    if cx <= radius and cy <= radius:
                        dx, dy = radius - cx, radius - cy
                        if dx * dx + dy * dy > radius * radius:
                            continue
                self.put(x, y, color)

    def text(self, x, y, s, scale, color, spacing=1):
        """Draw uppercased 5x7 bitmap text, top-left anchored at (x, y)."""
        cursor = x
        for ch in s.upper():
            glyph = FONT.get(ch, FONT[" "])
            for row, bits in enumerate(glyph):
                for col, bit in enumerate(bits):
                    if bit == "1":
                        self.fill_rect(
                            cursor + col * scale, y + row * scale,
                            cursor + (col + 1) * scale, y + (row + 1) * scale,
                            color,
                        )
            cursor += (5 + spacing) * scale
        return cursor - spacing * scale

    def text_width(self, s, scale, spacing=1):
        return len(s) * (5 + spacing) * scale - spacing * scale

    def circle(self, cx, cy, r, color, filled=True, width=3):
        r2 = r * r
        for y in range(cy - r - width, cy + r + width + 1):
            for x in range(cx - r - width, cx + r + width + 1):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if filled:
                    if d2 <= r2:
                        self.put(x, y, color)
                elif r2 - 2 * r * width <= d2 <= r2:
                    self.put(x, y, color)

    def line(self, x0, y0, x1, y1, color, width=2):
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(steps + 1):
            x = int(x0 + (x1 - x0) * i / steps)
            y = int(y0 + (y1 - y0) * i / steps)
            for dx in range(-width, width + 1):
                for dy in range(-width, width + 1):
                    self.put(x + dx, y + dy, color)


def png_bytes(canvas):
    raw = bytearray()
    for row in canvas.px:
        raw.append(0)  # filter: none
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", canvas.w, canvas.h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def draw_mark(c, cx, cy, size):
    """The Plankton cell: glow ring, gradient nucleus, six cilia (one coral)."""
    import math
    k = size / 64.0
    c.glow(cx, cy, 26 * k, GLOW, 0.22)
    c.soft_circle(cx, cy, 16.5 * k, GLOW, 0.92, inner=13.5 * k)
    # nucleus: white core fading into glow then lagoon
    steps = max(6, int(7 * k))
    for i in range(steps, 0, -1):
        t = i / steps
        col = tuple(int(255 + (GLOW[j] - 255) * min(1, t * 1.6)) if t < 0.6
                    else int(GLOW[j] + (LAGOON[j] - GLOW[j]) * (t - 0.6) / 0.4) for j in range(3))
        c.soft_circle(cx, cy, 7 * k * t, col)
    for deg in (0, 60, 120, 180, 240, 300):
        rad = math.radians(deg)
        px, py = cx + math.cos(rad) * 23 * k, cy + math.sin(rad) * 23 * k
        if deg == 300:
            c.soft_circle(px, py, 3.4 * k, CORAL)
        else:
            c.soft_circle(px, py, 2.4 * k, FOAM)


def draw_icon(size, path):
    c = Canvas(size, size)
    c.diagonal_bg(radius=int(size * 18 / 64))
    draw_mark(c, size / 2, size / 2, size)
    with open(path, "wb") as fh:
        fh.write(png_bytes(c))
    return c


def draw_og(path):
    import random
    w, h = 1200, 630
    c = Canvas(w, h)
    c.diagonal_bg((5, 22, 28), (20, 99, 112))
    rnd = random.Random(1337)
    for _ in range(70):
        x, y = rnd.randint(0, w), rnd.randint(0, h)
        r = rnd.uniform(1.5, 5)
        c.glow(x, y, r * 4, GLOW, rnd.uniform(0.15, 0.4))
        c.soft_circle(x, y, r, FOAM, rnd.uniform(0.4, 0.9))
    draw_mark(c, 300, h / 2, 300)
    white = (255, 255, 255, 255)
    glow = GLOW + (255,)
    c.text(500, 205, "PLANKTON", 13, white)
    c.text(504, 330, "DECENTRALIZED LLM NETWORK", 4, glow)
    c.text(504, 380, "GPU WORKERS ANSWER YOUR CHATS.", 3, white)
    c.text(504, 470, "PLANKTON.CLICK", 4, CORAL + (255,))
    with open(path, "wb") as fh:
        fh.write(png_bytes(c))


def draw_favicon(path, size=32):
    c = Canvas(size, size)
    c.diagonal_bg(radius=9)
    draw_mark(c, size / 2, size / 2, size)
    data = png_bytes(c)
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), 22)
    with open(path, "wb") as fh:
        fh.write(header + entry + data)


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "frontend", "public")
    os.makedirs(out, exist_ok=True)

    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"),
                       (180, "apple-touch-icon.png")):
        draw_icon(size, os.path.join(out, name))
        print("wrote", name)

    draw_og(os.path.join(out, "og-image.png"))
    print("wrote og-image.png")

    draw_favicon(os.path.join(out, "favicon.ico"))
    print("wrote favicon.ico")

    # favicon.svg is hand-maintained in frontend/public (same mark as
    # components/Logo.js) — not generated here.


if __name__ == "__main__":
    main()
