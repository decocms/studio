import type { Task } from "@/components/chat/task/types";

/**
 * Pick the closest thread the current user owns in the sidebar's rendered
 * order. Prefer the row below the archived thread, then scan upward when there
 * is no eligible row below it. Team threads stay manually selectable but are
 * never opened automatically.
 */
export function findArchiveFallback(
  threads: Task[],
  archivedThreadId: string,
  currentUserId: string | null | undefined,
): Task | undefined {
  if (!currentUserId) return undefined;

  const archivedIndex = threads.findIndex(
    (thread) => thread.id === archivedThreadId,
  );
  if (archivedIndex === -1) return undefined;

  for (let index = archivedIndex + 1; index < threads.length; index++) {
    const thread = threads[index];
    if (thread?.created_by === currentUserId) return thread;
  }

  for (let index = archivedIndex - 1; index >= 0; index--) {
    const thread = threads[index];
    if (thread?.created_by === currentUserId) return thread;
  }

  return undefined;
}
