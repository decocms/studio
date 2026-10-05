import { proxyDaemonRequest } from "../../daemon-client";
import type { ProxyRequestInit } from "../types";

export interface DaemonAddress {
  url: string;
  token: string;
}

/**
 * One daemon request with the two recoveries every provider needs. A 401
 * means the bearer rotated under a cached address (a recreated pool pod); a
 * throw means the address went stale (the pod moved or was evicted). Each
 * re-resolves and retries once, and only when the body can be sent again: of
 * the BodyInit variants only a ReadableStream is consumed by the first fetch.
 */
export async function proxyDaemonWithRetry(
  daemon: DaemonAddress,
  path: string,
  init: ProxyRequestInit,
  reresolve: {
    /** After a 401; null answers the 401. */
    unauthorized(): Promise<DaemonAddress | null>;
    /** After a failed fetch; null rethrows the failure. */
    unreachable(): Promise<DaemonAddress | null>;
  },
): Promise<Response> {
  const send = (to: DaemonAddress) =>
    proxyDaemonRequest(to.url, to.token, path, init);
  const canRetryBody = !(init.body instanceof ReadableStream);
  try {
    const resp = await send(daemon);
    if (resp.status !== 401 || !canRetryBody) return resp;
    const fresh = await reresolve.unauthorized();
    if (!fresh) return resp;
    // Drain the discarded 401 so its connection is released.
    await resp.body?.cancel().catch(() => {});
    return await send(fresh);
  } catch (err) {
    if (!canRetryBody) throw err;
    const fresh = await reresolve.unreachable().catch(() => null);
    if (!fresh) throw err;
    return send(fresh);
  }
}
