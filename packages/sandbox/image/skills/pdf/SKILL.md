# pdf — PDF documents

Use this skill to read text from `.pdf` files.

## Scripts

### extract.py

Print text content from a `.pdf`, page by page.

```
python /mnt/skills/public/pdf/extract.py <path-to-file.pdf>
```

Output is plain text with `--- page N ---` separators. PDFs that are pure
scans (image-only, no embedded text layer) will produce empty pages — OCR is
not performed.

## Direct pypdf usage

For metadata, structure, splitting, merging, or filling forms, import `pypdf`
directly. The library is preinstalled.

```python
from pypdf import PdfReader
reader = PdfReader("/path/to/file.pdf")
for page in reader.pages:
    text = page.extract_text()
```
