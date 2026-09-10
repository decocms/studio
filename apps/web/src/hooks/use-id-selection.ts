import { useState } from "react";

/**
 * Tracks a selected row by id rather than array index, so a refetch/sort/filter
 * that reorders or shrinks `items` in place doesn't point the selection at the
 * wrong row. `isOpen` reflects whether the id still resolves to an item in
 * `items` — if the selected row drops out of the list (e.g. a filter change
 * while its detail sheet is open), the sheet closes instead of staying open
 * with nothing to show.
 */
export function useIdSelection<T extends { id: string }>(items: T[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const index =
    selectedId !== null
      ? items.findIndex((item) => item.id === selectedId)
      : -1;
  const selected = index !== -1 ? items[index] : null;

  return {
    selected,
    index,
    isOpen: selected !== null,
    select: (id: string) => setSelectedId(id),
    close: () => setSelectedId(null),
    prev: () => {
      const prevItem = items[index - 1];
      if (index > 0 && prevItem) setSelectedId(prevItem.id);
    },
    next: () => {
      const nextItem = items[index + 1];
      if (index !== -1 && nextItem) setSelectedId(nextItem.id);
    },
  };
}
