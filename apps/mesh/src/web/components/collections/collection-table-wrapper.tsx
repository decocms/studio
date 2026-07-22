import { CollectionTable, type TableColumn } from "./collection-table.tsx";
import type { ReactNode } from "react";
import { useT } from "@/web/i18n/use-t.ts";

interface CollectionTableWrapperProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  isLoading?: boolean;
  sortKey?: string;
  sortDirection?: "asc" | "desc" | null;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
}

export function CollectionTableWrapper<T>({
  columns,
  data,
  isLoading = false,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  emptyState,
}: CollectionTableWrapperProps<T>) {
  const t = useT();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">
          {t("collections.collectionTableWrapper.loading")}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        {emptyState || (
          <div className="text-center py-12 text-muted-foreground">
            {t("collections.collectionTableWrapper.noItemsFound")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1">
      <CollectionTable
        columns={columns}
        data={data}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={onSort}
        onRowClick={onRowClick}
      />
    </div>
  );
}
