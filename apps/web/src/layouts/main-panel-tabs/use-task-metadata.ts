/**
 * useTaskMetadata — the active thread's metadata, read from the single source of
 * truth the panel keeps current.
 *
 * Shared by the tab bar (which decides whether Preview / Code show at all) and
 * by the tab contents (which decide what to render), so the two can never
 * disagree — a tab that is visible because the store row carries a
 * thread-scoped `githubRepo` must not render "no source to preview".
 *
 * The store subscription matters for rows that land AFTER first render (late
 * snapshot, `manager.create` prepend); the suspense query is the cold-load /
 * archived-thread fallback, and `localHit` always wins over it.
 */

import { useSyncExternalStore } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useThreadManager } from "@/components/chat/store/hooks";
import type { ThreadMetadata } from "@decocms/shared/entities";
import type { Task } from "@/components/chat/task/types";

export function useTaskMetadata(taskId: string): ThreadMetadata | null {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const manager = useThreadManager();
  const threads = useSyncExternalStore(
    manager.threads.subscribe,
    manager.threads.get,
  );
  const localHit = taskId
    ? (threads.find((t) => t.id === taskId) ?? null)
    : null;
  const { data: fetchedMetadata } = useSuspenseQuery<
    Task | null,
    Error,
    ThreadMetadata | null
  >({
    queryKey: KEYS.ensureTask(org.id, taskId),
    queryFn: async () => {
      if (!taskId) return null;
      try {
        const { item } = await studio.call("COLLECTION_THREADS_GET", {
          id: taskId,
        });
        return (item as Task | null) ?? null;
      } catch {
        return null;
      }
    },
    select: (task) => task?.metadata ?? null,
    staleTime: 30_000,
  });
  return localHit?.metadata ?? fetchedMetadata ?? null;
}
