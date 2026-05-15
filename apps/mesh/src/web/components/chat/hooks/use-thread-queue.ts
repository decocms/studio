/**
 * useThreadQueue — inbox of pending agent runs for one thread.
 *
 * Fetches the initial snapshot from `GET /:org/decopilot/threads/:id/queue`,
 * then applies delta events from `useThreadChat`'s onData callback. The
 * apply function is exposed so the chat consumer can forward
 * `data-queue-*` chunks coming off the persistent /attach stream into this
 * cache — no extra subscription needed.
 *
 * Cancel does an optimistic remove + `DELETE /:org/decopilot/threads/:id/queue/:messageId`;
 * the matching `data-queue-cancelled` event arriving on /attach is a no-op
 * because the row is already gone from the cache.
 */

import { useQueryClient, useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

export interface QueuedItem {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
}

interface QueueQueryData {
  items: QueuedItem[];
}

export type QueueEvent =
  | {
      type: "queue-enqueued";
      taskId: string;
      content: string;
      createdAt: string;
    }
  | { type: "queue-dequeued"; taskId: string }
  | { type: "queue-cancelled"; taskId: string };

export function useThreadQueue(
  orgSlug: string,
  threadId: string,
): {
  items: QueuedItem[];
  cancel: (id: string) => Promise<void>;
  apply: (event: QueueEvent) => void;
} {
  const qc = useQueryClient();
  const key = KEYS.threadQueue(orgSlug, threadId);

  const { data } = useQuery({
    queryKey: key,
    enabled: !!threadId,
    queryFn: async (): Promise<QueueQueryData> => {
      const resp = await fetch(
        `/api/${encodeURIComponent(orgSlug)}/decopilot/threads/${encodeURIComponent(threadId)}/queue`,
        { credentials: "include" },
      );
      if (!resp.ok) return { items: [] };
      return (await resp.json()) as QueueQueryData;
    },
  });

  const cancel = async (id: string): Promise<void> => {
    qc.setQueryData<QueueQueryData>(key, (curr) =>
      curr ? { items: curr.items.filter((i) => i.id !== id) } : curr,
    );
    try {
      const resp = await fetch(
        `/api/${encodeURIComponent(orgSlug)}/decopilot/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(id)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!resp.ok && resp.status !== 404) {
        // Cancel raced with the dispatcher (claim won) or some other
        // transient issue. Refetch to converge on the server's truth.
        qc.invalidateQueries({ queryKey: key });
      }
    } catch {
      qc.invalidateQueries({ queryKey: key });
    }
  };

  const apply = (event: QueueEvent): void => {
    qc.setQueryData<QueueQueryData>(key, (curr) => {
      const items = curr?.items ?? [];
      if (event.type === "queue-enqueued") {
        if (items.some((i) => i.id === event.taskId)) return curr ?? { items };
        return {
          items: [
            ...items,
            {
              id: event.taskId,
              threadId,
              content: event.content,
              createdAt: event.createdAt,
            },
          ],
        };
      }
      return { items: items.filter((i) => i.id !== event.taskId) };
    });
  };

  return {
    items: data?.items ?? [],
    cancel,
    apply,
  };
}

/**
 * Decoder for `data-queue-*` chunks coming off the /attach stream. Returns
 * a `QueueEvent` when the chunk is a queue update, or null otherwise.
 * Call from the chat consumer's `onData` callback and feed the result into
 * `apply` from `useThreadQueue`.
 */
export function decodeQueueChunk(chunk: {
  type: string;
  data?: unknown;
}): QueueEvent | null {
  if (!chunk.type.startsWith("data-queue-")) return null;
  const data = chunk.data;
  if (typeof data !== "object" || data === null) return null;
  const evt = data as { type?: string };
  switch (evt.type) {
    case "queue-enqueued":
    case "queue-dequeued":
    case "queue-cancelled":
      return evt as QueueEvent;
    default:
      return null;
  }
}
