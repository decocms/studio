# file-reading — router by file type

When asked to read or summarize a file, dispatch by extension to the
appropriate skill under `/mnt/skills/public/`:

| Extension     | Skill   | Script                                        |
| ------------- | ------- | --------------------------------------------- |
| `.pptx`       | `pptx`  | `python /mnt/skills/public/pptx/extract.py`   |
| `.docx`       | `docx`  | `python /mnt/skills/public/docx/extract.py`   |
| `.xlsx`       | `xlsx`  | `python /mnt/skills/public/xlsx/extract.py`   |
| `.pdf`        | `pdf`   | `python /mnt/skills/public/pdf/extract.py`    |
| `.txt`, `.md` | —       | `cat`                                         |
| `.csv`        | —       | `cat` (or `column -t -s,` for alignment)      |
| `.json`       | —       | `cat` (or `jq .` if structure matters)        |

For extensions not listed, read the corresponding `SKILL.md` under
`/mnt/skills/public/` if one exists, otherwise fall back to `file <path>` to
identify the format and proceed manually.
