import { canonicalBlockJson } from "@decocms/shared/decofile";

/**
 * Three-way merge of one block's JSON for a sync whose git merge conflicted.
 * `ours` is the draft branch, `theirs` the base it is syncing with, `ancestor`
 * their merge base. A change made on only one side survives; where both sides
 * changed the same value, the branch wins for that value alone instead of for
 * the whole file, so a conflict elsewhere in the block can no longer revert
 * what another draft already published.
 *
 * Object keys are stable identities, so objects merge key by key. Array
 * positions are not: a reorder on one side and an edit on the other would
 * otherwise splice fields of different items together. Arrays therefore merge
 * position by position only when no position changed on both sides and no side
 * changed the length; otherwise the branch's whole array wins.
 */
export function mergeBlockJson(
  ancestor: unknown,
  ours: unknown,
  theirs: unknown,
): unknown {
  if (same(ours, theirs) || same(ancestor, theirs)) return ours;
  if (same(ancestor, ours)) return theirs;

  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const base = isPlainObject(ancestor) ? ancestor : {};
    const merged: Record<string, unknown> = {};
    const keys = [
      ...Object.keys(ours),
      ...Object.keys(theirs).filter((key) => !(key in ours)),
    ];
    for (const key of keys) {
      const value = mergeBlockJson(base[key], ours[key], theirs[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  if (
    Array.isArray(ancestor) &&
    Array.isArray(ours) &&
    Array.isArray(theirs) &&
    ours.length === ancestor.length &&
    theirs.length === ancestor.length
  ) {
    const merged: unknown[] = [];
    for (const [i, base] of ancestor.entries()) {
      const oursChanged = !same(base, ours[i]);
      const theirsChanged = !same(base, theirs[i]);
      if (oursChanged && theirsChanged && !same(ours[i], theirs[i])) {
        return ours;
      }
      merged.push(oursChanged ? ours[i] : theirs[i]);
    }
    return merged;
  }

  return ours;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalBlockJson(a) === canonicalBlockJson(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
