/** Shared inputs and outputs for the hosted AgentSandboxProvider. */

export interface SandboxId {
  userId: string;
  /** Opaque routing key; compose via `composeSandboxRef()`. */
  projectRef: string;
}

/** Opaque handle; transport details stay inside AgentSandboxProvider. */
export interface Sandbox {
  handle: string;
  workdir: string;
  /**
   * Same as `provider.getPreviewUrl(handle)`, returned eagerly. Non-null as
   * long as the sandbox exists — the iframe may still show a connection
   * error if the dev server inside never binds (e.g. repo has no `dev`/
   * `start` script), which is what the UI's booting/ready state tracks.
   */
  previewUrl: string | null;
}

/** When omitted, no dev server is started; the default tool image is used. */
export interface Workload {
  runtime: "node" | "bun" | "deno";
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "deno";
  /**
   * User-pinned dev port. Omit when the user hasn't chosen one — the provider
   * uses its default.
   */
  devPort?: number;
  /** Subdirectory inside the repo where the package manager manifest lives (e.g. `apps/web`). */
  packageManagerPath?: string;
}

/**
 * What a sandbox is for. AgentSandboxProvider may size, pool, and place the two
 * differently.
 *
 * - `interactive` (default): a person is in the loop — dev server, preview URL,
 *   long-lived, one per (user, project).
 * - `harness-run`: one headless agent loop (Claude Code) dispatched to the
 *   in-pod daemon, torn down when the run settles. `cloneOnly` and the absent
 *   preview are consequences of this, not the definition of it.
 */
export type SandboxPurpose = "interactive" | "harness-run";

/**
 * One repository a sandbox checks out. Shared by the primary (`repo`) and the
 * extra checkouts (`extraRepos`), which the daemon treats identically apart
 * from where they land.
 */
export interface EnsureRepo {
  /**
   * Clone URL. May embed an OAuth credential via userinfo (e.g.
   * `https://x-access-token:TOKEN@github.com/...`) — `git clone` stores
   * the credential on the remote so subsequent fetch/pull/push from
   * inside the sandbox work without further plumbing. The embedded token
   * is short-lived (~1h GitHub App token); callers should pass a freshly
   * minted URL on every ensure. Resume/adopt paths forward the new credential
   * to the daemon so it rotates `origin` in place rather than leaving a stale
   * token.
   */
  cloneUrl: string;
  /**
   * GitHub connection backing `cloneUrl`. Persisted so the runner can
   * re-mint a fresh credential on autonomous recovery (pod recreation
   * under a live claim) instead of replaying the stale token baked into
   * `cloneUrl` at first provision. Absent for anonymous/public clones.
   */
  connectionId?: string;
  /**
   * First-class repository backing `cloneUrl` (Studio-owned credentials).
   * When set, re-minting goes through the repository's provider account and
   * `connectionId` is absent. Absent for legacy and anonymous clones.
   */
  repositoryId?: string;
  userName: string;
  userEmail: string;
  branch?: string;
  /** Human-readable label for logs/UI; no functional effect. */
  displayName?: string;
  /**
   * Resolved per-host PATs for fetching private git submodules whose remotes
   * the main clone's per-repo token can't reach. Delivered to the daemon on
   * the git-only config channel (never the env bag). Absent/empty → submodules
   * are only fetched if public. Like `cloneUrl`, these are resolved fresh on
   * every ensure.
   */
  submoduleCredentials?: { host: string; token: string }[];
  /**
   * Directory name, for a secondary checkout only. The caller sets it through
   * `secondaryRepoDirNames`; nothing derives it here. `TASK_ADD_REPO` names the
   * same repo mid-run and a pod re-provision names it again, and two rules
   * would move a checkout across a restart, breaking the paths the agent had
   * been using.
   */
  directoryName?: string;
}

export interface EnsureOptions {
  /**
   * Defaults to `interactive` when absent. AgentSandboxProvider uses this to
   * decide the SandboxTemplate (memory ceiling) and the warm pool, so it has
   * to survive into the persisted opts a resurrected claim is rebuilt from.
   */
  purpose?: SandboxPurpose;
  /**
   * The synthetic isolation key, recorded as the claim's `git-branch`
   * ANNOTATION for operators reading `kubectl get sandboxclaim -o yaml`.
   *
   * NOT an identity input — the handle derives its slug and its hash from
   * `projectRef` alone (see `computeHandle`). Setting this wrong costs you a
   * misleading annotation, nothing more. It used to feed the handle's slug,
   * which is how a caller passing the derived git ref here instead of the
   * synthetic key got a second claim for one sandbox.
   *
   * Prefer it over `repo.branch` for the annotation: `repo.branch` is the real
   * git ref the daemon checks out, which for thread-scoped work is the derived
   * `sandbox/thread-*` name rather than the isolation key.
   */
  branch?: string;
  /**
   * Optional first-provisioning clone. `branch` post-clone:
   * fetch-from-origin-or-create.
   */
  repo?: EnsureRepo;
  /**
   * Extra repositories to check out beside `repo`, for an org whose work spans
   * several. Each needs a `displayName` — it names the directory. Ignored when
   * `repo` is absent: there is no primary to sit beside.
   */
  extraRepos?: EnsureRepo[];
  /** Sandbox image override. */
  image?: string;
  workload?: Workload;
  /**
   * Prepare the checkout only — no dependency install, no dev server. Must be
   * explicit and travel to the daemon: omitting `workload` is NOT enough,
   * because the daemon autodetects a package manager from the lockfile when the
   * config names none, and then installs.
   */
  cloneOnly?: boolean;
  /** Frozen for the sandbox's lifetime — changing requires recreate. */
  env?: Record<string, string>;
  /**
   * Tenant identity for cost attribution, surfaced as platform-native metadata
   * (k8s pod labels) so
   * downstream metrics pipelines can attribute resource usage to the owning
   * org/user. Optional — callers without an org context (smoke tests, internal
   * tool sandboxes) leave it unset and pods get only platform-level labels.
   *
   * `orgId`/`userId` are the stable IDs surfaced as k8s labels (label values
   * are charset-restricted, so UUIDs only). The remaining fields are
   * human-readable identity surfaced as k8s *annotations* (no charset limit) so
   * `kubectl describe sandboxclaim` and dashboards can show who owns a sandbox
   * without a join back to the DB. All optional — absent values are omitted.
   */
  tenant?: {
    orgId: string;
    userId: string;
    orgSlug?: string;
    orgName?: string;
    userEmail?: string;
    userName?: string;
  };
  /**
   * org-fs mount config (a JSON `OrgFsMountConfig`) relayed to the hosted
   * daemon so its privileged sidecar mounts the configured volumes. Absent
   * means no org-fs mount.
   */
  orgFsConfigJson?: string;
}

export interface ProxyRequestInit {
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal?: AbortSignal;
}

/**
 * How the infrastructure — not the daemon — saw a sandbox stop. An OOM kill is
 * the case that only exists here: the kernel SIGKILLs the process at the cgroup
 * limit, so the dying sandbox reports nothing and Studio just sees the stream
 * break.
 */
export interface PodTermination {
  /** k8s `terminated.reason`, e.g. `OOMKilled`, `Error`, `Completed`. */
  reason: string;
  oomKilled: boolean;
  exitCode?: number;
  /** The limit that was hit, as k8s spells it (`4Gi`). */
  memoryLimit?: string;
}

export function sandboxIdKey(id: SandboxId): string {
  return `${id.userId}:${id.projectRef}`;
}
