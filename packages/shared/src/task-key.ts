/** Letters in a card key's prefix — `DECO-01`, not `RAFAELVALLSLOCAL-01`. */
const PREFIX_LENGTH = 4;

/** Fallback when a slug carries no letters at all (`123-co` → `TASK-07`). */
const FALLBACK_PREFIX = "TASK";

/**
 * The prefix a card key wears, derived from the org's slug.
 *
 * Derived rather than stored because org slugs are immutable
 * (`ORGANIZATION_UPDATE` rejects a slug change), so this is as stable as a
 * column would be, with nothing to backfill or keep in sync.
 */
export function taskKeyPrefix(orgSlug: string): string {
  const letters = orgSlug.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.slice(0, PREFIX_LENGTH) || FALLBACK_PREFIX;
}

/**
 * A card's human key: `DECO-01`, or the tracker's own key for a card synced
 * from one.
 *
 * A synced card wears the tracker's key because that is the name it already
 * has: the issue is `EX-333` in Jira, in the branch, in the PR title and in
 * everything anyone says about it, and a second Studio-only number is one
 * translation step every reader has to make. The internal `keySeq` is
 * unaffected — it is still allocated, still unique per org, and still what the
 * card is ordered and addressed by.
 *
 * `keySeq` is null only for a row written before the backfill migration ran,
 * which has no key to show — the caller falls back to whatever it showed
 * before.
 */
export function taskKey(
  orgSlug: string,
  keySeq: number | null | undefined,
  trackerKey?: string | null,
): string | null {
  const tracker = trackerKey?.trim();
  if (tracker) return tracker;
  if (keySeq == null) return null;
  return `${taskKeyPrefix(orgSlug)}-${String(keySeq).padStart(2, "0")}`;
}

/** A term written as a card key: `DECO-01`, `deco-1`, or the bare number. */
const KEY_TERM = /^(?:[a-z]{1,8}-)?0*(\d+)$/i;

/**
 * The sequence a term names, or null when it isn't a key at all.
 *
 * The prefix is the org's and identical for every one of its cards, so only
 * the number discriminates and a term may skip the prefix entirely.
 */
export function parseTaskKeySeq(term: string): number | null {
  const digits = KEY_TERM.exec(term.trim())?.[1];
  return digits === undefined ? null : Number(digits);
}
