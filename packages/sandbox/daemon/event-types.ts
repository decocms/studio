/**
 * Wire-format types for the daemon SSE stream at `/_decopilot_vm/events`.
 *
 * Pure types — no runtime imports — so type-only consumers (notably the
 * studio web bundle) can pull them in without dragging daemon runtime deps
 * through the dependency graph. Follows the same pattern as
 * `server/runner/lifecycle-types.ts`.
 *
 * The daemon byte-pipes these events through mesh's `/api/:org/vm-events` SSE
 * proxy verbatim, so the same types describe what the browser receives.
 */

// ---- Shared value types ------------------------------------------------------

export type UpstreamStatus = "booting" | "online" | "offline";

export type BranchStatusReady = {
  readonly kind: "ready";
  readonly branch: string;
  readonly base: string;
  readonly workingTreeDirty: boolean;
  readonly unpushed: number;
  readonly aheadOfBase: number;
  readonly behindBase: number;
  /** HEAD sha (falls back to origin/<branch>). Empty if the daemon couldn't compute it. */
  readonly headSha: string;
};

export type BranchStatus =
  | { readonly kind: "initializing" }
  | { readonly kind: "cloning" }
  | { readonly kind: "clone-failed"; readonly error: string }
  | { readonly kind: "checking-out"; readonly to: string }
  | { readonly kind: "checkout-failed"; readonly error: string }
  | BranchStatusReady;

export type PhaseStatus = "running" | "done" | "failed";

export interface DaemonPhase {
  id: string;
  name: string;
  status: PhaseStatus;
  startedAt: number;
  doneAt: number | null;
  error?: string;
}

export interface DaemonTask {
  id: string;
  command: string;
  logName?: string;
}

// ---- Event payload map (SSE event name → JSON payload shape) -----------------

export interface DaemonEventMap {
  /** Raw terminal output from a named source (script name, "setup", "daemon"). */
  log: { source: string; data: string };
  /** Upstream HTTP probe state — sent on connect and every 15 s as keepalive. */
  status: { status: UpstreamStatus; port: number | null; htmlSupport: boolean };
  /** npm/bun/etc scripts discovered in the repo's package.json. */
  scripts: { scripts: string[] };
  /** Running task-manager entries (supersedes the legacy `processes` event). */
  tasks: { active: DaemonTask[] };
  /** Operator intent: running (normal) or paused (manually stopped). */
  intent: { state: "running" | "paused"; reason?: string };
  /** Setup phase transitions (clone, install, config-driven transitions). */
  phases: { phases: DaemonPhase[] };
  /** Git branch state from the in-pod watcher. */
  "branch-status": BranchStatus;
  /** Config-driven orchestrator transition lifecycle. */
  transition: {
    kind: string;
    phase: "start" | "done" | "failed";
    error?: string;
  };
}

export type DaemonEventType = keyof DaemonEventMap;
