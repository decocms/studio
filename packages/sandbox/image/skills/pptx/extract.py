#!/usr/bin/env python3
"""Extract text from a PowerPoint (.pptx) file."""

import argparse
import sys

from pptx import Presentation


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Extract text from a .pptx.")
    parser.add_argument("input")
    parser.add_argument(
        "--notes",
        action="store_true",
        help="Include speaker notes under a ### Notes subsection per slide.",
    )
    args = parser.parse_args(argv)

    prs = Presentation(args.input)
    for index, slide in enumerate(prs.slides, start=1):
        print(f"## Slide {index}")
        print()
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                text = "".join(run.text for run in paragraph.runs)
                if text.strip():
                    print(text)
        if args.notes and slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                print()
                print("### Notes")
                print()
                print(notes)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
