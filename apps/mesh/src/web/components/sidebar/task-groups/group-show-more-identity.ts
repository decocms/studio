import type { GroupKind, SidebarFilters } from "./next-page-offset";

/** Stable cache key for per-group sidebar list fetches (probe + pagination). */
export function groupShowMoreIdentity(
  orgId: string,
  kind: GroupKind,
  key: string,
  filters: SidebarFilters,
): string {
  return [
    orgId,
    kind,
    key,
    filters.type,
    filters.member,
    filters.currentUserId ?? "",
  ].join("|");
}

/**
 * `member: "mine"` omits `created_by` until `currentUserId` is known, then
 * changes the query. Wait for the session so we do not probe twice (null → id).
 */
export function shouldDeferGroupProbe(filters: SidebarFilters): boolean {
  return filters.member === "mine" && !filters.currentUserId;
}
