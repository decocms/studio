/** A pending message in a thread's gate queue, as surfaced to the UI. */
export interface QueueItemDTO {
  /** Full DBOS workflow id: `thread-run:{threadId}:{messageId}`. */
  workflowId: string;
  /** Trailing segment of the workflow id (the user message id). */
  messageId: string;
  /** Display text of the queued user message. */
  text: string;
  /** PENDING ("running") → being processed; ENQUEUED ("queued") → waiting. */
  status: "running" | "queued";
  /** Epoch ms the gate was created/enqueued. */
  enqueuedAt: number;
}

/**
 * The messages *waiting behind* the active run, for the queue panel.
 *
 * The active run is the oldest non-terminal gate workflow — whether it's
 * already PENDING ("running") or still ENQUEUED in the brief "accepted and
 * queued" window before it flips to PENDING. That message is the one being
 * processed and is already rendered in the chat body, so the panel must
 * exclude it and show only what comes next. Pure + total.
 */
export function selectWaitingQueueItems(items: QueueItemDTO[]): QueueItemDTO[] {
  if (items.length <= 1) return [];
  const sorted = [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return sorted.slice(1);
}

/** Append an item unless its messageId is already present (idempotent). */
export function upsertQueueItem(
  items: QueueItemDTO[],
  item: QueueItemDTO,
): QueueItemDTO[] {
  return items.some((i) => i.messageId === item.messageId)
    ? items
    : [...items, item];
}

/** Remove the item with the given messageId. */
export function dropQueueItem(
  items: QueueItemDTO[],
  messageId: string,
): QueueItemDTO[] {
  return items.filter((i) => i.messageId !== messageId);
}
