/** Hosted AgentSandbox contracts. */

export interface SandboxId {
  userId: string;
  /** Opaque routing key; compose via `composeSandboxRef()`. */
  projectRef: string;
}

/** Opaque handle; cluster transport stays inside the provider. */
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

/** When omitted, no dev server is started; the provider uses its default image. */
export interface Workload {
  runtime: "node" | "bun" | "deno";
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "deno";
  /**
   * User-pinned dev port. Omit when the user hasn't chosen one and the
   * AgentSandbox daemon uses its default.
   */
  devPort?: number;
  /** Subdirectory inside the repo where the package manager manifest lives (e.g. `apps/web`). */
  packageManagerPath?: string;
}

export interface EnsureOptions {
  /**
   * Branch slug for handle composition. The sandbox proxy
   * (`apps/api/src/api/routes/sandbox-proxy.ts`) ALWAYS derives the claim
   * handle from the URL-path branch, so the runner MUST agree or every
   * proxy call 404s with `unknown handle`. Callers that also drive the
   * proxy (i.e. SANDBOX_START / ensureSandbox) MUST pass this; `repo.branch`
   * remains as a fallback only because legacy/test callers without a proxy
   * surface still use it. When both are set, this top-level field wins.
   */
  branch?: string;
  /**
   * Optional first-provisioning clone. `branch` post-clone:
   * fetch-from-origin-or-create.
   */
  repo?: {
    /**
     * Clone URL. May embed an OAuth credential via userinfo (e.g.
     * `https://x-access-token:TOKEN@github.com/...`) — `git clone` stores
     * the credential on the remote so subsequent fetch/pull/push from
     * inside the sandbox work without further plumbing. The embedded token
     * is short-lived (~1h GitHub App token); callers should pass a freshly
     * minted URL on every ensure. Resumed or adopted pods
     * (resume/adopt) forward the new credential to the daemon so it rotates
     * `origin` in place rather than leaving a stale token.
     */
    cloneUrl: string;
    /**
     * GitHub connection backing `cloneUrl`. Persisted so the runner can
     * re-mint a fresh credential on autonomous recovery (pod recreation
     * under a live claim) instead of replaying the stale token baked into
     * `cloneUrl` at first provision. Absent for anonymous/public clones.
     */
    connectionId?: string;
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
  };
  /** AgentSandbox image override. */
  image?: string;
  workload?: Workload;
  /** Frozen for the sandbox's lifetime — changing requires recreate. */
  env?: Record<string, string>;
  /**
   * Tenant identity for cost attribution. The provider surfaces these as
   * platform-native metadata (k8s pod labels) so
   * downstream metrics pipelines can attribute resource usage to the owning
   * org/user. Optional — callers without an org context (smoke tests, internal
   * tool sandboxes) leave it unset and pods get only platform-level labels.
   *
   * `orgId`/`userId` are the stable IDs surfaced as k8s labels (label values
   * are charset-restricted, so UUIDs only). The remaining fields are
   * human-readable identity surfaced as k8s *annotations* (no charset limit) so
   * `kubectl describe sandboxclaim` and dashboards can show who owns a sandbox
   * without a join back to the DB. All optional — the provider drops any that are
   * absent.
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
   * org-fs mount config (a JSON `OrgFsMountConfig`) passed to the hosted
   * AgentSandbox daemon. The pod's privileged sidecar performs the mounts.
   * Absent means no org-fs mounts.
   */
  orgFsConfigJson?: string;
}

export interface ProxyRequestInit {
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal?: AbortSignal;
}

export function sandboxIdKey(id: SandboxId): string {
  return `${id.userId}:${id.projectRef}`;
}
