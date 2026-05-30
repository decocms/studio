# Skills features checklist

Tracking sheet for the static skills shipped at `/mnt/skills/public/` inside
the sandbox image. The full feature surface below is the long-term target
(inspired by Anthropic's claude.ai sandbox design); items marked **v1** are
the prioritized reading-focused milestone.

Status legend:
- `- [x]` shipped
- `- [ ]` not yet shipped
- **v1** = part of the first reading-focused milestone (must-ship)
- _no v1 marker_ = later milestone (creation, XML round-trip editing,
  tracked changes, form filling, etc.)

System-level dependency callouts use the `> deps:` admonition so we can plan
the image-size impact ahead of time.

---

## docx

### Reading & extraction
- [x] **v1** Plain-text dump of a document (paragraph order preserved, basic markdown)
- [ ] **v1** Tracked-changes-aware extraction (show insertions/deletions vs. accept them)
- [ ] **v1** Raw XML access by unpacking the `.docx` zip into a directory
- [ ] **v1** Page-by-page rasterization to images (via PDF intermediate) for visual inspection
- [ ] Programmatically accept all tracked changes to produce a clean copy
- [ ] **v1** Convert legacy `.doc` to `.docx` first (LibreOffice headless conversion)

### Creating new documents (from scratch)
- [ ] Set page size and margins explicitly (US Letter vs A4, portrait/landscape)
- [ ] Custom paragraph styles, including overriding built-in heading styles (Heading 1, 2, …)
- [ ] Fonts, sizes, weights, colors at run level
- [ ] Bulleted and numbered lists via real numbering definitions (not unicode bullets)
- [ ] Multi-level lists with continuation vs. restart behavior
- [ ] Tables with: column widths, cell widths, borders, shading, padding, vertical alignment
- [ ] Hyperlinks (external) and internal cross-references with bookmarks
- [ ] Headers and footers, including different first-page or odd/even
- [ ] Page numbers and total page count fields
- [ ] Page breaks and section breaks
- [ ] Multi-column layouts
- [ ] Tab stops with leaders (useful for two-column footers, TOC dot leaders)
- [ ] Footnotes and endnotes
- [ ] Embedded images with explicit sizing
- [ ] Auto-generated table of contents (driven by heading outline levels)
- [ ] File validation pass after generation

### Editing existing documents (XML round-trip)
- [ ] Unpack → edit XML → repack workflow with auto-repair on pack
- [ ] Pretty-printing on unpack so XML is human-editable
- [ ] Smart-quote preservation across the round-trip
- [ ] Find-and-replace at the run/text level
- [ ] Inserting and replacing inline images (requires updating media folder + relationships + content types + document XML in lockstep)

### Tracked changes & comments
- [ ] Insert tracked insertions (`<w:ins>`) with author and timestamp
- [ ] Insert tracked deletions (`<w:del>` + `<w:delText>`) with author and timestamp
- [ ] Reject another author's insertion (nested deletion inside their insertion)
- [ ] Restore another author's deletion (sibling insertion)
- [ ] Delete entire paragraphs/list items cleanly (mark paragraph mark as deleted)
- [ ] Add comments anchored to a text range
- [ ] Add threaded replies to existing comments
- [ ] Custom comment author names

> **deps:** `python-docx` (Python), `pandoc`, LibreOffice headless, Poppler (`pdftoppm`)

---

## pptx

### Reading & inspection
- [x] **v1** Per-slide text extraction with `## Slide N` section headers
- [ ] **v1** Visual thumbnail grid of all slides as a single composite image (overview at a glance)
- [ ] **v1** Per-slide full-resolution rasterization (via PDF intermediate)
- [ ] **v1** Raw XML unpack of the `.pptx` zip

> **Important for v1:** the thumbnail-grid script is a load-bearing
> capability for this milestone. Implementation path: LibreOffice headless
> renders `.pptx` → PDF, `pdftoppm` rasterizes pages → Pillow composes a
> grid image at a fixed cell size (e.g. 4 columns × N rows). The script
> should print the path to the resulting image so the model can read it
> back as a multimodal attachment.

### Creating from scratch (no template)
- [ ] Slide creation with arbitrary layouts using `pptxgenjs` (Node) or `python-pptx`
- [ ] Text boxes with full typography (font family, size, weight, color, alignment, line spacing)
- [ ] Shapes (rectangles, circles, lines, arrows) with fill, stroke, opacity
- [ ] Native charts (bar, line, pie, etc.)
- [ ] Tables
- [ ] Images (embedded, sized, positioned)
- [ ] Slide masters and per-slide layouts
- [ ] Speaker notes
- [ ] Color palettes / theming

### Editing an existing template (XML round-trip)
- [ ] Unpack → manipulate slides → edit content → clean → pack
- [ ] Duplicate a slide (with all the side-effect updates: notes refs, content types, relationship IDs)
- [ ] Add a slide from a layout
- [ ] Delete a slide (remove from `<p:sldIdLst>`, then clean up orphans)
- [ ] Reorder slides
- [ ] Clean up orphaned media and relationships
- [ ] Edit slide content text via direct XML edits
- [ ] Preserve smart quotes across the round-trip
- [ ] Preserve formatting (`<a:rPr>` runs) when changing text
- [ ] Bold inline labels, headers, titles
- [ ] Use proper bullet formatting (inherit from layout, or set `<a:buChar>` / `<a:buAutoNum>`)

### Quality & visual QA loop
- [ ] Check for leftover placeholder text (lorem ipsum, "XXXX", "[insert]")
- [ ] Convert deck → PDF → JPGs → visually inspect for overflow, overlap, low contrast, misalignment, missing margins
- [ ] Iterate on fixes once, then stop (avoid infinite polishing loops)

### Encoded design system (for the eventual creation skill)
- [ ] Color palette suggestions tied to topic (don't default to blue)
- [ ] Typography pairings (header font + body font)
- [ ] Layout variety (don't repeat the same layout across slides)
- [ ] Spacing rules (0.5" min margins, 0.3–0.5" between blocks)
- [ ] Anti-patterns to avoid (accent lines under titles, full-width colored bars, cream backgrounds, text-only slides, overflow)

> **deps:** `python-pptx` (Python), Pillow, LibreOffice headless, Poppler (`pdftoppm`)

---

## xlsx

### Reading & analysis
- [x] **v1** Quick text dump of all sheets (tab-separated rows under sheet headers)
- [ ] **v1** Same dump for `.xlsm` (just override the format)
- [ ] **v1** Pandas-based analysis (`read_excel`, `head`, `info`, `describe`, multi-sheet load)
- [x] **v1** Read-only mode for very large files
- [x] **v1** Read calculated values (vs. formulas) via `data_only=True`

### Creating new files
- [ ] New workbook with multiple sheets (openpyxl)
- [ ] Cell values, ranges, append rows
- [ ] Excel formulas as strings (`=SUM(...)`, `=AVERAGE(...)`, etc.)
- [ ] Cross-sheet references (`Sheet1!A1`)
- [ ] Cell formatting: font (family, size, bold, color), fill (background color), alignment, number formats
- [ ] Column widths and row heights
- [ ] Merged cells
- [ ] Conditional formatting
- [ ] Charts (bar, line, pie, scatter) bound to data ranges
- [ ] Named ranges
- [ ] Cell comments / notes
- [ ] Data validation (dropdowns, restricted input)
- [ ] Freeze panes, hidden rows/columns

### Editing existing files
- [ ] Load + modify while preserving formulas and formatting (openpyxl, not pandas)
- [ ] Insert/delete rows and columns
- [ ] Add new sheets
- [ ] Iterate all sheets by name
- [ ] Watch out: opening with `data_only=True` and saving destroys formulas

### Formula recalculation pipeline
- [ ] After any openpyxl write, formulas exist as strings but have no cached values
- [ ] Recalculate by opening in LibreOffice headless and triggering a recalc-and-save
- [ ] Scan all cells afterward for `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?`
- [ ] Return structured error report (count + locations) so you can fix and re-run

### Standards/conventions encoded in SKILL.md (for the eventual creation skill)
- [ ] Financial-model color coding (blue=input, black=formula, green=cross-sheet link, red=external link, yellow=key assumption)
- [ ] Number formats: years as text, currency `$#,##0`, zeros as `-`, parens for negatives, `0.0x` for multiples
- [ ] Always reference assumption cells, never hardcode values inside formulas
- [ ] Document hardcoded inputs with source citations
- [ ] Use formulas, not Python-computed-and-pasted values, so the model stays live

> **deps:** `openpyxl`, `pandas` (Python), LibreOffice headless

---

## pdf (creation & manipulation)

> Reading lives in the separate `pdf-reading` skill below. This skill is
> entirely **later milestones** — none of it is in v1.

### Creation
- [ ] Low-level canvas drawing (text, lines, shapes at coordinates) via `reportlab` Canvas
- [ ] High-level document flow (paragraphs, headings, page breaks, spacers) via `reportlab` Platypus
- [ ] Page size and orientation control
- [ ] Subscripts/superscripts via XML markup tags (NOT unicode characters — they render as black boxes in built-in fonts)
- [ ] JavaScript alternative: `pdf-lib`

### Merging & splitting
- [ ] Concatenate multiple PDFs into one (`pypdf` or `qpdf --empty --pages`)
- [ ] Split into one-file-per-page
- [ ] Extract a page range into a new file (`qpdf input.pdf --pages . 1-5 -- out.pdf`)
- [ ] `pdftk` equivalents if available

### Page operations
- [ ] Rotate pages (any multiple of 90°), single page or all
- [ ] Reorder pages
- [ ] Delete pages

### Watermarking
- [ ] Overlay a watermark PDF page onto every page of a target PDF (`merge_page`)

### Image extraction
- [ ] All embedded raster images via `pdfimages -j` (JPG) or `-png`
- [ ] Specific page ranges
- [ ] Original format preservation with `-all`

### OCR (scanned PDFs)
- [ ] Convert pages to images with `pdf2image`
- [ ] Run `pytesseract` on each image to recover text

### Encryption / decryption
- [ ] Encrypt with user and owner passwords
- [ ] Decrypt with `qpdf --password=... --decrypt`

### Form filling
- [ ] Detect whether a PDF has fillable fields
- [ ] Extract field metadata (name, page, bounding box, type, options for checkboxes/radios/dropdowns)
- [ ] Fill text fields, set checkbox states, choose radio option, pick dropdown value
- [ ] Fall-back path for non-fillable PDFs: place text annotations at coordinates
- [ ] Validate field IDs and values before writing

### Metadata
- [ ] Read/write title, author, subject, creator, producer

> **deps:** `pypdf`, `reportlab`, `pdfplumber`, `pdf2image`, `pytesseract` (Python); `pypdfium2` for higher-fidelity rendering; `qpdf`, `pdftk`, Poppler suite (CLI); Tesseract binary

---

## pdf-reading

> This skill does not yet exist in `/mnt/skills/public/` — it needs to be
> split out from the current `pdf` skill. **Entirely v1.**

### Diagnostic content inventory (run before anything else)
- [ ] **v1** Page count, file size, version, metadata (`pdfinfo`)
- [ ] **v1** Quick "is this text or scanned?" check (`pdftotext` first page sample)
- [ ] **v1** List of embedded raster images with size/color/compression (`pdfimages -list`)
- [ ] **v1** List of file attachments embedded in the PDF (`pdfdetach -list`)
- [ ] **v1** Font report — embedded? custom encoding? (`pdffonts`) — diagnoses garbled extraction

### Text extraction strategies
- [x] **v1** Basic: `pypdf` page-by-page _(lives in `pdf/extract.py` today; needs reorganizing under `pdf-reading/`)_
- [ ] **v1** Layout-preserving for multi-column: `pdftotext -layout`
- [ ] **v1** Layout-aware with positioning data: `pdfplumber`
- [ ] **v1** Page range selection (`-f` first, `-l` last)

### Visual inspection
- [ ] **v1** Rasterize a single page (or range) at chosen DPI with `pdftoppm`
- [ ] **v1** Awareness of zero-padded filename behavior (depends on total page count)
- [ ] **v1** Token-cost tradeoff between text extraction (~200–400 tok/page) and rasterized image (~1,600 tok/page) — encoded in `SKILL.md` prose

### Strategy decision tree (the real value of this skill)
- [ ] **v1** Text-heavy → text extraction primary, rasterize specific figures
- [ ] **v1** Scanned → rasterize + OCR
- [ ] **v1** Slide-deck PDFs → rasterize per-page on demand
- [ ] **v1** Forms → extract field values programmatically
- [ ] **v1** Data-heavy → `pdfplumber` for tables + rasterize for charts

### Table extraction
- [ ] **v1** `pdfplumber` `page.extract_tables()`
- [ ] Convert to pandas DataFrame, combine across pages, export to xlsx _(later — write step)_

### Embedded image extraction
- [ ] **v1** All / specific page range / original-format flags via `pdfimages`
- [ ] **v1** Programmatic alternative with PyMuPDF (`fitz`) including position data and color-space normalization
- [ ] **v1** Gotcha awareness: vector charts (matplotlib/Excel) won't appear — must rasterize the whole page _(in `SKILL.md`)_
- [ ] **v1** Gotcha awareness: tiny "empty" images are usually masks/decoration; filter by file size _(in `SKILL.md`)_

### Attachment extraction
- [ ] **v1** List, save-all, save-by-index via `pdfdetach`
- [ ] **v1** Programmatic via `pypdf`'s `reader.attachments` (sanitize filenames!)
- [ ] **v1** Awareness of two attachment mechanisms (page-level annotations vs. document-level EmbeddedFiles tree)

### Form field reading (read-only — filling lives in the `pdf` skill)
- [ ] **v1** Text-only fields via `get_form_text_fields()`
- [ ] **v1** All field types (checkbox, radio, dropdown) via `get_fields()` with `/V` and `/FT` keys
- [ ] Comprehensive metadata via `pdftk dump_data_fields`

### Rare embedded media
- [ ] Audio/video/3D — first check `pdfdetach`, fall back to PyMuPDF page annotations

### Font diagnostics
- [ ] **v1** Identify non-embedded fonts or Identity-H encodings without CIDToGID maps as the cause of garbled extraction → fall back to rasterization _(in `SKILL.md`)_

### OCR (for scanned PDFs detected by the diagnostic step)
- [ ] **v1** Convert pages to images with `pdf2image`
- [ ] **v1** Run `pytesseract` on each image to recover text

> **deps:** `pypdf`, `pdfplumber`, `pymupdf` / `fitz` (Python); Poppler suite (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`, `pdfdetach`, `pdffonts`); `qpdf`; for OCR: `pytesseract` + `pdf2image` + Tesseract binary

---

## file-reading (router)

- [x] **v1** Map extension → which sub-skill to invoke
- [ ] **v1** Update routing table once `pdf-reading` is split out from `pdf`
- [ ] **v1** Mention `file <path>` fallback for unknown formats

---

## v1 summary — what we're shipping in the reading milestone

In rough sequence:

1. **`pdf-reading`** — split from current `pdf/`, add `pdfinfo` diagnostic, layout-preserving extraction, rasterization, OCR fallback, table extraction, attachment extraction, form-field reading, and the strategy decision tree in `SKILL.md`.
2. **`pptx`** thumbnail grid + per-slide rasterization + raw XML unpack. The grid is the headline capability.
3. **`xlsx`** pandas-analysis script + `.xlsm` support.
4. **`docx`** tracked-changes-aware extraction, raw XML unpack, page rasterization, legacy `.doc`→`.docx` conversion.
5. **`file-reading`** routing table updated.
6. **`SKILL.md` prose pass** — fold the pitfall lists from this doc (smart quotes, formula recalc, vector-chart pdfimages gap, font diagnostics, etc.) into the per-skill `SKILL.md` files. This is where the real model UX value lives.

System dependencies that need to land in the Dockerfile for v1:

- LibreOffice headless (`libreoffice-core`, `libreoffice-impress`, `libreoffice-calc`, `libreoffice-writer` — pick the minimum that covers what we need)
- Poppler suite (`poppler-utils` Debian package: `pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`, `pdfdetach`, `pdffonts`)
- `qpdf`
- Tesseract OCR (`tesseract-ocr` + at minimum `tesseract-ocr-eng`)
- Pillow (Python; pulls in libjpeg/libpng via wheels — may already be present transitively)
- `pdfplumber`, `pymupdf`, `pdf2image`, `pytesseract`, `pandas` (Python)

Estimated image-size impact: roughly +1–1.5GB compressed (LibreOffice dominates at ~500MB; Tesseract + language data ~150MB; the rest is small). Acceptable for a sandbox image.
