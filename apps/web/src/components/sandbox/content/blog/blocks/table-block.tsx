import { useState } from "react";
import { Plus, Trash01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { InlineRichCell } from "./inline-rich-cell";
import { useLinkSources } from "./link-pickers";
import { AddButton, parseJsonArray, str } from "./primitives";

/**
 * Inline editor for the blog Table block (`blog/sections/blocks/Table.tsx`).
 * The section stores `headers` as a JSON-encoded `string[]` and `rows` as a
 * JSON-encoded `string[][]` (body rows × cells), each tolerant of already
 * being an array. Cells hold inline HTML, edited as inline rich text.
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
  decofile,
  sandboxRef,
}: {
  headers: string;
  rows: string;
  onChange: (next: { headers: string; rows: string }) => void;
  /** The site's blocks — enables linking to another post. */
  decofile?: Record<string, unknown>;
  /** A running preview — enables linking to a catalog product. */
  sandboxRef?: PreviewProxyRef | null;
}) {
  const t = useT();
  const linkSources = useLinkSources({ decofile, sandboxRef });
  // Shared mount point for the cell marks menus — see `InlineMarksToolbar`.
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null);
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

  // Remount key: an uncontrolled cell editor would survive with stale content.
  const shapeKey = `${displayBody.length}x${colCount}`;

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
    <div className="relative space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-muted/40">
              {displayHead.map((cell, c) => (
                <th
                  key={`${shapeKey}-h-${c}`}
                  className="group/col relative border-b border-r p-0 last:border-r-0 text-left align-top"
                >
                  <InlineRichCell
                    value={cell}
                    onChange={(v) => setHeader(c, v)}
                    placeholder={t("sandbox.tableBlock.headerPlaceholder", {
                      n: c + 1,
                    })}
                    className="py-2 pl-7 pr-3 text-xs font-semibold uppercase tracking-wide [&_p]:my-0 focus:bg-background"
                    menuHost={menuHost}
                    sources={linkSources}
                  />
                  {colCount > 1 && (
                    <button
                      type="button"
                      aria-label={t("sandbox.tableBlock.removeColumn", {
                        n: c + 1,
                      })}
                      onClick={() => removeColumn(c)}
                      className="absolute left-0.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/col:opacity-100 cursor-pointer rounded-lg"
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
              <tr
                key={`${shapeKey}-${r}`}
                className="group/item border-b last:border-b-0"
              >
                {row.map((cell, c) => (
                  <td
                    key={`${shapeKey}-${r}-${c}`}
                    className="border-r p-0 last:border-r-0 align-top"
                  >
                    <InlineRichCell
                      value={cell}
                      onChange={(v) => setCell(r, c, v)}
                      placeholder="—"
                      className="px-3 py-2 text-sm [&_p]:my-0 focus:bg-muted/30"
                      menuHost={menuHost}
                      sources={linkSources}
                    />
                  </td>
                ))}
                <td className="w-8 text-center align-middle">
                  {displayBody.length > 1 && (
                    <button
                      type="button"
                      aria-label={t("sandbox.tableBlock.removeRow", {
                        n: r + 1,
                      })}
                      onClick={() => removeRow(r)}
                      className="flex h-6 w-6 items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 cursor-pointer rounded-lg"
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
                  {t("sandbox.tableBlock.noRowsYet")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <AddButton label={t("sandbox.tableBlock.addRow")} onClick={addRow} />
        <button
          type="button"
          onClick={addColumn}
          className="flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
        >
          <Plus size={13} />
          {t("sandbox.tableBlock.addColumn")}
        </button>
      </div>
      <div ref={setMenuHost} className="absolute z-20" />
    </div>
  );
}
