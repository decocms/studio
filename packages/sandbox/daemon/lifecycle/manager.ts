import type { Broadcaster } from "../events/broadcast";
import type { LifecycleState } from "../events/types";

export interface LifecycleManagerDeps {
  broadcaster: Broadcaster;
}

/**
 * Owns the daemon's setup-pipeline state. Replaces the previous split between
 * `PhaseManager` (typed task IDs with begin/done/fail) and `BranchStatus`'s
 * phase tracking (cloning / clone-failed / checking-out / checkout-failed).
 *
 * The orchestrator and probe call `transition` to advance the state; the
 * broadcaster fans the typed `lifecycle` event to SSE subscribers, and the
 * SSE handshake pulls `current` for late-joiners.
 */
export class LifecycleManager {
  private state: LifecycleState = { phase: "idle" };

  constructor(private readonly deps: LifecycleManagerDeps) {}

  current(): LifecycleState {
    return this.state;
  }

  /** Idempotent — same-shape transitions don't re-broadcast. */
  transition(next: LifecycleState): void {
    if (equal(this.state, next)) return;
    this.state = next;
    this.deps.broadcaster.emit("lifecycle", { state: next });
  }
}

function equal(a: LifecycleState, b: LifecycleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
