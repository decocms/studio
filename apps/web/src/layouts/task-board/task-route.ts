/**
 * A card's address: the `{-$taskKey}` segment of `/$org/tasks/DECO-01`.
 *
 * Two halves of one contract. `taskRouteSegment` writes the segment and
 * `findTaskByKeyOrId` reads it back, so every link the app mints is a link the
 * board can resolve. Keeping them in one module is what keeps that true.
 */

import { parseTaskKeySeq, taskKey } from "@decocms/shared/task-key";
import { matchesTaskKey } from "@/layouts/task-board/task-filters-core";

/** A card, as far as its URL is concerned. */
interface TaskRouteItem {
  id: string;
  keySeq: number | null;
}

/**
 * The segment a link to this card carries: the human key it already shows
 * (`DECO-01`), which is the whole point of putting the card in the path.
 *
 * A row written before the key backfill has no key, so it falls back to its
 * id — still a segment `findTaskByKeyOrId` resolves, just not a pretty one.
 */
export function taskRouteSegment(orgSlug: string, item: TaskRouteItem): string {
  return taskKey(orgSlug, item.keySeq) ?? item.id;
}

/** Canonical share path for a task. Project-owned task pages retain their
 * structural scope so a pasted link restores the project sidebar and
 * breadcrumb; organization Tasks keeps the shorter org path. Every dynamic
 * segment is encoded at this single write boundary. */
export function taskSharePath(
  orgSlug: string,
  item: TaskRouteItem,
  projectId?: string,
): string {
  const org = encodeURIComponent(orgSlug);
  const task = encodeURIComponent(taskRouteSegment(orgSlug, item));
  return projectId
    ? `/${org}/projects/${encodeURIComponent(projectId)}/tasks/${task}`
    : `/${org}/tasks/${task}`;
}

/**
 * The card a segment names: by human key (`DECO-01`, `deco-1`, `1`) or by raw
 * id.
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
  return (
    items.find((item) => matchesTaskKey(raw, item.keySeq)) ??
    items.find((item) => item.id === raw)
  );
}

/** A raw card id, as `generatePrefixedId("board")` mints it. */
const BOARD_ID = /^board_[\w-]+$/;

/** Far longer than any key or id the board mints. `parseTaskKeySeq` accepts
 *  any run of digits, so the key pattern alone does not bound the length. */
const MAX_SEGMENT_LENGTH = 64;

/**
 * `term`, trimmed, when it is shaped like a segment `findTaskByKeyOrId`
 * resolves: a key (`DECO-01`, `deco-1`, `1`) or a raw card id. Null for
 * anything else. Whether the card exists is left to the board.
 *
 * For a segment that arrives from outside the app, such as an MCP app's
 * navigate request, so a route is only built from a card address.
 */
export function parseTaskRouteSegment(term: string): string | null {
  const segment = term.trim();
  if (segment.length > MAX_SEGMENT_LENGTH) return null;
  return parseTaskKeySeq(segment) !== null || BOARD_ID.test(segment)
    ? segment
    : null;
}
