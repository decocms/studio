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

/** Whether an unresolved task segment is known to be stale.
 *
 * Project aliases load independently from the task list. A task owned by a
 * hidden development project is absent from the visible scope until that
 * alias request settles, so routing must wait for both sources before
 * replacing the deep link with the board index.
 */
export function shouldRedirectMissingTask(input: {
  taskKey: string | undefined;
  taskFound: boolean;
  tasksPending: boolean;
  projectAliasesPending: boolean;
}): boolean {
  return (
    !!input.taskKey &&
    !input.taskFound &&
    !input.tasksPending &&
    !input.projectAliasesPending
  );
}
