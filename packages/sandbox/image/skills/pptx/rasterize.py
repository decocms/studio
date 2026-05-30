#!/usr/bin/env python3
"""Render specific .pptx slides at full resolution.

Same soffice + pdftoppm pipeline as `thumbnail.py`, but at higher DPI and
without the grid composition step. Useful when the model has already seen
the thumbnail grid and wants one slide back at higher fidelity.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _office import convert_to_pdf  # noqa: E402


def parse_pages(spec: str | None, total: int) -> list[int]:
    if spec is None:
        return list(range(1, total + 1))
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a), int(b) + 1))
        else:
            pages.add(int(part))
    return sorted(p for p in pages if 1 <= p <= total)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Rasterise pptx slides.")
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "--pages",
        default=None,
        help='Selection like "3" or "1,3-5"; defaults to all slides.',
    )
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory (default: <input-stem>.rasterized)",
    )
    args = parser.parse_args(argv)

    src = args.input.resolve()
    if not src.exists():
        print(f"input not found: {src}", file=sys.stderr)
        return 2

    out_dir = args.out or src.with_name(src.stem + ".rasterized")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        pdf = convert_to_pdf(src, tmp_path)
        info = subprocess.run(
            ["pdfinfo", str(pdf)], capture_output=True, text=True, check=True
        )
        total = 0
        for line in info.stdout.splitlines():
            if line.startswith("Pages:"):
                total = int(line.split(":", 1)[1].strip())
                break
        if total == 0:
            print("could not determine page count", file=sys.stderr)
            return 1

        pages = parse_pages(args.pages, total)
        if not pages:
            print("no pages to render", file=sys.stderr)
            return 1

        # Render one page at a time. pdftoppm zero-pads its output filename
        # based on the *total* page count of the source PDF, so producing a
        # sparse selection (e.g. 1,5,10) into a shared prefix is messy.
        # Per-page invocations keep the output predictable and let us name
        # the result deterministically as slide-NNN.jpg.
        for page in pages:
            prefix = tmp_path / f"page-{page}"
            subprocess.run(
                [
                    "pdftoppm",
                    "-jpeg",
                    "-r",
                    str(args.dpi),
                    "-f",
                    str(page),
                    "-l",
                    str(page),
                    str(pdf),
                    str(prefix),
                ],
                check=True,
            )
            matches = list(tmp_path.glob(f"{prefix.name}*.jpg"))
            if not matches:
                print(f"no output for page {page}", file=sys.stderr)
                return 1
            shutil.move(str(matches[0]), str(out_dir / f"slide-{page:03d}.jpg"))

    print(out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
