#!/usr/bin/env python3
"""Apply the mv3c brand to a pinned LibreChat source checkout.

This deliberately does NOT rename @librechat/* internal packages, routes or
database schema identifiers: those are implementation contracts, not branding.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import zlib
from pathlib import Path

BRAND = "mv3c"
LOGO = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="mv3c">
  <defs><linearGradient id="mv3c" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#0f172a"/>
  </linearGradient></defs>
  <rect x="20" y="20" width="472" height="472" rx="110" fill="url(#mv3c)"/>
  <path d="M118 317 V166 L256 274 L394 166 V317" fill="none"
    stroke="#ffffff" stroke-width="43" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="256" y="417" text-anchor="middle" fill="#ffffff"
    font-family="Arial, Helvetica, sans-serif" font-size="79" font-weight="700">mv3c</text>
</svg>
"""

def replace_literal(root: Path, name: str, before: str, after: str) -> None:
    path = root / name
    value = path.read_text(encoding="utf-8")
    if before in value:
        value = value.replace(before, after, 1)
        path.write_text(value, encoding="utf-8")
    elif after not in value:
        raise RuntimeError(f"Upstream changed {name}: expected branding anchor missing: {before!r}")

def _distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def icon_png(size: int) -> bytes:
    """Generate deterministic RGBA PNG icons using only the Python standard library."""
    raw = bytearray()
    strokes = ((0.24, 0.70, 0.24, 0.31), (0.24, 0.31, 0.50, 0.55),
               (0.50, 0.55, 0.76, 0.31), (0.76, 0.31, 0.76, 0.70))
    for y in range(size):
        raw.append(0)
        for x in range(size):
            px, py = (x + 0.5) / size, (y + 0.5) / size
            # Rounded-square tile with dark-blue gradient.
            cx = max(0.13, min(0.87, px))
            cy = max(0.13, min(0.87, py))
            inside = (px - cx) ** 2 + (py - cy) ** 2 <= 0.13 ** 2
            if not inside:
                raw.extend((0, 0, 0, 0))
                continue
            d = min(_distance(px, py, *segment) for segment in strokes)
            edge = 0.044
            aa = max(0.0, min(1.0, (edge + 1 / size - d) * size))
            t = (px + py) / 2
            bg = (round(36 - 21 * t), round(99 - 76 * t), round(235 - 185 * t))
            raw.extend(tuple(round(bg[k] * (1 - aa) + 255 * aa) for k in range(3)) + (255,))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")

def apply(root: Path) -> None:
    if not (root / "client/index.html").is_file():
        raise RuntimeError("Full LibreChat source not imported; refusing partial brand patch")
    replace_literal(root, "client/index.html", "<title>LibreChat</title>", "<title>mv3c</title>")
    replace_literal(root, "client/index.html",
                    "LibreChat - An open source chat application with support for multiple AI models",
                    "mv3c - AI chat powered by chat2api")
    replace_literal(root, "client/vite.config.ts", "name: 'LibreChat'", "name: 'mv3c'")
    replace_literal(root, "client/vite.config.ts", "short_name: 'LibreChat'", "short_name: 'mv3c'")
    replace_literal(root, "client/src/utils/documentTitle.ts",
                    "DEFAULT_APP_TITLE = 'LibreChat'", "DEFAULT_APP_TITLE = 'mv3c'")
    replace_literal(root, "client/src/components/Auth/AuthLayout.tsx",
                    "startupConfig?.appTitle ?? 'LibreChat'", "startupConfig?.appTitle ?? 'mv3c'")
    package = root / "package.json"
    data = json.loads(package.read_text(encoding="utf-8"))
    data["name"] = BRAND
    package.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lock = root / "package-lock.json"
    lock_data = json.loads(lock.read_text(encoding="utf-8"))
    lock_data["name"] = BRAND
    if "" in lock_data.get("packages", {}):
        lock_data["packages"][""]["name"] = BRAND
    lock.write_text(json.dumps(lock_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assets = root / "client/public/assets"
    (assets / "logo.svg").write_text(LOGO, encoding="utf-8")
    for filename, size in (("favicon-16x16.png", 16), ("favicon-32x32.png", 32),
                           ("apple-touch-icon-180x180.png", 180), ("icon-192x192.png", 192),
                           ("maskable-icon.png", 512)):
        (assets / filename).write_bytes(icon_png(size))
    readme = root / "README.md"
    original = readme.read_text(encoding="utf-8")
    upstream_copy = root / "mv3c/UPSTREAM_README.md"
    if not upstream_copy.exists() and "LibreChat" in original:
        upstream_copy.write_text(original, encoding="utf-8")
    root_docs = (root / "mv3c/README.md").read_text(encoding="utf-8")
    # The source guide lives under mv3c/, while the root README is copied one level up.
    for nested, root_link in (
        ("../librechat.yaml", "librechat.yaml"),
        ("../.mv3c-upstream-imported", ".mv3c-upstream-imported"),
        ("../LICENSE", "LICENSE"),
        ("(UPSTREAM_README.md)", "(mv3c/UPSTREAM_README.md)"),
    ):
        root_docs = root_docs.replace(nested, root_link)
    readme.write_text(root_docs, encoding="utf-8")

def check(root: Path) -> None:
    anchors = {
        "client/index.html": "<title>mv3c</title>",
        "client/vite.config.ts": "short_name: 'mv3c'",
        "client/src/utils/documentTitle.ts": "DEFAULT_APP_TITLE = 'mv3c'",
        "client/public/assets/logo.svg": 'aria-label="mv3c"',
        "README.md": "# mv3c",
    }
    for filename, marker in anchors.items():
        if marker not in (root / filename).read_text(encoding="utf-8"):
            raise RuntimeError(f"mv3c branding missing in {filename}")
    if json.loads((root / "package.json").read_text())["name"] != BRAND:
        raise RuntimeError("package.json project name is not mv3c")
    if json.loads((root / "package-lock.json").read_text())["name"] != BRAND:
        raise RuntimeError("package-lock.json project name is not mv3c")
    for filename, size in (("favicon-16x16.png", 16), ("favicon-32x32.png", 32),
                           ("apple-touch-icon-180x180.png", 180), ("icon-192x192.png", 192),
                           ("maskable-icon.png", 512)):
        data = (root / "client/public/assets" / filename).read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or struct.unpack(">II", data[16:24]) != (size, size):
            raise RuntimeError(f"Invalid branded PNG: {filename}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    (check if args.check else apply)(Path(args.root).resolve())
    print("mv3c branding OK" if args.check else "mv3c branding applied")
