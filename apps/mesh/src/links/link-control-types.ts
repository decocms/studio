/**
 * Shared link control-plane request shape.
 *
 * `RequestFrame` is the cluster → daemon request envelope used by the daemon's
 * in-process control handler (`link-daemon/control-handler.ts`). It mirrors the
 * `request` variant of the WS dispatch-frame protocol (`dispatch-frames.ts`),
 * but lives here so the surviving control handler does not depend on the
 * to-be-deleted WS frame codec. Keep the field set in sync with the `request`
 * frame in `dispatch-frames.ts` until the WS path is removed.
 */
export interface RequestFrame {
  type: "request";
  reqId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}
