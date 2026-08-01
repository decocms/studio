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
  /**
   * Reports a finished `start` phase. Spawning the dev script says nothing
   * about whether it serves — the process is created and the call returns, so
   * timing that would measure fork latency and never observe a failure. The
   * phase ends where it becomes observable: the probe seeing the server
   * (`running`) or the dev script dying (`start-failed`).
   */
  onStartPhase?: (status: "done" | "failed", durationMs: number) => void;
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
  private startAttemptAt: number | null = null;

  constructor(private readonly deps: LifecycleManagerDeps) {}

  current(): LifecycleState {
    return this.state;
  }

  /**
   * A dev script was just spawned. The phase it opens is closed by the next
   * `running` / `start-failed` transition. A second attempt before the first
   * resolves (branch change mid-boot) replaces it: the abandoned attempt has no
   * terminal state to measure to.
   */
  noteStartAttempt(): void {
    this.startAttemptAt = Date.now();
  }

  /** The step spawned nothing, so no phase was opened. */
  cancelStartAttempt(): void {
    this.startAttemptAt = null;
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
    if (
      this.startAttemptAt !== null &&
      (next.phase === "running" || next.phase === "start-failed")
    ) {
      const durationMs = Date.now() - this.startAttemptAt;
      this.startAttemptAt = null;
      this.deps.onStartPhase?.(
        next.phase === "running" ? "done" : "failed",
        durationMs,
      );
    }
  }
}

function equal(a: LifecycleState, b: LifecycleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
