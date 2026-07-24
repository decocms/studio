/**
 * In-memory "flip to background" registry, keyed by thread → tool call.
 *
 * A foreground (inline) backgroundable tool call — today `subtask` — holds the
 * per-thread gate open while it runs. The user can ask to move it to the
 * background so the chat frees up: `makeBackgroundable` registers the running
 * call here (by toolCallId); the flip request (fanned out to every pod over
 * NATS via `flip-broadcast`) calls `requestFlip(threadId, toolCallId)`, which
 * resolves the `flipped` promise the running generator is racing on. It then
 * aborts the inline run and takes its background branch instead.
 *
 * Per-pod and ephemeral — mirrors `background-abort-registry`: only the pod
 * running the turn holds the resolver, and the NATS broadcast is what makes a
 * flip arriving on any other pod reach it. Resolving twice (self + broadcast
 * echo) is harmless: the promise is already settled and the consumer disposes.
 */

const pending = new Map<string, Map<string, () => void>>();

/** Register a running backgroundable call so it can be flipped mid-flight.
 *  `flipped` resolves once a flip is requested for this (thread, toolCall). */
export function registerFlip(
  threadId: string,
  toolCallId: string,
): { flipped: Promise<void>; dispose(): void } {
  let byTool = pending.get(threadId);
  if (!byTool) {
    byTool = new Map();
    pending.set(threadId, byTool);
  }
  let resolve!: () => void;
  const flipped = new Promise<void>((r) => {
    resolve = r;
  });
  byTool.set(toolCallId, resolve);
  return {
    flipped,
    dispose() {
      const m = pending.get(threadId);
      if (!m) return;
      m.delete(toolCallId);
      if (m.size === 0) pending.delete(threadId);
    },
  };
}

/** Request a flip for a specific in-flight call. No-op when it isn't running on
 *  this pod (registered elsewhere, or already completed/disposed). */
export function requestFlip(threadId: string, toolCallId: string): void {
  pending.get(threadId)?.get(toolCallId)?.();
}
