import type { LifecycleState } from "@decocms/sandbox/shared";
import type { ClaimPhase } from "../hooks/sandbox-events-context";

export const PHASE_ORDER = ["provision", "cloning", "install", "dev"] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];
export type PhaseStatus = "pending" | "doing" | "done" | "failed";

export interface PhaseProgress {
  step: PhaseKey;
  status: PhaseStatus;
}

export interface PhaseProgressInput {
  /**
   * Pre-daemon claim lifecycle (image pull, capacity wait, etc.). Drives
   * the "provision" slot. Once `kind === "ready"` the daemon takes over
   * and `lifecycle` carries the truth.
   */
  claimPhase: ClaimPhase | null;
  /** Daemon's setup-pipeline state. Authoritative once not `idle`. */
  lifecycle: LifecycleState;
}

/**
 * Single source of truth for the boot lifecycle state. Returns the current
 * step + its status. Other consumers project this into a per-tick status
 * (`phaseStatusFor`) or an active card index (`activePhaseIndex`).
 *
 * Lifecycle is authoritative once it leaves `idle`; we only fall back to
 * `claimPhase` for the pre-daemon "provision" slot.
 */
export function derivePhaseProgress(input: PhaseProgressInput): PhaseProgress {
  switch (input.lifecycle.phase) {
    case "cloning":
    case "checking-out":
      return { step: "cloning", status: "doing" };
    case "clone-failed":
      return { step: "cloning", status: "failed" };
    case "installing":
      return { step: "install", status: "doing" };
    case "install-failed":
      return { step: "install", status: "failed" };
    case "starting":
      return { step: "dev", status: "doing" };
    case "running":
      return { step: "dev", status: "done" };
    case "start-failed":
      return { step: "dev", status: "failed" };
    case "crashed":
      // Was running, daemon's probe stopped responding. Surface as a
      // dev-step failure so the retry path lights up.
      return { step: "dev", status: "failed" };
    case "idle":
      // Daemon hasn't started emitting yet. Fall back to claimPhase so
      // the "provision" slot lights up while the sandbox is being
      // brought online.
      if (
        input.claimPhase &&
        input.claimPhase.kind !== "ready" &&
        input.claimPhase.kind !== "failed"
      ) {
        return { step: "provision", status: "doing" };
      }
      // claimPhase null OR ready: daemon is about to start cloning.
      return { step: "cloning", status: "doing" };
  }
}
