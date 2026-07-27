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

export function finalizeNonBindingPage<T>(
  connections: T[],
  devAssetsInjected: boolean,
  limit: number,
  offset: number,
  sqlTotalCount: number,
): { items: T[]; totalCount: number; hasMore: boolean } {
  const totalCount = devAssetsInjected ? sqlTotalCount + 1 : sqlTotalCount;
  const items = devAssetsInjected ? connections.slice(0, limit) : connections;
  const hasMore = offset + limit < totalCount;
  return { items, totalCount, hasMore };
}
