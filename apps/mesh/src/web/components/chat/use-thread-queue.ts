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
 * Read this thread's pending gate queue. Event-driven, not polled: the query
 * is re-fetched via `KEYS.threadQueue` invalidation on send (chat-context),
 * on cancel (below), and on every SSE run start/end edge (the `conn.status`
 * subscription in chat-context). No timer, no useEffect (lint ban).
 */
export function useThreadQueue(taskId: string): { items: QueueItemDTO[] } {
  const { org } = useProjectContext();
  const { data } = useQuery({
    queryKey: KEYS.threadQueue(taskId),
    enabled: Boolean(taskId),
    staleTime: 0,
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
