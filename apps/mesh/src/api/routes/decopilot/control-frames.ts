/**
 * Control-frame codec for the pull-transport control channel (Phase C).
 *
 * Control frames are published cluster-side to `links.control.<userSub>` (core
 * NATS) and consumed by the daemon via the long-poll GET /api/links/control
 * endpoint.
 *
 * Frame types:
 *   - `cancel`     (Phase C)     — abort an in-flight RUN by runId (work-poll
 *                                  dispatch path → run-abort-registry).
 *   - `cancel_req` (Phase C-bis) — abort an in-flight pull reverse-proxy REQUEST
 *                                  by reqId (proxy-poll path → proxy-abort-
 *                                  registry). Routed through the control channel
 *                                  because the outbound-only daemon cannot
 *                                  subscribe to `links.proxy.cancel.<reqId>`
 *                                  directly; the held control-poll is the only
 *                                  inbound signal it has.
 *   - `keep_alive` (Phase C)     — server heartbeat; ignored by the daemon.
 *
 * Additional frame types (ensure_sandbox, delete_sandbox, approval) are deferred.
 */
import { z } from "zod";

export const controlFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  z.object({ type: z.literal("cancel_req"), reqId: z.string() }),
  z.object({ type: z.literal("keep_alive") }),
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;

/** Serialize a control frame to a JSON string for NATS publish. */
export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** Deserialize and validate a raw JSON string into a ControlFrame. Throws on invalid input. */
export function decodeControlFrame(raw: string): ControlFrame {
  return controlFrameSchema.parse(JSON.parse(raw));
}
