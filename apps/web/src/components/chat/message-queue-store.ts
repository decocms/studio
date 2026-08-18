import type { UIMessage } from "ai";
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
 * behind a running turn. `useMessageQueue` reads this — not the network — so
 * a queued message appears instantly.
 */
const stores = new Map<string, Store<QueueItemDTO[]>>();

/**
 * Cap on distinct threads tracked at once. Nothing ever calls a "thread
 * closed" cleanup here (there's no such lifecycle event), so a long-lived tab
 * that visits many threads over a session would otherwise grow `stores`,
 * `dirtyThreads`, and `pendingBodies` without bound. Evicting the
 * least-recently-touched thread once the map is over the cap keeps memory
 * bounded without needing that missing lifecycle hook.
 */
const MAX_TRACKED_THREADS = 200;

function touchThread(threadId: string): void {
  if (stores.size < MAX_TRACKED_THREADS || stores.has(threadId)) return;
  const oldest = stores.keys().next().value;
  if (oldest === undefined) return;
  stores.delete(oldest);
  dirtyThreads.delete(oldest);
  for (const key of pendingBodies.keys()) {
    if (key.startsWith(`${oldest}:`)) pendingBodies.delete(key);
  }
}

/**
 * Threads that have queued a message behind a running turn since their live
 * body was last known to be in sync. While a thread is "dirty", each run
 * terminal must reconcile the chat body against the server (`reconcileFrom
 * Server`) — a dequeued turn's reply folds into a transient client id on the
 * shared stream and never lands in the body on its own. Cleared once the gate
 * queue drains (the last queued turn has been reconciled).
 */
const dirtyThreads = new Set<string>();

/** Mark that a message was queued behind a running turn — body needs catch-up. */
export function markQueueDirty(threadId: string): void {
  dirtyThreads.add(threadId);
}

export function isQueueDirty(threadId: string): boolean {
  return dirtyThreads.has(threadId);
}

/** The gate queue has drained and the body is reconciled — stop catching up. */
export function clearQueueDirty(threadId: string): void {
  dirtyThreads.delete(threadId);
}

export function messageQueueStore(threadId: string): Store<QueueItemDTO[]> {
  const existing = stores.get(threadId);
  if (existing) {
    // Re-insert to bump this thread to the map's most-recently-used end.
    stores.delete(threadId);
    stores.set(threadId, existing);
    return existing;
  }
  touchThread(threadId);
  const store = new Store<QueueItemDTO[]>([]);
  stores.set(threadId, store);
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
function setQueue(threadId: string, items: QueueItemDTO[]): void {
  messageQueueStore(threadId).set(items);
}

/**
 * Full original messages for queued turns sent FROM THIS CLIENT, keyed
 * `${threadId}:${messageId}`. At dispatch (in_progress + message_id event)
 * the stashed message is applied to the body with full fidelity (attachments
 * included) with zero fetches; reload/other clients fall back to the
 * refetch/reconcile path. Deliberately outside the queue Store so a server
 * list refresh (setQueue) can't drop it.
 */
const pendingBodies = new Map<string, UIMessage>();

export function stashPendingBody(threadId: string, message: UIMessage): void {
  pendingBodies.set(`${threadId}:${message.id}`, message);
}

export function takePendingBody(
  threadId: string,
  messageId: string,
): UIMessage | undefined {
  const key = `${threadId}:${messageId}`;
  const m = pendingBodies.get(key);
  pendingBodies.delete(key);
  return m;
}

export function dropPendingBody(threadId: string, messageId: string): void {
  pendingBodies.delete(`${threadId}:${messageId}`);
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
