from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def preprocess(source: str, target: str) -> None:
    image = Image.open(source).convert("L")
    original_width, original_height = image.size
    probe = image.copy()
    probe.thumbnail((900, 900))
    pixels = probe.load()
    bright_columns = []
    for x in range(probe.width):
        bright = sum(1 for y in range(probe.height) if pixels[x, y] >= 155)
        bright_columns.append(bright / probe.height)
    runs = []
    start = None
    for x, ratio in enumerate(bright_columns + [0]):
        if ratio >= 0.28 and start is None:
            start = x
        elif ratio < 0.28 and start is not None:
            if x - start >= max(20, int(probe.width * 0.12)):
                runs.append((start, x))
            start = None
    if runs:
        left, right = max(runs, key=lambda run: run[1] - run[0])
        scale_x = original_width / probe.width
        pad_x = int(24 * scale_x)
        box = (max(0, int(left * scale_x) - pad_x), 0, min(original_width, int(right * scale_x) + pad_x), original_height)
        image = image.crop(box)
    image = ImageOps.autocontrast(image, cutoff=1)
    image = ImageEnhance.Contrast(image).enhance(1.35)
    image = image.filter(ImageFilter.MedianFilter(size=3)).filter(ImageFilter.SHARPEN)
    if image.width < 1000:
        scale = min(1.6, 1000 / image.width)
        image = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="JPEG", quality=92, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: ocr-preprocess.py INPUT OUTPUT")
    preprocess(sys.argv[1], sys.argv[2])
