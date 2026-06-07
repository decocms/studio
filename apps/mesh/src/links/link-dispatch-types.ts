/**
 * Transport-neutral dispatch types for the cluster ↔ daemon control channel.
 *
 * These describe the request/response contract a `DispatchFn` exposes,
 * carried by the pull reverse-proxy channel in `link-proxy-routes.ts`.
 * They live here — a sibling of `link-control-types.ts` — so the consumers
 * (`runner.ts` `proxyDaemonRequest`/`dispatchJson`/`probeHealth`) and the
 * pull adapter share a single source of truth.
 */

export interface DispatchRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface DispatchHeaders {
  status: number;
  headers: Record<string, string>;
}

/**
 * Yielded events. The daemon's `headers` frame surfaces as `{ headers }` (once,
 * before any body chunks); body chunks surface as `{ data }`. Consumers that
 * need the upstream status must read `chunk.headers` rather than assuming 200.
 */
export interface DispatchChunk {
  data?: string;
  headers?: DispatchHeaders;
}

export interface DispatchOptions {
  signal?: AbortSignal;
}

export type DispatchFn = (
  userSub: string,
  req: DispatchRequest,
  opts?: DispatchOptions,
) => AsyncIterable<DispatchChunk>;
