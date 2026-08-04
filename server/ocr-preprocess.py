from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def preprocess(source: str, target: str) -> None:
    image = Image.open(source).convert("L")
    original_width, original_height = image.size
    probe = image.copy()
    probe.thumbnail((900, 900))
    mask = probe.point(lambda pixel: 255 if pixel >= 155 else 0)
    box = mask.getbbox()
    if box:
        probe_area = probe.width * probe.height
        box_area = (box[2] - box[0]) * (box[3] - box[1])
        if probe_area * 0.12 < box_area < probe_area * 0.92:
            scale_x = original_width / probe.width
            scale_y = original_height / probe.height
            pad_x = int(18 * scale_x)
            pad_y = int(18 * scale_y)
            box = (
                max(0, int(box[0] * scale_x) - pad_x),
                max(0, int(box[1] * scale_y) - pad_y),
                min(original_width, int(box[2] * scale_x) + pad_x),
                min(original_height, int(box[3] * scale_y) + pad_y),
            )
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
