#!/usr/bin/env python3
"""Unpack a .pptx archive's XML and media into a directory."""

import argparse
import shutil
import sys
import zipfile
from pathlib import Path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Unpack .pptx XML.")
    parser.add_argument("input", type=Path)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory (default: <input-stem>.unpacked)",
    )
    args = parser.parse_args(argv)

    src = args.input.resolve()
    if not src.exists():
        print(f"input not found: {src}", file=sys.stderr)
        return 2

    out_dir = args.out or src.with_name(src.stem + ".unpacked")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    with zipfile.ZipFile(src) as zf:
        zf.extractall(out_dir)

    print(out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
