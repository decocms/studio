# docx — Word documents

Use this skill to read or summarize `.docx` files.

## Scripts

### extract.py

Print text content from a `.docx` as plain text. Paragraphs are separated by
blank lines; tables are rendered with tab-separated cells.

```
python /mnt/skills/public/docx/extract.py <path-to-file.docx>
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
