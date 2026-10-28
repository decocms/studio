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
}

export interface CollectionTableProps<T = Record<string, unknown>> {
  columns: CollectionTableColumn<T>[];
  data: T[];
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Whether a row opens on click; one that doesn't is neither focusable nor highlighted. */
  isRowClickable?: (row: T) => boolean;
}

export function CollectionTable<T = Record<string, unknown>>({
  columns,
  data,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  rowClassName,
  isRowClickable,
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
    let base = "px-4 py-2 text-left font-normal text-meta h-9";
    if (idx === total - 1) base += " w-8";
    return base;
  }

  return (
    <UITable className="w-full border-collapse">
      <TableHeader className="border-b-0">
        <TableRow className="h-9 hover:bg-transparent border-b border-border">
          {columns.map((col, idx) => {
            const isActiveSort = sortKey === col.id;
            const isSortable = col.sortable && onSort;
            return (
              <TableHead
                key={col.id}
                className={cn(
                  getHeaderClass(idx, columns.length),
                  "group transition-colors select-none",
                  col.sortable && "hover:bg-accent cursor-pointer",
                  col.rowClassName,
                  col.cellClassName,
                )}
                aria-sort={
                  isActiveSort && sortDirection
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : col.sortable
                      ? "none"
                      : undefined
                }
                role={isSortable ? "button" : undefined}
                tabIndex={isSortable ? 0 : undefined}
                onClick={isSortable ? () => onSort(col.id) : undefined}
                onKeyDown={
                  isSortable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSort(col.id);
                        }
                      }
                    : undefined
                }
              >
                <span className="flex items-center gap-1">
                  {col.header}
                  {col.sortable && renderSortIcon(col.id, isActiveSort)}
                </span>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row, i) => {
          const extraClasses = rowClassName?.(row);
          const clickable = isRowClickable?.(row) ?? true;
          const onClick =
            onRowClick && clickable ? () => onRowClick(row) : undefined;

          return (
            <TableRow
              key={i}
              data-row-index={i}
              className={cn(
                "group/data-row transition-colors border-b-0",
                clickable && "hover:bg-accent",
                onClick ? "cursor-pointer" : "",
                extraClasses,
              )}
              role={onClick ? "button" : undefined}
              tabIndex={onClick ? 0 : undefined}
              onClick={onClick}
              onKeyDown={
                onClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onClick();
                      }
                    }
                  : undefined
              }
            >
              {columns.map((col) => (
                <TableCell
                  key={col.id}
                  className={cn(
                    "px-5 py-4 h-16 align-middle text-sm text-foreground",
                    col.cellClassName,
                    col.wrap ? "whitespace-normal wrap-break-word" : "",
                  )}
                >
                  <div
                    className={cn(
                      col.wrap ? "w-full" : "min-w-0",
                      // The inset keeps a control's outer edge ring inside the clip.
                      !col.wrap &&
                        "-m-0.5 truncate overflow-hidden whitespace-nowrap p-0.5",
                    )}
                  >
                    {col.render
                      ? col.render(row)
                      : col.accessor
                        ? col.accessor(row)
                        : null}
                  </div>
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
