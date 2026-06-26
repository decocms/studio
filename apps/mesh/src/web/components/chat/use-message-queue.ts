import { useSyncExternalStore } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import type { QueueItemDTO } from "./queue-items";
import {
  enqueueMessage,
  messageQueueStore,
  refreshMessageQueue,
  removeMessage,
} from "./message-queue-store";

/**
 * Subscribe to a thread's frontend message queue (all pending gate items,
 * head included — the panel narrows to the waiting tail via
 * `selectWaitingQueueItems`). Re-renders whenever the store changes.
 */
export function useMessageQueue(threadId: string): QueueItemDTO[] {
  const store = messageQueueStore(threadId);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface MessageQueueActions {
  /** Optimistically append a just-sent message. */
  enqueue: (threadId: string, item: QueueItemDTO) => void;
  /** Cancel a queued message: drop it locally, POST the cancel, re-sync. */
  cancel: (threadId: string, messageId: string) => Promise<void>;
  /** Re-fetch the server's queue and replace the local store. */
  refresh: (threadId: string) => Promise<void>;
}

/** Mutators over the frontend message queue, bound to the active org. */
export function useMessageQueueActions(): MessageQueueActions {
  const { org } = useProjectContext();
  return {
    enqueue: enqueueMessage,
    refresh: (threadId) => refreshMessageQueue(org.slug, threadId),
    cancel: async (threadId, messageId) => {
      const workflowId = `thread-run:${threadId}:${messageId}`;
      removeMessage(threadId, messageId); // optimistic
      try {
        const res = await fetch(
          `/api/${encodeURIComponent(org.slug)}/decopilot/queue/${encodeURIComponent(threadId)}/cancel/${encodeURIComponent(workflowId)}`,
          { method: "POST", credentials: "include" },
        );
        if (!res.ok && res.status !== 404) {
          throw new Error(`Cancel failed: ${res.status}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to cancel");
      } finally {
        await refreshMessageQueue(org.slug, threadId);
      }
    },
  };
}
