/** Stable DnD id per row; item data always comes from the `items` prop. */
export interface ArrayEntry {
  id: string;
  index: number;
}

export function createArrayEntries(count: number): ArrayEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    index,
  }));
}

export function remapEntryIndices(entries: ArrayEntry[]): ArrayEntry[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

/** Append/truncate entries by count only — correct when items are only ever
 * added/removed at the end. `insertEntryAfter`/`removeEntryAt` below handle
 * the mid-array cases (duplicate, remove). */
export function resizeArrayEntries(
  current: ArrayEntry[],
  nextCount: number,
): ArrayEntry[] {
  if (nextCount === current.length) return current;
  if (nextCount < current.length) {
    return remapEntryIndices(current.slice(0, nextCount));
  }
  const extra = Array.from(
    { length: nextCount - current.length },
    (_, offset) => ({
      id: crypto.randomUUID(),
      index: current.length + offset,
    }),
  );
  return [...current, ...extra];
}

/** Insert a new entry for an item placed at `itemIndex`, shifting the indices
 * of entries at or after it. Used for mid-array inserts (duplicate, "Add
 * section above/below") — `resizeArrayEntries` can't place those (it only
 * grows/shrinks from the end, which desyncs every entry after the insertion
 * point). */
export function insertEntryAt(
  entries: ArrayEntry[],
  itemIndex: number,
): ArrayEntry[] {
  const insertAt = entries.findIndex((entry) => entry.index >= itemIndex);
  const shifted = entries.map((entry) =>
    entry.index >= itemIndex ? { ...entry, index: entry.index + 1 } : entry,
  );
  const newEntry: ArrayEntry = { id: crypto.randomUUID(), index: itemIndex };
  if (insertAt === -1) return [...shifted, newEntry];
  return [...shifted.slice(0, insertAt), newEntry, ...shifted.slice(insertAt)];
}

/** Insert a new entry right after the item at `itemIndex` (duplicate). */
export function insertEntryAfter(
  entries: ArrayEntry[],
  itemIndex: number,
): ArrayEntry[] {
  return insertEntryAt(entries, itemIndex + 1);
}

/** Drop the entry for the item at `itemIndex`, shifting indices of entries
 * after it down by one. Used for remove, which can drop from mid-array. */
export function removeEntryAt(
  entries: ArrayEntry[],
  itemIndex: number,
): ArrayEntry[] {
  return entries
    .filter((entry) => entry.index !== itemIndex)
    .map((entry) =>
      entry.index > itemIndex ? { ...entry, index: entry.index - 1 } : entry,
    );
}

/** A stored value the list editor can't show: present but not an array (e.g. a loader's inline object). Rendering it as `[]` and editing would overwrite it. */
export function isNonArrayStoredValue(value: unknown): boolean {
  return value !== undefined && value !== null && !Array.isArray(value);
}
