/**
 * Entries of a permission list — a role statement's action list, the
 * `projects` scope, or the `connections` scope.
 *
 * `name` grants that name and `*` grants every name. `!name` denies that name
 * and `!*` denies every name. A denial wins over any grant, whether the grant
 * sits in the same list or in another list consulted for the same check, so
 * `["*", "!x"]` reads "everything except x" no matter how it is combined.
 */

export const PERMISSION_WILDCARD = "*";

export const PERMISSION_DENY_PREFIX = "!";

type PermissionList = readonly string[] | null | undefined;

/** `!name` for an entry that denies `name`. */
export function denyEntry(name: string): string {
  return `${PERMISSION_DENY_PREFIX}${name}`;
}

/** The name an entry denies, or null when the entry grants. */
export function deniedName(entry: string): string | null {
  return entry.startsWith(PERMISSION_DENY_PREFIX)
    ? entry.slice(PERMISSION_DENY_PREFIX.length)
    : null;
}

export function listDenies(list: PermissionList, name: string): boolean {
  if (!list) return false;
  return (
    list.includes(denyEntry(PERMISSION_WILDCARD)) ||
    list.includes(denyEntry(name))
  );
}

export function listGrants(list: PermissionList, name: string): boolean {
  if (!list) return false;
  return list.includes(PERMISSION_WILDCARD) || list.includes(name);
}

/** Whether `lists`, read together, allow `name`: some grant, no denial. */
export function listsAllow(lists: readonly PermissionList[], name: string) {
  if (lists.some((list) => listDenies(list, name))) return false;
  return lists.some((list) => listGrants(list, name));
}

/**
 * The set a list describes, in a shape a query can filter on: every name,
 * every name except some, or only some.
 */
export type PermissionListFilter =
  | { kind: "all" }
  | { kind: "except"; names: string[] }
  | { kind: "only"; names: string[] };

export function permissionListFilter(
  list: readonly string[],
): PermissionListFilter {
  if (list.includes(denyEntry(PERMISSION_WILDCARD))) {
    return { kind: "only", names: [] };
  }
  const denied = new Set<string>();
  const granted = new Set<string>();
  for (const entry of list) {
    const name = deniedName(entry);
    if (name !== null) denied.add(name);
    else if (entry !== PERMISSION_WILDCARD) granted.add(entry);
  }
  if (list.includes(PERMISSION_WILDCARD)) {
    return denied.size === 0
      ? { kind: "all" }
      : { kind: "except", names: [...denied] };
  }
  return { kind: "only", names: [...granted].filter((n) => !denied.has(n)) };
}

/** The set of names any of `filters` admits. */
export function unionListFilters(
  filters: readonly PermissionListFilter[],
): PermissionListFilter {
  let excepted: Set<string> | null = null;
  const only = new Set<string>();
  for (const filter of filters) {
    if (filter.kind === "all") return filter;
    if (filter.kind === "only") {
      for (const name of filter.names) only.add(name);
      continue;
    }
    excepted = excepted
      ? new Set(filter.names.filter((name) => excepted?.has(name)))
      : new Set(filter.names);
  }
  if (excepted === null) return { kind: "only", names: [...only] };
  const names = [...excepted].filter((name) => !only.has(name));
  return names.length === 0 ? { kind: "all" } : { kind: "except", names };
}

/** A list that reads back as `filter`. */
export function listFromFilter(filter: PermissionListFilter): string[] {
  if (filter.kind === "all") return [PERMISSION_WILDCARD];
  if (filter.kind === "except") {
    return [PERMISSION_WILDCARD, ...filter.names.map(denyEntry)];
  }
  return [...filter.names];
}
