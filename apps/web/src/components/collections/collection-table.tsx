import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { ArrowUp, ArrowDown } from "@untitledui/icons";

export interface CollectionTableColumn<T> {
  id: string;
  header: ReactNode;
  accessor?: (row: T) => ReactNode;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  rowClassName?: string;
  cellClassName?: string;
  wrap?: boolean;
  /** Keeps trailing controls above the row-spanning primary action. */
  isAction?: boolean;
}

export interface CollectionTableProps<T = Record<string, unknown>> {
  columns: CollectionTableColumn<T>[];
  data: T[];
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  /** Stable identity is required for focus and state to follow the record. */
  getRowId: (row: T) => string;
  /** Accessible name for the primary row action when rows are navigable. */
  getRowActionLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
}

export function CollectionTable<T = Record<string, unknown>>({
  columns,
  data,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  getRowId,
  getRowActionLabel,
  rowClassName,
}: CollectionTableProps<T>) {
  function renderSortIcon(_key: string, isActive: boolean) {
    return (
      <div className="w-4 flex items-center justify-center">
        {isActive &&
          sortDirection &&
          (sortDirection === "asc" ? (
            <ArrowUp
              size={16}
              className="text-muted-foreground transition-colors"
            />
          ) : (
            <ArrowDown
              size={16}
              className="text-muted-foreground transition-colors"
            />
          ))}
      </div>
    );
  }

  function getHeaderClass(idx: number, total: number) {
    let base =
      "px-4 py-2 text-left font-mono font-normal text-muted-foreground text-[11px] h-9 uppercase tracking-wider";
    if (idx === total - 1) base += " w-8";
    return base;
  }

  return (
    <UITable className="w-full border-collapse">
      <TableHeader className="border-b-0">
        <TableRow className="h-9 hover:bg-transparent border-b border-border">
          {columns.map((col, idx) => {
            const isActiveSort = sortKey === col.id;
            return (
              <TableHead
                key={col.id}
                aria-sort={
                  col.sortable
                    ? isActiveSort && sortDirection
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                    : undefined
                }
                className={cn(
                  getHeaderClass(idx, columns.length),
                  "group select-none transition-colors",
                  col.rowClassName,
                  col.cellClassName,
                )}
              >
                {col.sortable && onSort ? (
                  <button
                    type="button"
                    className="-mx-2 flex min-h-7 w-[calc(100%+1rem)] items-center gap-1 rounded-sm px-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSort(col.id)}
                  >
                    {col.header}
                    {renderSortIcon(col.id, isActiveSort)}
                  </button>
                ) : (
                  <span className="flex items-center gap-1">{col.header}</span>
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row, i) => {
          const extraClasses = rowClassName?.(row);

          return (
            <TableRow
              key={getRowId(row)}
              data-row-index={i}
              className={cn(
                "group/data-row relative transition-colors border-b-0 hover:bg-accent/50 focus-within:bg-accent/50",
                extraClasses,
              )}
            >
              {columns.map((col, columnIndex) => (
                <TableCell
                  key={col.id}
                  className={cn(
                    "px-5 py-4 h-16 align-middle text-sm text-foreground",
                    col.cellClassName,
                    col.wrap ? "whitespace-normal wrap-break-word" : "",
                    onRowClick && col.isAction && "relative z-10 bg-inherit",
                    onRowClick && columnIndex > 0 && !col.isAction
                      ? "pointer-events-none"
                      : undefined,
                  )}
                >
                  {onRowClick && columnIndex === 0 ? (
                    <button
                      type="button"
                      aria-label={getRowActionLabel?.(row)}
                      className={cn(
                        "w-full rounded-sm text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        !col.wrap &&
                          "min-w-0 overflow-hidden truncate whitespace-nowrap",
                      )}
                      onClick={() => onRowClick(row)}
                    >
                      {col.render
                        ? col.render(row)
                        : col.accessor
                          ? col.accessor(row)
                          : null}
                    </button>
                  ) : (
                    <div
                      className={cn(
                        col.wrap ? "w-full" : "min-w-0 w-full",
                        !col.wrap &&
                          "truncate overflow-hidden whitespace-nowrap",
                      )}
                    >
                      {col.render
                        ? col.render(row)
                        : col.accessor
                          ? col.accessor(row)
                          : null}
                    </div>
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </UITable>
  );
}

export type { CollectionTableColumn as TableColumn };
