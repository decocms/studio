import {
  dropQueueItem,
  upsertQueueItem,
  type QueueItemDTO,
} from "./queue-items";
import { Store } from "./store/store-primitive";

/**
 * Per-thread frontend message queue. A module-scoped registry of Stores keyed
 * by thread id, so a thread's queue outlives any single chat mount (switching
 * threads and back keeps the optimistic queue). Seeded from the server
 * `/queue` endpoint and written optimistically when the user sends a message
 * behind a running turn. The panel reads this — not the network — so a queued
 * message appears instantly.
 */
const stores = new Map<string, Store<QueueItemDTO[]>>();

export function messageQueueStore(threadId: string): Store<QueueItemDTO[]> {
  let store = stores.get(threadId);
  if (!store) {
    store = new Store<QueueItemDTO[]>([]);
    stores.set(threadId, store);
  }
  return store;
}

/** Optimistically append a just-sent message (idempotent by messageId). */
export function enqueueMessage(threadId: string, item: QueueItemDTO): void {
  messageQueueStore(threadId).update((cur) => upsertQueueItem(cur, item));
}

/** Drop a message — cancelled, or dequeued into the running slot. */
export function removeMessage(threadId: string, messageId: string): void {
  messageQueueStore(threadId).update((cur) => dropQueueItem(cur, messageId));
}

/** Replace a thread's queue with the server's authoritative list. */
export function setQueue(threadId: string, items: QueueItemDTO[]): void {
  messageQueueStore(threadId).set(items);
}

/**
 * Fetch the server's gate queue for a thread and replace the local store.
 * Best-effort: on any error the optimistic store stands until the next call.
 */
export async function refreshMessageQueue(
  orgSlug: string,
  threadId: string,
): Promise<void> {
  try {
    const res = await fetch(
      `/api/${encodeURIComponent(orgSlug)}/decopilot/queue/${encodeURIComponent(threadId)}`,
      { credentials: "include" },
    );
    if (!res.ok) return;
    const body = (await res.json()) as { items?: QueueItemDTO[] };
    setQueue(threadId, body.items ?? []);
  } catch {
    // best-effort — leave the current store contents in place
  }
}
