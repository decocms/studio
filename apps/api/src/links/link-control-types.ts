/**
 * Shared link control-plane request shape.
 *
 * `RequestFrame` is the cluster → daemon request envelope used by the daemon's
 * in-process control handler (`link-daemon/control-handler.ts`) and the tunnel
 * dispatch channel.
 */
export interface RequestFrame {
  type: "request";
  reqId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}
