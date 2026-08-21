/**
 * The dev-assets pseudo-connection is synthetic — it never exists as a
 * Postgres row, so a page fetched with `offset > 0` can never contain it
 * the way a real row would be excluded from later pages. Two rules keep it
 * confined to a single, correctly-sized page in COLLECTION_CONNECTIONS_LIST:
 *
 *  - Only *consider* injecting it on the first page of a plain (non-binding)
 *    listing — otherwise it would reappear at the top of every page.
 *  - If it's injected onto a non-binding page that SQL already filled to
 *    `limit`, trim the page back down and fold the extra row into the total
 *    count (it isn't counted by `sqlTotalCount`, which only reflects DB rows).
 */
export function shouldConsiderDevAssetsForPage(
  needsBindingFilter: boolean,
  offset: number,
): boolean {
  return needsBindingFilter || offset === 0;
}

/**
 * `devAssetsQualifies` is whether the row qualifies for this listing at all,
 * not whether it landed on this specific page — totalCount must include it
 * on every page or a later page's `hasMore` undercounts by one.
 */
export function finalizeNonBindingPage<T>(
  connections: T[],
  devAssetsQualifies: boolean,
  limit: number,
  offset: number,
  sqlTotalCount: number,
): { items: T[]; totalCount: number; hasMore: boolean } {
  const totalCount = devAssetsQualifies ? sqlTotalCount + 1 : sqlTotalCount;
  const items = connections.slice(0, limit);
  const hasMore = offset + limit < totalCount;
  return { items, totalCount, hasMore };
}

/**
 * The synthetic row occupies one slot of the virtual list
 * `[dev-assets, ...real rows]`; translate the caller's offset/limit over
 * that virtual list into the SQL offset/limit over real rows, so the
 * synthetic row never displaces — and then permanently drops — a real row
 * across a page boundary.
 */
export function resolveDevAssetsSqlWindow(
  offset: number,
  limit: number,
  devAssetsQualifies: boolean,
): { sqlOffset: number; sqlLimit: number } {
  if (!devAssetsQualifies) return { sqlOffset: offset, sqlLimit: limit };
  if (offset === 0) {
    return { sqlOffset: 0, sqlLimit: Math.max(limit - 1, 0) };
  }
  return { sqlOffset: offset - 1, sqlLimit: limit };
}
