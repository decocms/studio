/**
 * Chunk-relay wire format (spec: "Transport Convergence", protocol v2).
 *
 * The daemon POSTs an NDJSON stream of relay lines to
 *   POST /api/:org/links/runs/:runId/chunks
 * Each line carries a monotonically increasing seq (1-based, per run) and one
 * DispatchSSEEvent. The cluster dedupes by seq, so the daemon may resend the
 * whole buffered prefix on reconnect. The terminal line is the `done` event.
 */
import { z } from "zod";
import { dispatchSSEEventSchema } from "./schemas";

export const relayLineSchema = z.object({
  seq: z.number().int().positive(),
  event: dispatchSSEEventSchema,
});
export type RelayLine = z.infer<typeof relayLineSchema>;

/** Hard cap on the daemon-side unacked buffer. Beyond this with a dead
 *  connection the run fails loudly rather than ballooning daemon memory. */
export const RELAY_BUFFER_MAX_BYTES = 64 * 1024 * 1024;
