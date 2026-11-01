#!/usr/bin/env python3
"""Generate the default Aruku RPC icons without third-party packages.

Outputs:
  assets/location.gif      animated 64x64 tray icon
  assets/rpc-location.png  static 256x256 image for Discord Art Assets
  assets/icon.png          static 256x256 app/window icon
  assets/icon.ico          Windows icon
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

W = H = 64
FRAMES = 8

PALETTE: list[tuple[int, int, int]] = [
    (11, 13, 18),      # 0 background
    (21, 25, 35),      # 1 card
    (139, 92, 246),    # 2 violet
    (124, 58, 237),    # 3 deep violet
    (34, 211, 238),    # 4 cyan
    (244, 244, 245),   # 5 white
    (107, 114, 128),   # 6 gray
    (52, 211, 153),    # 7 green
    (251, 191, 36),    # 8 amber
    (248, 113, 113),   # 9 red
    (31, 37, 50),      # 10 border
    (167, 139, 250),   # 11 light violet
    (15, 23, 42),      # 12 navy
    (59, 130, 246),    # 13 blue
    (236, 72, 153),    # 14 pink
    (255, 255, 255),   # 15 pure white
]


def blank() -> list[list[int]]:
    return [[0 for _ in range(W)] for _ in range(H)]


def put(pixels: list[list[int]], x: int, y: int, color: int) -> None:
    if 0 <= x < W and 0 <= y < H:
        pixels[y][x] = color


def rect(pixels: list[list[int]], x0: int, y0: int, x1: int, y1: int, color: int) -> None:
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(pixels, x, y, color)


def rounded_rect(
    pixels: list[list[int]],
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    radius: int,
    color: int,
) -> None:
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if x < x0 + radius and y < y0 + radius:
                if (x - (x0 + radius)) ** 2 + (y - (y0 + radius)) ** 2 > radius**2:
                    continue
            if x > x1 - radius and y < y0 + radius:
                if (x - (x1 - radius)) ** 2 + (y - (y0 + radius)) ** 2 > radius**2:
                    continue
            if x < x0 + radius and y > y1 - radius:
                if (x - (x0 + radius)) ** 2 + (y - (y1 - radius)) ** 2 > radius**2:
                    continue
            if x > x1 - radius and y > y1 - radius:
                if (x - (x1 - radius)) ** 2 + (y - (y1 - radius)) ** 2 > radius**2:
                    continue
            put(pixels, x, y, color)


def circle(pixels: list[list[int]], cx: int, cy: int, radius: int, color: int) -> None:
    r2 = radius * radius
    for y in range(cy - radius, cy + radius + 1):
        for x in range(cx - radius, cx + radius + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                put(pixels, x, y, color)


def ring(
    pixels: list[list[int]],
    cx: int,
    cy: int,
    radius: float,
    color: int,
    thickness: float = 1.0,
) -> None:
    outer = (radius + thickness / 2) ** 2
    inner = max(0.0, radius - thickness / 2) ** 2
    limit = int(radius + thickness + 2)
    for y in range(cy - limit, cy + limit + 1):
        for x in range(cx - limit, cx + limit + 1):
            distance = (x - cx) ** 2 + (y - cy) ** 2
            if inner <= distance <= outer:
                put(pixels, x, y, color)


def triangle(
    pixels: list[list[int]],
    cx: int,
    y0: int,
    y1: int,
    half_width: int,
    color: int,
) -> None:
    span = max(1, y1 - y0)
    for y in range(y0, y1 + 1):
        t = (y - y0) / span
        half = int(round(half_width * (1.0 - t)))
        for x in range(cx - half, cx + half + 1):
            put(pixels, x, y, color)


def draw_frame(index: int) -> list[list[int]]:
    pixels = blank()

    # Card
    rounded_rect(pixels, 3, 3, 60, 60, 10, 10)
    rounded_rect(pixels, 4, 4, 59, 59, 9, 1)

    # Pulse ring behind the pin
    phase = index % 8
    radius = 10.0 + phase * 1.65
    ring_color = 4 if phase < 4 else 11
    ring(pixels, 32, 27, radius, ring_color, thickness=1.0)
    if phase >= 4:
        ring(pixels, 32, 27, max(9.0, radius - 6.0), 2, thickness=1.0)

    # Location pin
    circle(pixels, 32, 25, 10, 2)
    circle(pixels, 32, 25, 5, 1)
    circle(pixels, 32, 25, 2, 4)
    triangle(pixels, 32, 31, 48, 9, 2)
    # little highlight
    for x, y in ((27, 19), (28, 18), (29, 17), (30, 17)):
        put(pixels, x, y, 11)

    # Three tiny "live" bars at the bottom of the card
    bar_colors = (4, 5, 7)
    for i, color in enumerate(bar_colors):
        height = 3 + ((index + i) % 3)
        x = 27 + i * 4
        rect(pixels, x, 55 - height, x + 2, 55, color)

    return pixels


# ----------------------------------------------------------------------
# GIF
# ----------------------------------------------------------------------
def lzw_fixed(indices: list[int], min_code_size: int = 8) -> bytes:
    """Encode with fixed 9-bit codes and frequent CLEAR codes.

    This intentionally avoids the variable-width LZW corner cases. It is
    larger than an optimal GIF, but tiny at 64x64 and extremely robust.
    """
    clear = 1 << min_code_size
    end = clear + 1
    code_size = min_code_size + 1
    codes: list[int] = [clear]
    count = 0
    for index in indices:
        codes.append(index)
        count += 1
        if count >= 200:
            codes.append(clear)
            count = 0
    codes.append(end)

    out = bytearray()
    bit_buffer = 0
    bit_count = 0
    for code in codes:
        bit_buffer |= code << bit_count
        bit_count += code_size
        while bit_count >= 8:
            out.append(bit_buffer & 0xFF)
            bit_buffer >>= 8
            bit_count -= 8
    if bit_count:
        out.append(bit_buffer & 0xFF)
    return bytes(out)


def sub_blocks(data: bytes) -> bytes:
    out = bytearray()
    for offset in range(0, len(data), 255):
        chunk = data[offset : offset + 255]
        out.append(len(chunk))
        out.extend(chunk)
    out.append(0)
    return bytes(out)


def write_gif(path: Path, frames: list[list[list[int]]], delay_cs: int = 8) -> None:
    palette = b"".join(bytes(color) for color in PALETTE)
    out = bytearray()
    out.extend(b"GIF89a")
    out.extend(struct.pack("<HHBBB", W, H, 0xF3, 0, 0))
    out.extend(palette)
    out.extend(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00")

    for frame in frames:
        indices = [pixel for row in frame for pixel in row]
        out.extend(b"\x21\xF9\x04")
        out.extend(bytes((0x04, delay_cs & 0xFF, delay_cs >> 8, 0)))
        out.append(0)
        out.append(0x2C)
        out.extend(struct.pack("<HHHH", 0, 0, W, H))
        out.append(0)
        out.append(8)  # LZW minimum code size
        out.extend(sub_blocks(lzw_fixed(indices, 8)))

    out.append(0x3B)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))


def validate_gif(path: Path) -> None:
    data = path.read_bytes()
    if not data.startswith(b"GIF89a"):
        raise ValueError("not a GIF89a file")
    pos = 13
    packed = data[10]
    if packed & 0x80:
        gct_size = 3 * (2 ** ((packed & 0x07) + 1))
        pos += gct_size

    decoded_frames = 0
    while pos < len(data):
        marker = data[pos]
        pos += 1
        if marker == 0x3B:
            break
        if marker == 0x21:
            label = data[pos]
            pos += 1
            if label == 0xF9:
                size = data[pos]
                pos += 1 + size + 1
            else:
                while True:
                    size = data[pos]
                    pos += 1
                    if size == 0:
                        break
                    pos += size
            continue
        if marker != 0x2C:
            raise ValueError(f"unexpected GIF block 0x{marker:02x}")
        pos += 8
        local_packed = data[pos]
        pos += 1
        if local_packed & 0x80:
            pos += 3 * (2 ** ((local_packed & 0x07) + 1))
        min_code_size = data[pos]
        pos += 1
        payload = bytearray()
        while True:
            size = data[pos]
            pos += 1
            if size == 0:
                break
            payload.extend(data[pos : pos + size])
            pos += size
        indices = lzw_decode(bytes(payload), min_code_size)
        if len(indices) != W * H:
            raise ValueError(f"frame has {len(indices)} pixels, expected {W * H}")
        decoded_frames += 1
    if decoded_frames != FRAMES:
        raise ValueError(f"decoded {decoded_frames} frames, expected {FRAMES}")


def lzw_decode(data: bytes, min_code_size: int) -> list[int]:
    clear = 1 << min_code_size
    end = clear + 1
    code_size = min_code_size + 1
    dictionary: dict[int, bytes] = {i: bytes((i,)) for i in range(clear)}
    next_code = end + 1
    previous: bytes | None = None
    output = bytearray()

    bit_pos = 0
    total_bits = len(data) * 8

    def read_code() -> int | None:
        nonlocal bit_pos
        if bit_pos + code_size > total_bits:
            return None
        value = 0
        for offset in range(code_size):
            byte_index = (bit_pos + offset) // 8
            bit_index = (bit_pos + offset) % 8
            if data[byte_index] & (1 << bit_index):
                value |= 1 << offset
        bit_pos += code_size
        return value

    while True:
        code = read_code()
        if code is None or code == end:
            break
        if code == clear:
            dictionary = {i: bytes((i,)) for i in range(clear)}
            next_code = end + 1
            code_size = min_code_size + 1
            previous = None
            continue
        if code in dictionary:
            entry = dictionary[code]
        elif code == next_code and previous is not None:
            entry = previous + previous[:1]
        else:
            raise ValueError(f"bad LZW code {code}")
        output.extend(entry)
        if previous is not None and next_code < 4096:
            dictionary[next_code] = previous + entry[:1]
            next_code += 1
            if next_code == (1 << code_size) and code_size < 12:
                code_size += 1
        previous = entry
    return list(output)


# ----------------------------------------------------------------------
# PNG / ICO
# ----------------------------------------------------------------------
def scale(pixels: list[list[int]], factor: int) -> list[list[int]]:
    return [
        [pixels[y // factor][x // factor] for x in range(W * factor)]
        for y in range(H * factor)
    ]


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, pixels: list[list[int]]) -> None:
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for index in row:
            raw.extend(PALETTE[index])
    payload = zlib.compress(bytes(raw), 9)
    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
    png.extend(png_chunk(b"IDAT", payload))
    png.extend(png_chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(png))


def write_ico(path: Path, png_256: Path) -> None:
    payload = png_256.read_bytes()
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(payload), 22)
    path.write_bytes(header + entry + payload)


def main() -> None:
    frames = [draw_frame(index) for index in range(FRAMES)]
    write_gif(ASSETS / "location.gif", frames)
    validate_gif(ASSETS / "location.gif")

    big = scale(frames[0], 4)
    write_png(ASSETS / "rpc-location.png", big)
    write_png(ASSETS / "icon.png", big)
    write_ico(ASSETS / "icon.ico", ASSETS / "icon.png")
    print("Generated:", ", ".join(str(p.relative_to(ROOT)) for p in (
        ASSETS / "location.gif",
        ASSETS / "rpc-location.png",
        ASSETS / "icon.png",
        ASSETS / "icon.ico",
    )))


if __name__ == "__main__":
    main()
