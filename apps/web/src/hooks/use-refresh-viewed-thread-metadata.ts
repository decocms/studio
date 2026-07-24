/**
 * useRefreshViewedThreadMetadata — one-shot fresh read of a read-only
 * teammate's thread metadata.
 *
 * A read-only viewer's panel row can predate the thread's `load_repo` binding:
 * the live `data-open-preview` stream chunk that patches `githubRepo` /
 * `sandboxMap` onto the client row reaches only the user who ran the tool, and
 * the thread-status SSE carries no metadata. That stale row makes the preview
 * show "no source to preview" and hides the owner's already-running sandbox
 * (the owner-keyed sandbox lookup finds nothing). Force a fresh
 * `COLLECTION_THREADS_GET` and merge it into the store so `activeTask` picks up
 * the current metadata.
 *
 * Gated to OTHERS' threads: the owner's own row is kept current by the live
 * stream, so there's nothing to refresh.
 *
 * ponytail: fires once per (org, thread) — enough for the reported case (a
 * completed thread opened read-only). A teammate's thread that binds a repo
 * while you're already watching it won't refresh until reload; add a finite
 * staleTime / refetch if that ever matters.
 */

import { useQuery } from "@tanstack/react-query";
import { useProjectContext } from "@/sdk";
import { authClient } from "@/lib/auth-client";
import { useOptionalThreadManager } from "@/components/chat/store/hooks";
import { KEYS } from "@/lib/query-keys";
import type { Task } from "@/components/chat/task/types";

export function useRefreshViewedThreadMetadata(task: Task | null): void {
  const { org } = useProjectContext();
  const manager = useOptionalThreadManager();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  const taskId = task?.id ?? null;
  const isOthersThread =
    !!task && !!userId && !!task.created_by && task.created_by !== userId;

  useQuery({
    queryKey: KEYS.viewedThreadMetadataRefresh(org.id, taskId ?? ""),
    enabled: !!manager && !!taskId && isOthersThread,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      await manager?.refreshThreadMetadata(taskId ?? "");
      return true;
    },
  });
}
