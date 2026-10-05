---
name: file-reading
description: Route a file to the right reader by extension (pptx, docx, xlsx, pdf, and plain text). Use as the entry point when asked to read or summarize an uploaded file of unknown type.
---

# file-reading — router by file type

When asked to read or summarize a file, dispatch by extension to the
appropriate skill under `/app/org/public/core/`:

| Extension     | Skill  | Script                                        |
| ------------- | ------ | --------------------------------------------- |
| `.pptx`       | `pptx` | `python /app/org/public/core/pptx/extract.py` |
| `.docx`       | `docx` | `python /app/org/public/core/docx/extract.py` |
| `.xlsx`       | `xlsx` | `python /app/org/public/core/xlsx/extract.py` |
| `.pdf`        | `pdf`  | `python /app/org/public/core/pdf/extract.py`  |
| `.txt`, `.md` | —      | `cat`                                         |
| `.csv`        | —      | `cat` (or `column -t -s,` for alignment)      |
| `.json`       | —      | `cat` (or `jq .` if structure matters)        |

For extensions not listed, read the corresponding `SKILL.md` under
`/app/org/public/core/` if one exists, otherwise fall back to `file <path>` to
identify the format and proceed manually.
