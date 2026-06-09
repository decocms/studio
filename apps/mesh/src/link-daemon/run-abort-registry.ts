/**
 * Module-scoped registry mapping run IDs to per-run AbortControllers.
 *
 * Used by the pull-transport dispatch path so the control-poll loop can abort
 * a specific in-flight `handleLocalDispatch` call when the cluster sends a
 * `{type:"cancel", runId}` control frame — without touching the loop-wide
 * AbortController that would tear down the entire pull connection.
 *
 * Memory note: entries are unregistered in the `onWork` finally block so the
 * Map does not grow unboundedly (one entry per in-flight dispatch at most).
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */

const registry = new Map<string, AbortController>();

/**
 * Create a fresh AbortController for `runId`, store it, and return it.
 * Overwrites any prior controller for the same runId (e.g. a duplicate
 * delivery after the prior run already completed).
 */
export function register(runId: string): AbortController {
  const ac = new AbortController();
  registry.set(runId, ac);
  return ac;
}

/**
 * Abort the controller registered for `runId`.
 * Returns `true` if a controller was found and aborted, `false` otherwise.
 */
export function abort(runId: string): boolean {
  const ac = registry.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * Remove the entry for `runId` from the registry.
 * No-op if the entry does not exist (idempotent).
 */
export function unregister(runId: string): void {
  registry.delete(runId);
}
