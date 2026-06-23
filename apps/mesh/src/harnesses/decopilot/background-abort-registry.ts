/**
 * In-memory abort registry for in-flight background-tool work, keyed by thread.
 *
 * A backgrounded `generate_image` runs inside a DBOS step on whatever pod
 * dequeues it. DBOS `cancelWorkflow` only interrupts at the next step boundary —
 * it can't abort the provider call already in flight. So the step registers an
 * `AbortController` here; the thread-cancel path (`onCancel`, fanned out to
 * every pod over NATS via `cancelBroadcast`) calls `abortBackgroundJobs(taskId)`
 * to abort it immediately, exactly like the run registry aborts a live turn.
 *
 * Per-pod and ephemeral: only the pod running the step holds the controller, and
 * the NATS broadcast is what makes a cancel arriving on any other pod reach it.
 */

const controllers = new Map<string, Set<AbortController>>();

/** Register a fresh controller for a thread's in-flight background work. */
export function registerBackgroundAbort(threadId: string): AbortController {
  const ac = new AbortController();
  let set = controllers.get(threadId);
  if (!set) {
    set = new Set();
    controllers.set(threadId, set);
  }
  set.add(ac);
  return ac;
}

/** Drop a controller once its work has settled (success or failure). */
export function unregisterBackgroundAbort(
  threadId: string,
  ac: AbortController,
): void {
  const set = controllers.get(threadId);
  if (!set) return;
  set.delete(ac);
  if (set.size === 0) controllers.delete(threadId);
}

/** Abort every in-flight background call for a thread on THIS pod. No-op when
 *  none are registered here (the work is running on another pod). */
export function abortBackgroundJobs(threadId: string): void {
  const set = controllers.get(threadId);
  if (!set) return;
  for (const ac of set) ac.abort();
  controllers.delete(threadId);
}
