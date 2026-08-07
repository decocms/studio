import type { Filter } from "@decocms/ui/components/filter-bar.tsx";
import { usePersistedFilters } from "@decocms/ui/hooks/use-persisted-filters.ts";
import { useSortable } from "@decocms/ui/hooks/use-sortable.ts";
import { useViewMode } from "@decocms/ui/hooks/use-view-mode.ts";
import type { BaseCollectionEntity } from "@decocms/bindings/collections";
import { useDeferredValue, useState } from "react";

// Custom collection entity type that allows nullable IDs
export type ListStateEntity = Omit<BaseCollectionEntity, "id"> & {
  id: string | null;
};

export interface UseListStateOptions<T extends ListStateEntity> {
  /** Organization/namespace for storage keys */
  namespace: string;
  /** Resource name for storage keys (e.g., "connections", "models") */
  resource: string;
  /** Default sort key */
  defaultSortKey?: keyof T;
  /** Default view mode */
  defaultViewMode?: "table" | "cards";
}

export interface ListState<T extends ListStateEntity> {
  // Search
  search: string;
  searchTerm: string;
  setSearch: (value: string) => void;

  // Filters
  filters: Filter[];
  setFilters: (filters: Filter[]) => void;
  filterBarVisible: boolean;
  setFilterBarVisible: (visible: boolean) => void;
  toggleFilterBar: () => void;

  // View mode
  viewMode: "table" | "cards";
  setViewMode: (mode: "table" | "cards") => void;

  // Sorting
  sortKey: keyof T;
  sortDirection: "asc" | "desc" | null;
  handleSort: (key: string) => void;
}

/**
 * Hook to consolidate list UI state (search, filters, sorting, view mode)
 * with localStorage persistence for applicable state.
 */
export function useListState<T extends ListStateEntity>(
  options: UseListStateOptions<T>,
): ListState<T> {
  const {
    namespace,
    resource,
    defaultSortKey = "title",
    defaultViewMode = "table",
  } = options;

  // Search state
  const [search, setSearch] = useState("");
  const searchTerm = useDeferredValue(search);

  // Filters (persisted)
  const filterPersistKey = `${namespace}-${resource}`;
  const [filters, setFilters] = usePersistedFilters(filterPersistKey);

  // Filter bar visibility (persisted)
  const filterBarVisibilityKey = `studio-${resource}-filter-visible-${namespace}`;
  const [filterBarVisible, setFilterBarVisibleState] = useState(() => {
    const stored = globalThis.localStorage?.getItem(filterBarVisibilityKey);
    return stored === "true";
  });

  const setFilterBarVisible = (visible: boolean) => {
    setFilterBarVisibleState(visible);
    globalThis.localStorage?.setItem(filterBarVisibilityKey, String(visible));
  };

  const toggleFilterBar = () => {
    setFilterBarVisible(!filterBarVisible);
  };

  // View mode (persisted)
  const [viewMode, setViewMode] = useViewMode(
    `studio-${resource}-${namespace}`,
    defaultViewMode,
  );

  // Sorting
  const { sortKey, sortDirection, handleSort } = useSortable(
    defaultSortKey as string,
  );

  return {
    // Search
    search,
    searchTerm,
    setSearch,

    // Filters
    filters,
    setFilters,
    filterBarVisible,
    setFilterBarVisible,
    toggleFilterBar,

    // View mode
    viewMode,
    setViewMode,

    // Sorting
    sortKey: sortKey as keyof T,
    sortDirection,
    handleSort,
  };
}
