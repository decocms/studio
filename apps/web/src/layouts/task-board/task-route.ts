/**
 * A card's address: the `{-$taskKey}` segment of `/$org/tasks/DECO-01`.
 *
 * Two halves of one contract. `taskRouteSegment` writes the segment and
 * `findTaskByKeyOrId` reads it back, so every link the app mints is a link the
 * board can resolve. Keeping them in one module is what keeps that true.
 */

import { taskKey } from "@decocms/shared/task-key";
import { matchesTaskKey } from "@/layouts/task-board/task-filters";

/** A card, as far as its URL is concerned. */
export interface TaskRouteItem {
  id: string;
  keySeq: number | null;
  jiraIssueKey?: string | null;
}

/**
 * The segment a link to this card carries: the human key it already shows
 * (`DECO-01`, or the tracker's own `EX-333`), which is the whole point of
 * putting the card in the path.
 *
 * A row written before the key backfill has no key, so it falls back to its
 * id — still a segment `findTaskByKeyOrId` resolves, just not a pretty one.
 */
export function taskRouteSegment(orgSlug: string, item: TaskRouteItem): string {
  return taskKey(orgSlug, item.keySeq, item.jiraIssueKey) ?? item.id;
}

/**
 * The card a segment names: by human key (`DECO-01`, a synced card's tracker
 * key like `EX-333`, `deco-1`, `1`) or by raw id.
 *
 * The exact tracker key is checked first, ahead of `matchesTaskKey`'s looser
 * keySeq fallback, so an exact `EX-333` always wins over an unrelated card
 * that merely shares its number.
 *
 * The id fallback exists because a card written before the key backfill has
 * no key and `taskRouteSegment` falls back to its id — and because a link,
 * once pasted somewhere, has to keep working.
 */
export function findTaskByKeyOrId<T extends TaskRouteItem>(
  items: T[],
  term: string | undefined,
): T | undefined {
  const raw = term?.trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  return (
    items.find((item) => item.jiraIssueKey?.trim().toLowerCase() === lower) ??
    items.find((item) => matchesTaskKey(raw, item.keySeq, item.jiraIssueKey)) ??
    items.find((item) => item.id === raw)
  );
}
