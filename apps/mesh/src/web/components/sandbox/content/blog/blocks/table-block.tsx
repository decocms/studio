import { Plus, Trash01 } from "@untitledui/icons";
import { AddButton, parseJsonArray, str } from "./primitives";

/**
 * Inline editor for the blog Table block (`blog/sections/blocks/Table.tsx`).
 * The section stores `headers` as a JSON-encoded `string[]` and `rows` as a
 * JSON-encoded `string[][]` (body rows × cells), each tolerant of already
 * being an array. Cells accept inline HTML (the section sanitizes them), but
 * the editor keeps plain text inputs — authors type text and the grid stays
 * legible.
 *
 * A fresh block (no stored headers/rows) starts from a 2×2 template — two
 * headers and two rows — so authors see a usable grid immediately. Once data
 * exists the grid can shrink down to a single column and a single row, so
 * deleting the second header actually removes it. Header cells left entirely
 * blank persist as `[]` so the site renders no header row, matching the
 * section's optional-header semantics — the editor still shows the blank
 * header inputs so the columns stay labelable after a reload.
 */

const TEMPLATE_COLS = 2;
const TEMPLATE_ROWS = 2;

function parseHeaders(value: unknown): string[] {
  return parseJsonArray<unknown>(value).map(str);
}

function parseRows(value: unknown): string[][] {
  return parseJsonArray<unknown>(value).map((row) =>
    Array.isArray(row) ? row.map(str) : [],
  );
}

function emptyRow(cols: number): string[] {
  return Array.from({ length: cols }, () => "");
}

export function TableBlock({
  headers,
  rows,
  onChange,
}: {
  headers: string;
  rows: string;
  onChange: (next: { headers: string; rows: string }) => void;
}) {
  const head = parseHeaders(headers);
  const body = parseRows(rows);

  // A never-edited block has neither headers nor rows — show the starter
  // template. Any stored data (even a single blank cell) opts out of it, so
  // the grid can shrink to one column / one row.
  const isEmpty = head.length === 0 && body.length === 0;
  const colCount = isEmpty
    ? TEMPLATE_COLS
    : Math.max(head.length, ...body.map((row) => row.length), 1);

  // Pad the parsed data out to a rectangular grid so every render has a
  // consistent column count regardless of ragged stored rows.
  const displayHead = Array.from({ length: colCount }, (_, c) => head[c] ?? "");
  const displayBody = isEmpty
    ? Array.from({ length: TEMPLATE_ROWS }, () => emptyRow(colCount))
    : body.map((row) =>
        Array.from({ length: colCount }, (_, c) => row[c] ?? ""),
      );

  const commit = (nextHead: string[], nextBody: string[][]) =>
    onChange({
      // A fully blank header row collapses to [] → no <thead> on the site.
      headers: JSON.stringify(
        nextHead.some((cell) => cell.trim() !== "") ? nextHead : [],
      ),
      rows: JSON.stringify(nextBody),
    });

  const setHeader = (c: number, value: string) =>
    commit(
      displayHead.map((cell, i) => (i === c ? value : cell)),
      displayBody,
    );

  const setCell = (r: number, c: number, value: string) =>
    commit(
      displayHead,
      displayBody.map((row, ri) =>
        ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row,
      ),
    );

  const addRow = () =>
    commit(displayHead, [...displayBody, emptyRow(colCount)]);

  const removeRow = (r: number) =>
    commit(
      displayHead,
      displayBody.filter((_, i) => i !== r),
    );

  const addColumn = () =>
    commit(
      [...displayHead, ""],
      displayBody.map((row) => [...row, ""]),
    );

  const removeColumn = (c: number) =>
    commit(
      displayHead.filter((_, i) => i !== c),
      displayBody.map((row) => row.filter((_, i) => i !== c)),
    );

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted/40">
              {displayHead.map((cell, c) => (
                <th
                  key={c}
                  className="group/col relative border-b border-r p-0 last:border-r-0"
                >
                  <input
                    value={cell}
                    onChange={(e) => setHeader(c, e.target.value)}
                    placeholder={`Header ${c + 1}`}
                    className="w-full border-0 bg-transparent py-2 pl-7 pr-3 text-xs font-semibold uppercase tracking-wide outline-none placeholder:text-muted-foreground/40 focus:bg-background focus:ring-0"
                  />
                  {colCount > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove column ${c + 1}`}
                      onClick={() => removeColumn(c)}
                      className="absolute left-0.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/col:opacity-100 cursor-pointer"
                    >
                      <Trash01 size={12} />
                    </button>
                  )}
                </th>
              ))}
              <th className="w-8 border-b" />
            </tr>
          </thead>
          <tbody>
            {displayBody.map((row, r) => (
              <tr key={r} className="group/item border-b last:border-b-0">
                {row.map((cell, c) => (
                  <td key={c} className="border-r p-0 last:border-r-0">
                    <input
                      value={cell}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      placeholder="—"
                      className="w-full border-0 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/30 focus:bg-muted/30 focus:ring-0"
                    />
                  </td>
                ))}
                <td className="w-8 text-center align-middle">
                  {displayBody.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove row ${r + 1}`}
                      onClick={() => removeRow(r)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 cursor-pointer"
                    >
                      <Trash01 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {displayBody.length === 0 && (
              <tr>
                <td
                  colSpan={colCount + 1}
                  className="px-3 py-4 text-center text-xs text-muted-foreground"
                >
                  No rows yet — add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <AddButton label="Add row" onClick={addRow} />
        <button
          type="button"
          onClick={addColumn}
          className="flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
        >
          <Plus size={13} />
          Add column
        </button>
      </div>
    </div>
  );
}
