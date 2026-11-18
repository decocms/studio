import { proxyDaemonRequest } from "../../daemon-client";
import type { ProxyRequestInit } from "../types";

export interface DaemonAddress {
  url: string;
  token: string;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Failures raised before a connection to the daemon existed, so the request
 * cannot have reached it. Bun reports both a failed DNS lookup and a refused
 * connection as `ConnectionRefused`; Node-style codes cover the other runtimes.
 */
const PRE_CONNECT_CODES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return errorCode((err as { cause?: unknown }).cause);
}

/** Whether `err` happened before the request could reach the daemon. */
export function isPreConnectFailure(err: unknown): boolean {
  const code = errorCode(err);
  if (code && PRE_CONNECT_CODES.has(code)) return true;
  return (
    err instanceof Error &&
    /getaddrinfo (ENOTFOUND|EAI_AGAIN)/.test(err.message)
  );
}

/**
 * One daemon request with the two recoveries every provider needs. A 401
 * means the bearer rotated under a cached address (a recreated pool pod); a
 * throw means the address went stale (the pod moved or was evicted). Each
 * re-resolves and retries once, and only when the body can be sent again: of
 * the BodyInit variants only a ReadableStream is consumed by the first fetch.
 *
 * A throw is retried only when sending twice is safe: the method is
 * idempotent, or the failure happened before a connection existed. A reset or
 * timeout on a POST may have run it already, so it surfaces instead.
 */
export async function proxyDaemonWithRetry(
  daemon: DaemonAddress,
  path: string,
  init: ProxyRequestInit,
  reresolve: {
    /** After a 401; null answers the 401. */
    unauthorized(): Promise<DaemonAddress | null>;
    /** After a failed fetch; null rethrows the failure. */
    unreachable(err: unknown): Promise<DaemonAddress | null>;
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
    if (!canRetryBody || init.signal?.aborted) throw err;
    const safe =
      IDEMPOTENT_METHODS.has(init.method.toUpperCase()) ||
      isPreConnectFailure(err);
    if (!safe) throw err;
    const fresh = await reresolve.unreachable(err);
    if (!fresh) throw err;
    return send(fresh);
  }
}
