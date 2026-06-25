---
name: docx
description: Read and extract text, tables, and structure from .docx Word documents. Use when the user uploads or references a Word file to read or summarize.
---

# docx — Word documents

Use this skill to read or summarize `.docx` files.

## Scripts

### extract.py

Print text content from a `.docx` as plain text. Paragraphs are separated by
blank lines; tables are rendered with tab-separated cells.

```
python org/public/core/docx/extract.py <path-to-file.docx>
```

## Direct python-docx usage

For headings, styles, tables, images, or editing, import `docx` directly. The
library is preinstalled.

```python
from docx import Document
doc = Document("/path/to/file.docx")
for paragraph in doc.paragraphs:
    ...
```
