import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { KEYS } from "../../lib/query-keys";

export interface QueueItemDTO {
  workflowId: string;
  messageId: string;
  text: string;
  status: "running" | "queued";
  enqueuedAt: number;
}

/**
 * Poll this thread's pending gate queue. Polls every 3s while the run is active
 * or items exist (cheap, bounded), otherwise idles (re-fetched on send via the
 * KEYS.threadQueue invalidation in chat-context). No useEffect (lint ban).
 */
export function useThreadQueue(
  taskId: string,
  opts: { active: boolean },
): { items: QueueItemDTO[] } {
  const { org } = useProjectContext();
  const { data } = useQuery({
    queryKey: KEYS.threadQueue(taskId),
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchInterval: (query) => {
      const n =
        (query.state.data as { items?: QueueItemDTO[] } | undefined)?.items
          ?.length ?? 0;
      return opts.active || n > 0 ? 3000 : false;
    },
    queryFn: async (): Promise<{ items: QueueItemDTO[] }> => {
      const res = await fetch(`/api/${org.slug}/decopilot/queue/${taskId}`, {
        credentials: "include",
      });
      if (!res.ok) return { items: [] };
      return (await res.json()) as { items: QueueItemDTO[] };
    },
  });
  return { items: data?.items ?? [] };
}

/** Cancel one queued/running gate item, then refresh the queue. */
export function useCancelQueuedMessage(
  taskId: string,
): (workflowId: string) => void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (workflowId: string) => {
      const res = await fetch(
        `/api/${org.slug}/decopilot/queue/${taskId}/cancel/${encodeURIComponent(workflowId)}`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`Cancel failed: ${res.status}`);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.threadQueue(taskId) }),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Failed to cancel"),
  });
  return (workflowId: string) => mutation.mutate(workflowId);
}
