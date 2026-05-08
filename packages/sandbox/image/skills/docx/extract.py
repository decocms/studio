#!/usr/bin/env python3
"""Extract text from a Word (.docx) file."""

import sys

from docx import Document


def main(path: str) -> int:
    doc = Document(path)
    for paragraph in doc.paragraphs:
        if paragraph.text.strip():
            print(paragraph.text)
        else:
            print()
    for table in doc.tables:
        print()
        for row in table.rows:
            print("\t".join(cell.text for cell in row.cells))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: extract.py <file.docx>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
