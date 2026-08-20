import { parseTaskKeySeq } from "@decocms/shared/task-key";

/**
 * The card a short link names: by human key (`DECO-01`, `deco-1`, `1`) or by
 * raw id.
 *
 * Both, because a card written before the key backfill has no key and the
 * share button falls back to its id — and because a link, once pasted
 * somewhere, has to keep working.
 */
export function findTaskByKeyOrId<
  T extends { id: string; keySeq: number | null },
>(items: T[], term: string | undefined): T | undefined {
  if (!term) return undefined;
  const seq = parseTaskKeySeq(term);
  return seq === null
    ? items.find((item) => item.id === term)
    : items.find((item) => item.keySeq === seq);
}
