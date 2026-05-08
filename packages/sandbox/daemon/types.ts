export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";
export type RuntimeName = "node" | "bun" | "deno";

/** Runtime-derived adornment, never persisted to disk. */
export interface DerivedRuntime {
  readonly name: RuntimeName;
  readonly pathPrefix: string;
}

export interface BootConfig {
  readonly daemonToken: string;
  readonly daemonBootId: string;
  /**
   * Workspace root. Contains `app/` (the cloned repo), `daemon/` (config
   * + persistence), and `tmp/` (log tees). fs/bash routes are clamped here
   * so the LLM can read/mutate everything inside the workspace.
   */
  readonly appRoot: string;
  /** `<appRoot>/repo` — cwd for git, install, dev script, scripts. */
  readonly repoDir: string;
  readonly proxyPort: number;
  readonly dropPrivileges?: boolean;
}

export interface GitIdentity {
  readonly userName: string;
  readonly userEmail: string;
}

export interface GitRepository {
  readonly cloneUrl: string;
  readonly branch?: string;
  readonly repoName?: string;
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
  /** Port the dev script binds to (set as PORT env). Mesh always supplies this. */
  readonly port?: number;
}

/**
 * User-intent state for a sandboxed application. The daemon never writes this
 * file — `<repoDir>/.decocms/daemon.json` is read at boot as a fallback for
 * fields the mesh didn't supply, and any further refinements (lockfile-based
 * package manager / runtime detection) happen in memory only. The file lives
 * in the repo iff a tenant chose to commit it themselves.
 */
export interface TenantConfig {
  readonly git?: GitConfig;
  readonly application?: Application;
}

/** In-memory enriched view: TenantConfig + derivations. */
export interface EnrichedTenantConfig extends TenantConfig {
  /** Computed from `application.runtime`. */
  readonly runtimePathPrefix: string;
}

/** What the rest of the daemon (orchestrator, routes) sees. */
export type Config = BootConfig & EnrichedTenantConfig;

export interface BroadcastSource {
  /** "setup" | "daemon" | script name */
  readonly name: string;
}

export interface SseFrame {
  readonly event: string;
  readonly payload: string;
}

export type BranchStatusReady = {
  readonly kind: "ready";
  readonly branch: string;
  readonly base: string;
  readonly workingTreeDirty: boolean;
  readonly unpushed: number;
  readonly aheadOfBase: number;
  readonly behindBase: number;
  readonly headSha: string;
};

export type BranchStatus =
  | { readonly kind: "initializing" }
  | { readonly kind: "cloning" }
  | { readonly kind: "clone-failed"; readonly error: string }
  | { readonly kind: "checking-out"; readonly to: string }
  | { readonly kind: "checkout-failed"; readonly error: string }
  | BranchStatusReady;
