import type { Task } from "./types";

export interface ThreadFilter {
  /** Keep only threads where `created_by === ownerUserId`. */
  ownerUserId?: string;
  /** Keep only threads whose `trigger_id` truthiness matches this flag. */
  hasTrigger?: boolean;
  /** Keep only threads whose `hidden` flag matches (treats `undefined` as `false`). */
  hidden?: boolean;
}

export function filterThreads(
  threads: readonly Task[],
  filter: ThreadFilter,
): Task[] {
  return threads.filter((thread) => {
    if (
      filter.ownerUserId !== undefined &&
      thread.created_by !== filter.ownerUserId
    )
      return false;
    if (
      filter.hasTrigger !== undefined &&
      Boolean(thread.trigger_id) !== filter.hasTrigger
    )
      return false;
    if (filter.hidden !== undefined && Boolean(thread.hidden) !== filter.hidden)
      return false;
    return true;
  });
}
