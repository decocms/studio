# pptx — PowerPoint presentations

Reading and inspection of `.pptx` files. Editing and creation are not yet
supported.

## Quick reference

| Task                          | Command                                       |
| ----------------------------- | --------------------------------------------- |
| Plain-text dump               | `pptx-extract <file.pptx>`                    |
| Plain-text + speaker notes    | `pptx-extract --notes <file.pptx>`            |
| Visual overview (grid image)  | `pptx-thumbnail <file.pptx>`                  |
| One slide at full resolution  | `pptx-rasterize --pages 3 <file.pptx>`        |
| Several slides                | `pptx-rasterize --pages 1,3-5 <file.pptx>`    |
| Raw XML inspection            | `pptx-unpack <file.pptx>`                     |

Every command writes its output next to the input file and prints the
output path(s) on stdout.

## Reading text

`pptx-extract` prints each slide as a `## Slide N` section followed by the
visible text. Speaker notes are excluded by default; pass `--notes` to
include them under a `### Notes` subsection per slide.

## Visual overview

`pptx-thumbnail` produces two artifacts:

- A composite grid image at `<input-stem>.thumbnail.jpg` — 4-column grid
  with a small slide-number overlay on each cell. Suitable for a single
  multimodal read to get the shape of the deck.
- A directory `<input-stem>.slides/` containing per-slide JPGs at the
  same resolution. When a slide in the grid looks interesting, read
  `slide-NNN.jpg` directly instead of re-running `pptx-thumbnail`.

To actually see the rendered image, call the `read` tool on the path
`pptx-thumbnail` printed:

```
read /home/sandbox/deck.thumbnail.jpg
```

The image is injected into the next turn as a vision input.

## Per-slide rasterization

`pptx-rasterize` renders specific slides at higher DPI (default 150) into
`<input-stem>.rasterized/slide-NNN.jpg`. Use `--pages 3` for a single
slide or `--pages 1,3-5` for a selection. Override DPI with `--dpi`.

Pass the resulting path to the `read` tool to actually see the slide.

## Raw XML

`pptx-unpack` unzips the `.pptx` into `<input-stem>.unpacked/`. Useful
locations inside:

- `ppt/slides/slideN.xml` — slide content
- `ppt/notesSlides/notesSlideN.xml` — speaker notes
- `ppt/media/` — embedded images
- `ppt/theme/` — color palette and font definitions

## Direct python-pptx usage

For programmatic access beyond what these scripts cover (table cell data,
shape positions, layout metadata, etc.), import `pptx` directly. The
library is preinstalled.

```python
from pptx import Presentation
prs = Presentation("/path/to/file.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        ...
```
