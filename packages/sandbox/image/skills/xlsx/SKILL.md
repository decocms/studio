# xlsx — Excel spreadsheets

Use this skill to read or summarize `.xlsx` files.

## Scripts

### extract.py

Print sheet contents from an `.xlsx` as TSV. Each sheet is preceded by a
`--- sheet "<name>" ---` header.

```
python /mnt/skills/public/xlsx/extract.py <path-to-file.xlsx>
```

Empty trailing rows and columns are trimmed. Cell values are stringified;
formulas show their cached value, not the formula text.

## Direct openpyxl usage

For richer operations (formulas, formatting, charts, writing workbooks),
import `openpyxl` directly. The library is preinstalled.

```python
from openpyxl import load_workbook
wb = load_workbook("/path/to/file.xlsx", data_only=True)
for sheet in wb.worksheets:
    for row in sheet.iter_rows(values_only=True):
        ...
```
