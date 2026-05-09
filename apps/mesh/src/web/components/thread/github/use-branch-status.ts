import {
  useVmEvents,
  type BranchMeta,
  type LifecycleState,
} from "@/web/components/vm/hooks/use-vm-events";

export type BranchStatusReady = {
  kind: "ready";
  branch: string;
  base: string;
  workingTreeDirty: boolean;
  unpushed: number;
  aheadOfBase: number;
  behindBase: number;
  headSha: string;
};

export type BranchStatus =
  | { kind: "initializing" }
  | { kind: "cloning" }
  | { kind: "clone-failed"; error: string }
  | { kind: "checking-out"; to: string }
  | { kind: "checkout-failed"; error: string }
  | BranchStatusReady;

/**
 * useBranchStatus — projects the daemon's split lifecycle/branch streams
 * into the legacy `BranchStatus` shape consumed by the GitHub panel.
 *
 * The daemon now emits two separate events: `lifecycle` (phase tracking
 * including cloning/checking-out/etc.) and `branch` (git metadata when
 * ready). This hook unifies them so the panel can switch on a single value.
 */
export function useBranchStatus(): BranchStatus | null {
  const { lifecycle, branch } = useVmEvents();
  return deriveBranchStatus(lifecycle, branch);
}

function deriveBranchStatus(
  lifecycle: LifecycleState,
  branch: BranchMeta,
): BranchStatus | null {
  // Lifecycle drives the pre-ready states the panel cares about.
  switch (lifecycle.phase) {
    case "idle":
      // Pre-config: nothing's happened yet.
      return { kind: "initializing" };
    case "cloning":
      return { kind: "cloning" };
    case "clone-failed":
      // Daemon collapses checkout failures into clone-failed; the panel's
      // checkout-failed branch is unreachable but kept for type stability.
      return { kind: "clone-failed", error: lifecycle.error };
    case "checking-out":
      return { kind: "checking-out", to: lifecycle.to };
  }

  // Past clone/checkout — install/start phases don't belong to the GitHub
  // panel, so we surface branch metadata once it's available.
  if (branch.kind === "ready") return branch;

  // Mid-pipeline (installing/starting/running/...) but branch hasn't been
  // computed yet. Treat as initializing so the panel shows a loading pill.
  return { kind: "initializing" };
}
