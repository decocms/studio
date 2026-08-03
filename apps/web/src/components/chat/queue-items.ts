/** A pending message in a thread's gate queue, as surfaced to the UI. */
export interface QueueItemDTO {
  /** Full DBOS workflow id: `thread-run:{threadId}:{messageId}`. */
  workflowId: string;
  /** Trailing segment of the workflow id (the user message id). */
  messageId: string;
  /** PENDING ("running") → being processed; ENQUEUED ("queued") → waiting. */
  status: "running" | "queued";
  /** Epoch ms the gate was created/enqueued. */
  enqueuedAt: number;
  /** The queued turn's text, for tray rendering. */
  text: string;
  /** True for a locally-queued item not yet confirmed by the server list. */
  optimistic?: boolean;
}

/** Queued (not yet running) messageIds — the body render filters these out. */
export function selectHiddenFromBody(items: QueueItemDTO[]): Set<string> {
  return new Set(
    items.filter((i) => i.status === "queued").map((i) => i.messageId),
  );
}

/** Concat the text parts of a message for optimistic tray display. Pure + total. */
export function textFromParts(
  parts: ReadonlyArray<{ type?: string; text?: unknown }> | undefined,
): string {
  return (parts ?? [])
    .map((p) =>
      p?.type === "text" && typeof p.text === "string" ? p.text : "",
    )
    .join("")
    .trim();
}

/** The queued (not yet running) items, oldest first. Pure + total. */
export function selectQueuedItems(items: QueueItemDTO[]): QueueItemDTO[] {
  return items
    .filter((i) => i.status === "queued")
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
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
