/**
 * Who last changed each block of a hosted v8 draft, and when — what the site
 * editor's "someone else changed this" dialog shows. PO: "only have metadata
 * and changed by on v8 hosted".
 *
 * It lives in the draft object's storage metadata (S3 `x-amz-meta-*`, which
 * R2 supports), never in the JSON: the draft stays exactly `{ set, delete }`,
 * no block carries it, and the site's SDK never sees it. Only Studio reads it.
 *
 * Format (`x-amz-meta-deco-edited`): entries joined by `;`, oldest first,
 * each `<name>,<userId>,<seconds>` with the name and user id
 * `encodeURIComponent`-escaped (so `,` and `;` never appear inside a field,
 * and the value stays ASCII, as a header must) and the time in base-36 Unix
 * seconds. User-defined metadata is capped at 2 KB per object (keys and
 * values, S3 and R2): past {@link MAX_EDITORS_BYTES} the oldest entries are
 * dropped, so a long-lived draft forgets who edited its oldest changes first.
 */

import type { DraftBody } from "./draft-store";

/** The metadata key (`x-amz-meta-deco-edited` on the wire). */
export const DRAFT_EDITORS_META = "deco-edited";

/** Room for the value, under S3/R2's 2 KB of user metadata per object. */
export const MAX_EDITORS_BYTES = 1900;

/** The last change to one draft name: a Studio user id, Unix seconds. */
export interface DraftEditor {
  userId: string;
  at: number;
}

export type DraftEditors = Record<string, DraftEditor>;

/** The metadata value for `editors`, oldest dropped until it fits. */
export function encodeDraftEditors(
  editors: DraftEditors,
  maxBytes = MAX_EDITORS_BYTES,
): string {
  const entries = Object.entries(editors)
    .sort(([na, a], [nb, b]) => a.at - b.at || (na < nb ? -1 : na > nb ? 1 : 0))
    .map(
      ([name, { userId, at }]) =>
        `${encodeURIComponent(name)},${encodeURIComponent(userId)},${Math.max(0, Math.floor(at)).toString(36)}`,
    );
  let value = entries.join(";");
  while (value.length > maxBytes && entries.length > 0) {
    entries.shift();
    value = entries.join(";");
  }
  return value;
}

/** The map a metadata value holds; anything malformed is left out. */
export function decodeDraftEditors(
  value: string | null | undefined,
): DraftEditors {
  if (!value) return {};
  const out: Array<[string, DraftEditor]> = [];
  for (const entry of value.split(";")) {
    const [name, userId, at] = entry.split(",");
    if (!name || !userId || !at || entry.split(",").length !== 3) continue;
    const seconds = Number.parseInt(at, 36);
    if (!Number.isFinite(seconds) || !/^[0-9a-z]+$/.test(at)) continue;
    try {
      out.push([
        decodeURIComponent(name),
        { userId: decodeURIComponent(userId), at: seconds },
      ]);
    } catch {
      // A malformed escape: that entry only.
    }
  }
  // fromEntries: a name like "__proto__" stays an entry.
  return Object.fromEntries(out);
}

/**
 * The editors after a save from `before` to `after`: names whose value (or
 * deletion) changed are stamped with `userId` at `at`; untouched names keep
 * theirs; names no longer in the draft (discarded, published) are dropped.
 * Without a user, a changed name loses its stamp rather than keep a wrong one.
 */
export function stampDraftEditors(
  editors: DraftEditors,
  before: DraftBody,
  after: DraftBody,
  userId: string | null | undefined,
  at: number,
): DraftEditors {
  const deletedBefore = new Set(before.delete);
  const deletedAfter = new Set(after.delete);
  const next: Array<[string, DraftEditor]> = [];
  for (const name of new Set([...Object.keys(after.set), ...after.delete])) {
    const changed =
      deletedBefore.has(name) !== deletedAfter.has(name) ||
      Object.hasOwn(before.set, name) !== Object.hasOwn(after.set, name) ||
      JSON.stringify(before.set[name]) !== JSON.stringify(after.set[name]);
    const kept = Object.hasOwn(editors, name) ? editors[name] : undefined;
    if (!changed) {
      if (kept) next.push([name, kept]);
    } else if (userId) {
      next.push([name, { userId, at }]);
    }
  }
  return Object.fromEntries(next);
}
