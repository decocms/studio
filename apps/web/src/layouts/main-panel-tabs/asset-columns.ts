/** Masonry layout shared by the Assets tab and the v8 Assets gallery. */

/**
 * Column count for the masonry grid, keyed off the measured container width
 * (thresholds mirror the old Tailwind sm/md/lg breakpoints). `-1` means "not
 * measured yet" — it re-renders with the real width before paint, so the
 * fallback is only a momentary default and never a visible layout.
 */
export function assetColumnCount(width: number): number {
  if (width < 0 || width < 640) return 2;
  if (width < 768) return 3;
  if (width < 1024) return 4;
  return 5;
}

/**
 * Distributes items round-robin across `count` columns so reading order stays
 * left-to-right, top-to-bottom (item 0,1,2… fill the first visual row). Cards
 * keep their natural height within each column — a mosaic with no fixed row
 * height and no leftover space — while preserving the source order, which a
 * pure CSS `columns` layout would scramble into column-major order.
 */
export function distributeIntoColumns<T>(items: T[], count: number): T[][] {
  const columns: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, i) => columns[i % count]!.push(item));
  return columns;
}
