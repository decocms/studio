#!/usr/bin/env python3
"""Extract text from a PDF file, page by page."""

import sys

from pypdf import PdfReader


def main(path: str) -> int:
    reader = PdfReader(path)
    for index, page in enumerate(reader.pages, start=1):
        print(f"--- page {index} ---")
        text = page.extract_text() or ""
        print(text.strip())
        print()
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: extract.py <file.pdf>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
