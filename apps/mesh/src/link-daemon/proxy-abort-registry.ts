/**
 * Module-scoped registry mapping pull-proxy request IDs (`reqId`) to per-request
 * AbortControllers (Phase C-bis S2).
 *
 * The pull reverse-proxy channel opens ONE reqId per cluster→daemon request:
 * the long-lived `/events` SSE, the `/idle` poll, and each decopilot vm-tool
 * call are all distinct reqIds (one run fans out to many). So this registry is
 * keyed by **reqId**, NOT runId — `run-abort-registry.ts` (keyed by runId) is
 * the sibling for the work-poll dispatch path; the two are intentionally
 * separate (a single run holds one runId but many proxy reqIds).
 *
 * Lifecycle:
 *   - `runProxyPollLoop` registers an AbortController per dequeued RequestFrame
 *     and unregisters it in the handler's `finally` (so the Map can't grow
 *     unboundedly — one entry per in-flight proxy request at most).
 *   - The daemon is outbound-only and cannot subscribe to
 *     `links.proxy.cancel.<reqId>` directly, so cancel is routed through the
 *     EXISTING control-poll: the cluster publishes a `{type:"cancel_req",reqId}`
 *     control frame to `links.control.<userSub>`; the control-poll loop calls
 *     `abort(reqId)` here. Aborting releases `handleStream`'s reader, which runs
 *     `acquireDispatch`'s release — the ONLY thing that frees an `/events` SSE
 *     slot (`MAX_SSE_CLIENTS=100`), since `/events` never ends on its own.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */

const registry = new Map<string, AbortController>();

/**
 * Create a fresh AbortController for `reqId`, store it, and return it.
 * Overwrites any prior controller for the same reqId (a duplicate delivery of
 * the same reqId — should not happen with UUID reqIds, but kept idempotent).
 */
export function register(reqId: string): AbortController {
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
