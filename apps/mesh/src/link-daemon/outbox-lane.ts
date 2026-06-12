/**
 * Lane classifier for the durable outbox (spec §5.2). A shallow `chunk.type`
 * tag-switch — NOT folding. The daemon reads only `chunk.type` to pick a lane;
 * the lane is an internal outbox/priority concern and is never written to the
 * NDJSON wire (no protocol change at this step).
 *
 *   P0 — control (acks/cancel/flow); never produced by the daemon here.
 *   P1 — tool + terminal (tool-*, lifecycle, error, done); NEVER dropped.
 *   P2 — text/reasoning/data deltas; MAY compact under pressure (a later step).
 *
 * Unknown chunk types default to P2 so a future P1 type is never silently
 * starved — P1 is an explicit allowlist.
 */
import type { DispatchSSEEvent } from "../links/protocol";

export type OutboxLane = 0 | 1 | 2 | 3;

const P1_CHUNK_TYPES = new Set<string>([
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-output-available",
  "tool-output-error",
  "start",
  "start-step",
  "finish-step",
  "finish",
  "abort",
]);

export function laneForEvent(event: DispatchSSEEvent): OutboxLane {
  // `error` and `done` are terminal/tool-class — P1, never dropped.
  if (event.type === "error" || event.type === "done") return 1;
  const chunkType = (event.chunk as { type?: unknown } | undefined)?.type;
  if (typeof chunkType === "string" && P1_CHUNK_TYPES.has(chunkType)) return 1;
  return 2;
}
