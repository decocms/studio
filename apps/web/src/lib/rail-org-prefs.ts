/**
 * How this person arranged the org rail: which orgs they took off it, which
 * they pinned, and the order they dragged it into. Per browser, like the
 * recency history the rail also reads.
 */

export interface RailOrgPrefs {
  hidden: string[];
  pinned: string[];
  /** Slugs in the order the person dragged them to; orgs not listed follow. */
  order: string[];
}

export const EMPTY_RAIL_ORG_PREFS: RailOrgPrefs = {
  hidden: [],
  pinned: [],
  order: [],
};

const without = (list: readonly string[], slug: string) =>
  list.filter((it) => it !== slug);

/** A value from an older build, or a hand-edited one, must not crash the rail. */
export function readRailOrgPrefs(raw: unknown): RailOrgPrefs {
  if (typeof raw !== "object" || raw === null) return EMPTY_RAIL_ORG_PREFS;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((it): it is string => typeof it === "string")
      : [];
  const record = raw as Record<string, unknown>;
  return {
    hidden: strings(record.hidden),
    pinned: strings(record.pinned),
    order: strings(record.order),
  };
}

/** Hiding an org unpins it: a pin says "always here". */
export function hideRailOrg(prefs: RailOrgPrefs, slug: string): RailOrgPrefs {
  return {
    ...prefs,
    hidden: [...without(prefs.hidden, slug), slug],
    pinned: without(prefs.pinned, slug),
  };
}

export function showRailOrg(prefs: RailOrgPrefs, slug: string): RailOrgPrefs {
  return { ...prefs, hidden: without(prefs.hidden, slug) };
}

/** Pinning an org also brings it back from hidden. */
export function toggleRailOrgPin(
  prefs: RailOrgPrefs,
  slug: string,
): RailOrgPrefs {
  return prefs.pinned.includes(slug)
    ? { ...prefs, pinned: without(prefs.pinned, slug) }
    : {
        ...prefs,
        hidden: without(prefs.hidden, slug),
        pinned: [...prefs.pinned, slug],
      };
}

/** The orgs the rail may draw, in the order it draws them: pinned first, each
 *  group by the dragged order, then the list's own. */
export function arrangeRailOrgs<T extends { slug: string }>(
  all: readonly T[],
  prefs: RailOrgPrefs,
  currentSlug: string | null,
): T[] {
  const rank = (slug: string) => {
    const at = prefs.order.indexOf(slug);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return all
    .filter(
      (org) => org.slug === currentSlug || !prefs.hidden.includes(org.slug),
    )
    .map((org, index) => ({ org, index }))
    .sort(
      (a, b) =>
        Number(prefs.pinned.includes(b.org.slug)) -
          Number(prefs.pinned.includes(a.org.slug)) ||
        rank(a.org.slug) - rank(b.org.slug) ||
        a.index - b.index,
    )
    .map(({ org }) => org);
}

/** Moves `from` to where `to` is among the slugs on the rail now. A drag
 *  across the pinned boundary is refused: pinned orgs always sort first, so
 *  the drop would snap back. */
export function moveRailOrg(
  prefs: RailOrgPrefs,
  drawn: readonly string[],
  from: string,
  to: string,
): RailOrgPrefs {
  const fromAt = drawn.indexOf(from);
  const toAt = drawn.indexOf(to);
  if (
    fromAt === -1 ||
    toAt === -1 ||
    fromAt === toAt ||
    prefs.pinned.includes(from) !== prefs.pinned.includes(to)
  ) {
    return prefs;
  }
  const moved = [...drawn];
  moved.splice(fromAt, 1);
  moved.splice(toAt, 0, from);
  return {
    ...prefs,
    order: [...moved, ...prefs.order.filter((it) => !moved.includes(it))],
  };
}
