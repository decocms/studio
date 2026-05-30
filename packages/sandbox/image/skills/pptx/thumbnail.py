#!/usr/bin/env python3
"""Render a .pptx as a thumbnail-grid composite image plus per-slide JPGs.

Pipeline: LibreOffice headless renders the deck to PDF, `pdftoppm` rasterises
each page at 96 DPI, Pillow downscales and assembles a 4-column grid with a
small slide-number overlay in the top-left of each cell. Per-slide JPGs are
preserved in a sibling directory so the model can pull a single slide at full
resolution after spotting it in the grid.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from _office import convert_to_pdf  # noqa: E402

GRID_COLS = 4
THUMB_WIDTH = 320
GAP = 12
BG = (240, 240, 240)
LABEL_BG = (255, 255, 255)
LABEL_FG = (24, 24, 24)
LABEL_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Render a pptx as a thumbnail grid.")
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output composite image path (default: <input-stem>.thumbnail.jpg)",
    )
    args = parser.parse_args(argv)

    src = args.input.resolve()
    if not src.exists():
        print(f"input not found: {src}", file=sys.stderr)
        return 2

    out_grid = args.out or src.with_name(src.stem + ".thumbnail.jpg")
    out_slides_dir = src.with_name(src.stem + ".slides")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        pdf = convert_to_pdf(src, tmp_path)
        prefix = tmp_path / "slide"
        subprocess.run(
            ["pdftoppm", "-jpeg", "-r", "96", str(pdf), str(prefix)],
            check=True,
        )
        slides = sorted(tmp_path.glob("slide-*.jpg"))
        if not slides:
            print("no slides produced by pdftoppm", file=sys.stderr)
            return 1

        if out_slides_dir.exists():
            shutil.rmtree(out_slides_dir)
        out_slides_dir.mkdir(parents=True)
        slide_paths: list[Path] = []
        for i, src_jpg in enumerate(slides, start=1):
            dst = out_slides_dir / f"slide-{i:03d}.jpg"
            shutil.copy(src_jpg, dst)
            slide_paths.append(dst)

        thumbs = []
        for jpg in slide_paths:
            img = Image.open(jpg).convert("RGB")
            ratio = THUMB_WIDTH / img.width
            new_h = int(img.height * ratio)
            thumbs.append(img.resize((THUMB_WIDTH, new_h), Image.LANCZOS))

        thumb_h = thumbs[0].height
        n = len(thumbs)
        rows = (n + GRID_COLS - 1) // GRID_COLS
        comp_w = GRID_COLS * THUMB_WIDTH + (GRID_COLS + 1) * GAP
        comp_h = rows * thumb_h + (rows + 1) * GAP
        comp = Image.new("RGB", (comp_w, comp_h), BG)

        try:
            font = ImageFont.truetype(LABEL_FONT_PATH, 18)
        except OSError:
            font = ImageFont.load_default()

        for idx, thumb in enumerate(thumbs):
            row, col = divmod(idx, GRID_COLS)
            x = GAP + col * (THUMB_WIDTH + GAP)
            y = GAP + row * (thumb_h + GAP)
            comp.paste(thumb, (x, y))
            label = str(idx + 1)
            label_w = 14 + len(label) * 11
            label_h = 26
            label_box = Image.new("RGB", (label_w, label_h), LABEL_BG)
            ImageDraw.Draw(label_box).text((6, 2), label, fill=LABEL_FG, font=font)
            comp.paste(label_box, (x + 6, y + 6))

        comp.save(out_grid, "JPEG", quality=85)

    print(out_grid)
    print(out_slides_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
