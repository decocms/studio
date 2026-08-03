/**
 * Studio's view of the sandbox daemon's wire contract: the config JSON it PATCHes
 * to `/config`, and the SSE event shapes it reads back.
 *
 * The daemon itself is Go (`daemon-go/`, structs in `internal/config` and
 * `internal/events`); this file is the TypeScript side of the same JSON. Keep it
 * minimal — daemon-internal shapes (boot config, derived runtime, config
 * transitions) belong in the Go source, not here.
 */

import type { CoAuthorIdentity } from "./git-co-author";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";
export type RuntimeName = "node" | "bun" | "deno";

export interface GitIdentity {
  readonly userName: string;
  readonly userEmail: string;
}

/** Studio user operating the sandbox — appended as git co-author on commits. */
export type OperatorIdentity = CoAuthorIdentity;

/**
 * A credential for fetching git submodules whose remotes the main clone token
 * can't reach (different repo/org). `token` is a PAT; the daemon writes it to a
 * git-only credentials file and rewrites `git@<host>:` SSH submodule URLs to
 * HTTPS so the token authenticates. Never placed in the process env bag.
 */
export interface SubmoduleCredential {
  readonly host: string;
  readonly token: string;
}

export interface GitRepository {
  readonly cloneUrl: string;
  readonly branch?: string;
  readonly repoName?: string;
  /**
   * Credentials for private submodules, keyed by host. Absent/empty means
   * submodules are fetched with only the ambient (no-credential) git config —
   * public submodules work, private ones on other hosts fail auth.
   */
  readonly submoduleCredentials?: readonly SubmoduleCredential[];
}

export interface GitConfig {
  readonly repository: GitRepository;
  readonly identity?: GitIdentity;
}

export interface PackageManagerConfig {
  readonly name: PackageManager;
  readonly path?: string;
}

export interface Application {
  readonly packageManager?: PackageManagerConfig;
  readonly runtime?: RuntimeName;
  /** Port the dev script binds to (set as PORT env). Studio always supplies this. */
  readonly port?: number;
}

/**
 * User-intent state for a sandboxed application. The daemon never writes this
 * file — `<repoDir>/.decocms/daemon.json` is read at boot as a fallback for
 * fields the studio didn't supply, and any further refinements (lockfile-based
 * package manager / runtime detection) happen in memory only. The file lives
 * in the repo iff a tenant chose to commit it themselves.
 */
export interface TenantConfig {
  readonly git?: GitConfig;
  readonly operator?: OperatorIdentity;
  readonly application?: Application;
  readonly env?: Readonly<Record<string, string>>;
}

/** A `/config` PATCH body. `null` env values delete the variable. */
export type ConfigPatch = Partial<Omit<TenantConfig, "env">> & {
  env?: Record<string, string | null>;
};

// ── SSE events ──────────────────────────────────────────────────────────────
// `DaemonEventMap` keys are the SSE `event:` header values; values are the
// payload shape JSON-serialized into the SSE `data:` field. No discriminator
// lives inside the payload — the wire's event header carries it.

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
  "file-changed": { path: string };
}

export type DaemonEventName = keyof DaemonEventMap;
export type DaemonEventPayload<K extends DaemonEventName> = DaemonEventMap[K];
