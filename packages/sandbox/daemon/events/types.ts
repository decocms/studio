/**
 * Daemon event wire format. Single source of truth shared with Studio
 * via `@decocms/sandbox/shared`.
 *
 * `DaemonEventMap` keys are the SSE `event:` header values; values are the
 * payload shape JSON-serialized into the SSE `data:` field. No discriminator
 * lives inside the payload — the wire's event header carries it.
 */

/** Where the setup pipeline is right now. Drives Studio's retry UI. */
export type LifecycleState =
  | { phase: "idle" }
  | { phase: "cloning" }
  | { phase: "checking-out"; to: string }
  | { phase: "clone-failed"; error: string }
  | { phase: "installing" }
  | { phase: "install-failed"; error: string }
  | { phase: "starting" }
  | { phase: "running"; port: number; htmlSupport: boolean }
  | { phase: "start-failed"; error: string }
  /** Was running, stopped responding to the probe. */
  | { phase: "crashed" };

/** Git metadata, separate from lifecycle. `unknown` until the first compute. */
export type BranchMeta =
  | { kind: "unknown" }
  | {
      kind: "ready";
      branch: string;
      base: string;
      workingTreeDirty: boolean;
      unpushed: number;
      aheadOfBase: number;
      behindBase: number;
      headSha: string;
    };

/** Active task summary surfaced for Studio's Run/Restart UI. */
export interface ActiveTaskSummary {
  id: string;
  command: string;
  logName?: string;
}

/**
 * Daemon's overall operational state. Distinct from `LifecycleState` —
 * lifecycle tracks pipeline progress (cloning → installing → running),
 * status tracks whether the dev script is allowed to run and whether
 * a side effect (e.g. unexpected crash) forced it off.
 *
 * `running` — proceeding normally
 * `paused`  — user/orchestrator asked to stop progressing
 * `error`   — daemon stopped on its own (e.g. dev script exit non-zero);
 *             `reason` carries detail
 */
export interface DaemonStatus {
  state: "running" | "paused" | "error";
  reason?: string;
}

export interface DaemonEventMap {
  lifecycle: { state: LifecycleState };
  status: DaemonStatus;
  tasks: { active: ActiveTaskSummary[] };
  scripts: { scripts: string[] };
  branch: { meta: BranchMeta };
  reload: Record<string, never>;
}

export type DaemonEventName = keyof DaemonEventMap;
export type DaemonEventPayload<K extends DaemonEventName> = DaemonEventMap[K];
