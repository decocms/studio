import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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
}

export function CollectionTable<T = Record<string, unknown>>({
  columns,
  data,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
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
                className={cn(
                  getHeaderClass(idx, columns.length),
                  "group transition-colors select-none",
                  col.sortable && "hover:bg-accent cursor-pointer",
                  col.rowClassName,
                  col.cellClassName,
                )}
                onClick={
                  col.sortable && onSort ? () => onSort(col.id) : undefined
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

          return (
            <TableRow
              key={i}
              data-row-index={i}
              className={cn(
                "group/data-row transition-colors border-b-0 hover:bg-accent/50",
                onRowClick ? "cursor-pointer" : "",
                extraClasses,
              )}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
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
                      col.wrap ? "w-full" : "min-w-0 w-full",
                      !col.wrap && "truncate overflow-hidden whitespace-nowrap",
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
