/**
 * The org's board, awaited.
 *
 * The home has to know whether there is anything to show BEFORE it lays itself
 * out, and a non-suspense read answers "nothing" first and "something" a moment
 * later — a shift on every visit to an org that has a board. This shares the
 * board's query key, so it is the same request, just awaited — and mounts the
 * same live sync, so a card another actor moves reaches the home the way it
 * reaches the board. Sharing the key alone would not: the SSE upserts and the
 * polling backstop hang off the subscription, not the cache entry.
 */

import { useSuspenseQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import type { TaskBoardItem } from "@/layouts/task-board/config";
import {
  taskBoardItemsQueryOptions,
  useTaskBoardLiveSync,
} from "@/hooks/use-task-board-items";

export function useOrgTasksSuspense(): TaskBoardItem[] {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  useTaskBoardLiveSync();
  const { data } = useSuspenseQuery(
    taskBoardItemsQueryOptions(locator, studio),
  );
  return data.items;
}
