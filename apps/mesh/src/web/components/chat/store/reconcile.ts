export interface RenderedMessage {
  id: string; // message_id
  parts: unknown[];
  status: "complete" | "in_progress";
}

export type GapResult = "ok" | "duplicate" | "gap";

/** A gap is a sequence comparison, never silent (kills B4). */
export function detectGap(lastSeq: number, incomingSeq: number): GapResult {
  if (incomingSeq === lastSeq + 1) return "ok";
  if (incomingSeq <= lastSeq) return "duplicate";
  return "gap";
}

/**
 * Durable wins, keyed by message_id (R6). A complete durable message can never
 * be downgraded by a late live partial; an in_progress live partial is replaced
 * in place by the durable version. The partial never survives as a second row (R7).
 */
export function reconcileDurable(
  rendered: Map<string, RenderedMessage>,
  incoming: RenderedMessage,
): Map<string, RenderedMessage> {
  const next = new Map(rendered);
  const existing = next.get(incoming.id);
  if (existing?.status === "complete" && incoming.status === "in_progress") {
    return next; // never downgrade a finished message
  }
  next.set(incoming.id, incoming);
  return next;
}
