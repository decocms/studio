/**
 * Module-scoped registry mapping tunnel request IDs (`reqId`) to per-request
 * AbortControllers.
 *
 * The cluster-to-daemon transport opens ONE reqId per request: the long-lived
 * `/events` SSE, the `/idle` poll, and each decopilot vm-tool call are all
 * distinct reqIds (one run fans out to many). So this registry is keyed by
 * **reqId**, NOT runId — `run-abort-registry.ts` (keyed by runId) is the
 * sibling for work-item dispatch; the two are intentionally separate (a single
 * run holds one runId but many proxy reqIds).
 *
 * Lifecycle:
 *   - The daemon registers an AbortController per incoming RequestFrame and
 *     unregisters it in the handler's `finally` (so the Map can't grow
 *     unboundedly — one entry per in-flight request at most).
 *   - A `{type:"cancel_req",reqId}` control frame calls `abort(reqId)` here.
 *     Aborting releases `handleStream`'s reader, which runs `acquireDispatch`'s
 *     release — the ONLY thing that frees an `/events` SSE slot
 *     (`MAX_SSE_CLIENTS=100`), since `/events` never ends on its own.
 */

const registry = new Map<string, AbortController>();

/**
 * Create a fresh AbortController for `reqId`, store it, and return it — UNLESS
 * `reqId` is already in-flight, in which case return `null` WITHOUT touching the
 * existing entry (idempotent-delivery dedup). The cluster re-publishes the same
 * RequestFrame to bridge a dropped publish (request-leg tolerance); a duplicate
 * copy that races the live handler must be dropped, not processed twice. The
 * caller skips the request when this returns `null`.
 */
export function register(reqId: string): AbortController | null {
  if (registry.has(reqId)) return null;
  const ac = new AbortController();
  registry.set(reqId, ac);
  return ac;
}

/**
 * Abort the controller registered for `reqId`.
 * Returns `true` if a controller was found and aborted, `false` otherwise.
 */
export function abort(reqId: string): boolean {
  const ac = registry.get(reqId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * Remove the entry for `reqId` from the registry.
 * No-op if the entry does not exist (idempotent).
 */
export function unregister(reqId: string): void {
  registry.delete(reqId);
}

/** Current number of in-flight proxy requests. Exposed for tests/diagnostics. */
export function size(): number {
  return registry.size;
}
