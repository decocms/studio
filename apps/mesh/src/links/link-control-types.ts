/**
 * Shared link control-plane request shape.
 *
 * `RequestFrame` is the cluster → daemon request envelope used by the daemon's
 * in-process control handler (`link-daemon/control-handler.ts`) and the pull
 * reverse-proxy channel (`link-proxy-routes.ts` / `link-proxy-frames.ts`). The
 * WS dispatch-frame codec it once mirrored was deleted in Phase C-bis S8; this
 * is now the standalone request envelope.
 */
export interface RequestFrame {
  type: "request";
  reqId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}
