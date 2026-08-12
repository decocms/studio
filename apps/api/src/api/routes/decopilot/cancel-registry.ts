/**
 * Module-level handle on the app's `CancelBroadcast`.
 *
 * Stopping a run means reaching its `AbortController`, which lives in a
 * `RunRegistry` on whichever pod owns the run. The only path there is
 * `cancelBroadcast.broadcast()` — it invokes the local `onCancel` (abort
 * background jobs + registry `CANCEL`) and publishes to every other pod. But
 * the broadcaster is constructed in app wiring and handed to
 * `createDecopilotRoutes` as a closure dep, so nothing outside the HTTP layer
 * could ask for a cancel: an MCP tool that needs to stop a run had no way to.
 *
 * This is that seam, the same shape as `sseHub`. Registered once by app wiring.
 */

import type { CancelBroadcast } from "./cancel-broadcast";

let broadcaster: CancelBroadcast | null = null;

/** Called once by app wiring, right after the broadcaster is constructed. */
export function setCancelBroadcast(next: CancelBroadcast): void {
  broadcaster = next;
}

/**
 * Ask every pod to abort the run on `threadId`. No-op when no broadcaster is
 * registered (unit tests, the desktop path) — callers treat cancel as
 * best-effort, never as a precondition.
 */
export function broadcastRunCancel(threadId: string): void {
  broadcaster?.broadcast(threadId);
}
