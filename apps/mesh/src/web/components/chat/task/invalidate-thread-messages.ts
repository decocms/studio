/**
 * Invalidate the THREAD_MESSAGES React Query cache for a specific thread.
 *
 * Used by ThreadEventsBridge to refresh the messages cache when ANY thread
 * transitions (status change, finish) — regardless of which thread is
 * currently visible. The predicate mirrors the cache key shape produced by
 * useCollectionList(orgId, "THREAD_MESSAGES", ...) in mesh-sdk: position [3]
 * is "collection", [4] is the uppercased collection name, [6] is the
 * serialized tool arguments JSON containing the thread_id filter.
 */
import type { QueryClient } from "@tanstack/react-query";

export function invalidateThreadMessages(
  queryClient: QueryClient,
  taskId: string,
): void {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[3] !== "collection" || key[4] !== "THREAD_MESSAGES") return false;
      const serialized = typeof key[6] === "string" ? key[6] : "";
      return serialized.includes(taskId);
    },
  });
}
