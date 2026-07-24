/**
 * Runner-agnostic interface. Callers never branch on kind; runner-specific
 * features (e.g. local-ingress ports) live on concrete classes.
 */

import { z } from "zod";
import type { ClaimPhase } from "./lifecycle-types";

export interface SandboxId {
  userId: string;
  /** Opaque routing key; compose via `composeSandboxRef()`. */
  projectRef: string;
}

/** Opaque handle; transport (HTTP/kube-exec/ssh) stays inside the runner. */
export interface Sandbox {
  handle: string;
  workdir: string;
  /**
   * Same as `runner.getPreviewUrl(handle)`, returned eagerly. Non-null as
   * long as the sandbox exists — the iframe may still show a connection
   * error if the dev server inside never binds (e.g. repo has no `dev`/
   * `start` script), which is what the UI's booting/ready state tracks.
   */
  previewUrl: string | null;
}

/** When omitted, no dev server is started; runner uses its default image (tool sandboxes). */
export interface Workload {
  runtime: "node" | "bun" | "deno";
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "deno";
  /**
   * User-pinned dev port. Omit when the user hasn't chosen one — runners
   * pick a free port (user-desktop: avoids collisions across co-tenant
   * sandboxes sharing the user's host network; cluster: falls back to its
   * own default).
   */
  devPort?: number;
  /** Subdirectory inside the repo where the package manager manifest lives (e.g. `apps/web`). */
  packageManagerPath?: string;
  /**
   * Live production URL of the linked site (from `metadata.productionUrl`).
   * Forwarded to the daemon so the `/_deco/fast-preview` route can render the
   * working-tree decofile against production without the dev server.
   */
  productionUrl?: string;
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
   * Optional first-provisioning clone. Runners without clone support MUST
   * ignore (not error). `branch` post-clone: fetch-from-origin-or-create.
   */
  repo?: {
    /**
     * Clone URL. May embed an OAuth credential via userinfo (e.g.
     * `https://x-access-token:TOKEN@github.com/...`) — `git clone` stores
     * the credential on the remote so subsequent fetch/pull/push from
     * inside the sandbox work without further plumbing. The embedded token
     * is short-lived (~1h GitHub App token); callers should pass a freshly
     * minted URL on every ensure. Runners that reuse a running pod
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
  /** Image override. Non-image runners MUST ignore. */
  image?: string;
  workload?: Workload;
  /** Frozen for the sandbox's lifetime — changing requires recreate. */
  env?: Record<string, string>;
  /**
   * Tenant identity for cost attribution. Runners MAY surface these as
   * platform-native metadata (k8s pod labels) so
   * downstream metrics pipelines can attribute resource usage to the owning
   * org/user. Optional — callers without an org context (smoke tests, internal
   * tool sandboxes) leave it unset and pods get only platform-level labels.
   *
   * `orgId`/`userId` are the stable IDs surfaced as k8s labels (label values
   * are charset-restricted, so UUIDs only). The remaining fields are
   * human-readable identity surfaced as k8s *annotations* (no charset limit) so
   * `kubectl describe sandboxclaim` and dashboards can show who owns a sandbox
   * without a join back to the DB. All optional — runners drop any that are
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
   * Message-offload SSRF allowlist for the spawned daemon. When the cluster
   * offloads an oversized dispatch body to object storage, the daemon
   * re-inflates it by fetching a presigned URL — but ONLY if the URL's host is
   * in this allowlist. The cluster derives these from its OWN trusted S3 config
   * and pushes them down at spawn so the daemon can fail closed by default
   * (empty allowlist = every offload fetch rejected). NEVER sourced from a
   * request frame — that is the SSRF guarantee.
   *
   * Only the `user-desktop` runner consumes these (it spawns the daemon with
   * the matching env). Other runners MUST ignore them (the cluster daemon
   * shares the cluster's network and reads its own S3 env directly).
   */
  offloadAllowedHosts?: string[];
  /** Permit http:// loopback offload refs (dev MinIO). false in production. */
  offloadAllowSameHostDev?: boolean;
  /**
   * org-fs mount config (a JSON `OrgFsMountConfig`) for the spawned daemon, set
   * as its `ORGFS_CONFIG` boot env so it mounts the configured volumes
   * kext-free. Only the `user-desktop` runner consumes it (hosted pods can't
   * mount — that's the privileged-sidecar path). Absent → no mounting.
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
 * Persisted on `sandboxMap` and `sandbox_runner_state.sandbox_provider_kind`.
 * When widening, keep `SandboxRecord.sandboxProviderKind` in sync.
 */
export const sandboxProviderKindSchema = z.enum([
  "agent-sandbox",
  "user-desktop",
]);

export type SandboxProviderKind = z.infer<typeof sandboxProviderKindSchema>;

export type LegacySandboxProviderKind = SandboxProviderKind | "cluster";

export function normalizeSandboxProviderKind(
  kind: LegacySandboxProviderKind,
): SandboxProviderKind {
  return kind === "cluster" ? "agent-sandbox" : kind;
}

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;

  ensure(id: SandboxId, opts?: EnsureOptions): Promise<Sandbox>;
  delete(handle: string): Promise<void>;
  alive(handle: string): Promise<boolean>;

  /**
   * Drop this provider's in-process cache + persistent state for `handle`
   * WITHOUT contacting the daemon. Used by the auto-restart path when the
   * daemon is known-dead — `delete()` would try to reach the link and
   * either fail or be wasteful. Optional: callers must `?.()`. Providers
   * that don't keep a per-instance cache (or where the state store is
   * the sole source of truth) can omit.
   */
  forgetHandle?(handle: string): Promise<void>;

  /** Null when no workload was requested or the sandbox isn't running. */
  getPreviewUrl(handle: string): Promise<string | null>;

  /**
   * Passthrough to the daemon control plane. Path is daemon-internal; each
   * provider translates it to its own daemon transport. Bearer tokens stay
   * inside the provider.
   */
  proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response>;

  /**
   * Repopulate in-process routing state from a claim that already exists in
   * the cluster (preview gateway traffic can outlive studio's records cache).
   * Optional — only agent-sandbox implements this today.
   */
  adoptLiveClaim?(id: SandboxId, handle: string): Promise<boolean>;

  /**
   * Stream of phase transitions for the pre-Ready lifecycle. Used by studio's
   * unified `/api/vm-events` SSE so the UI can show meaningful progress
   * between SANDBOX_START and the daemon SSE coming online.
   *
   * agent-sandbox is the interesting case: K8s scheduling, image pulls, and
   * node provisioning can each take many seconds, and surfacing them
   * granularly turns a black hole into a progress bar. The other providers
   * have no equivalent black hole — once SANDBOX_START's `provider.ensure` returns,
   * the daemon's HTTP server is already up — so they yield a single `ready`
   * phase and end the stream immediately.
   *
   * Generator closes on a terminal phase (`ready` / `failed`) or on
   * `signal.abort()`.
   */
  watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown>;
}

export function sandboxIdKey(id: SandboxId): string {
  return `${id.userId}:${id.projectRef}`;
}
