/** An analytics table as an `.xlsx` file: the columns a reader sees, raw values. */

import type { SheetData } from "write-excel-file/browser";

type Value = string | number | null;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Excel refuses these in a sheet name and caps it at 31 characters. */
export function sheetName(title: string): string {
  return (
    title
      .replace(/[[\]:*?/\\]/g, " ")
      .slice(0, 31)
      .trim() || "Sheet1"
  );
}

export function tableSheet(columns: string[], rows: Value[][]): SheetData {
  return [
    columns.map((value) => ({ value, fontWeight: "bold" as const })),
    ...rows.map((row) =>
      row.map((v) =>
        typeof v === "string" && ISO_TIMESTAMP.test(v) ? new Date(v) : v,
      ),
    ),
  ];
}

export async function downloadTable(
  title: string,
  columns: string[],
  rows: Value[][],
): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  await writeXlsxFile(tableSheet(columns, rows), {
    sheet: sheetName(title),
    stickyRowsCount: 1,
    dateFormat: "yyyy-mm-dd hh:mm",
  }).toFile(`${sheetName(title)}.xlsx`);
}
