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

import type { CoAuthorIdentity } from "../git-co-author";

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

/** In-memory enriched view: TenantConfig + derivations. */
export interface EnrichedTenantConfig extends TenantConfig {
  /** Computed from `application.runtime` — PATH dirs to prepend for structured commands. */
  readonly runtimePathDirs: readonly string[];
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
