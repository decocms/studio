import type { Broadcaster } from "../events/broadcast";
import type { LifecycleState } from "../events/types";
import { recordReady } from "../telemetry";

export interface LifecycleManagerDeps {
  broadcaster: Broadcaster;
  /**
   * Process start, for the boot-to-serving measurement. Injected rather than
   * read from the module so a test can define "boot" without touching globals.
   */
  bootedAt?: number;
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
  private readySeen = false;

  constructor(private readonly deps: LifecycleManagerDeps) {}

  current(): LifecycleState {
    return this.state;
  }

  /** Idempotent — same-shape transitions don't re-broadcast. */
  transition(next: LifecycleState): void {
    if (equal(this.state, next)) return;
    this.state = next;
    this.deps.broadcaster.emit("lifecycle", { state: next });
    // Every path to a serving sandbox ends here, so one hook covers cold boot,
    // golden restore and resume alike. Once per process: a dev server that
    // crashes and comes back re-enters `running`, and counting that as a second
    // cold start would flatter every average it appears in.
    if (next.phase === "running" && !this.readySeen) {
      this.readySeen = true;
      if (this.deps.bootedAt !== undefined) {
        recordReady(Date.now() - this.deps.bootedAt);
      }
    }
  }
}

function equal(a: LifecycleState, b: LifecycleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
