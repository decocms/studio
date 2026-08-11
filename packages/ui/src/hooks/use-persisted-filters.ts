import { useState } from "react";

import type { Filter } from "../components/filter-bar.tsx";

export function usePersistedFilters(
  key: string,
): [Filter[], (filters: Filter[]) => void] {
  const storageKey = `deco-filters-${key}`;

  const [filters, setFilters] = useState<Filter[]>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(storageKey);
      if (stored) {
        return JSON.parse(stored) as Filter[];
      }
    } catch (error) {
      console.error("Failed to parse stored filters:", error);
    }
    return [];
  });

  const setFiltersWithStorage = (newFilters: Filter[]) => {
    setFilters(newFilters);
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(newFilters));
    } catch (error) {
      console.error("Failed to save filters:", error);
    }
  };

  return [filters, setFiltersWithStorage];
}
