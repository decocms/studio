import { useSyncExternalStore } from "react";
import { useProjectContext } from "@/sdk";
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
 * running head included — consumers narrow to the waiting tail via
 * `selectQueuedItems`). Re-renders whenever the store changes.
 */
export function useMessageQueue(threadId: string): QueueItemDTO[] {
  const store = messageQueueStore(threadId);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface MessageQueueActions {
  /** Optimistically append a just-sent message. */
  enqueue: (threadId: string, item: QueueItemDTO) => void;
  /** Cancel a queued message: drop it locally, POST the cancel, re-sync.
   *  Resolves true when the server confirmed (ok, or 404 = already gone),
   *  false on failure — callers must gate irreversible local cleanup (e.g.
   *  dropping the message bubble) on a true result. Either way the optimistic
   *  queue-store drop happens immediately and the finally-refresh restores
   *  the entry if the cancel didn't land. */
  cancel: (threadId: string, messageId: string) => Promise<boolean>;
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
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to cancel");
        return false;
      } finally {
        await refreshMessageQueue(org.slug, threadId);
      }
    },
  };
}
