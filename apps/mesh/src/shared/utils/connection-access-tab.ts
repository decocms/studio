/**
 * Tab model that splits connections by their `access` field.
 *
 *   "all"      → no filter (every connection the viewer can see)
 *   "shared"   → access === "org"  (shared org-wide)
 *   "personal" → access === "user" (private to the creator)
 *
 * Shared by the connections settings page and the AddConnectionDialog so the
 * tab ids, labels, coercion, and filtering stay in sync across surfaces.
 */
export type ConnectionAccessTab = "all" | "shared" | "personal";

/** Minimal shape needed to bucket a connection by visibility. */
type HasAccess = { access: "user" | "org" };

/**
 * Coerce an arbitrary stored/URL value into a valid tab. Unknown values —
 * including the legacy "connected" tab — fall back to "all".
 */
export function coerceConnectionAccessTab(value: unknown): ConnectionAccessTab {
  return value === "shared" || value === "personal" || value === "all"
    ? value
    : "all";
}

/**
 * Map a tab to the `access` column value used for server-side `where`
 * filtering. "all" → null (no filter); "shared" → "org"; "personal" → "user".
 */
export function accessTabWhereValue(
  tab: ConnectionAccessTab,
): "org" | "user" | null {
  if (tab === "shared") return "org";
  if (tab === "personal") return "user";
  return null;
}

/** Client-side filter of connections for a given tab. */
export function filterConnectionsByAccessTab<T extends HasAccess>(
  connections: T[],
  tab: ConnectionAccessTab,
): T[] {
  const value = accessTabWhereValue(tab);
  if (value === null) return connections;
  return connections.filter((c) => c.access === value);
}

/** Count connections per access bucket. */
export function countConnectionsByAccess<T extends HasAccess>(
  connections: T[],
): { all: number; shared: number; personal: number } {
  let shared = 0;
  let personal = 0;
  for (const c of connections) {
    if (c.access === "org") shared++;
    else if (c.access === "user") personal++;
  }
  return { all: connections.length, shared, personal };
}
