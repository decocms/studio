/**
 * Runner-agnostic interface. Callers never branch on kind; runner-specific
 * features (local-ingress ports, Docker volumes) live on concrete classes.
 */

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
   * pick a free port (host runner: avoids collisions across co-tenant
   * sandboxes; container runners: fall back to their own default).
   */
  devPort?: number;
  /** Subdirectory inside the repo where the package manager manifest lives (e.g. `apps/web`). */
  packageManagerPath?: string;
}

export interface EnsureOptions {
  /**
   * Optional first-provisioning clone. Runners without clone support MUST
   * ignore (not error). `branch` post-clone: fetch-from-origin-or-create.
   */
  repo?: {
    /**
     * Clone URL. May embed an OAuth credential via userinfo (e.g.
     * `https://x-access-token:TOKEN@github.com/...`) — `git clone` stores
     * the credential on the remote so subsequent fetch/pull/push from
     * inside the sandbox work without further plumbing. The token is
     * frozen for the lifetime of the sandbox: to refresh, destroy and
     * recreate.
     */
    cloneUrl: string;
    userName: string;
    userEmail: string;
    branch?: string;
    /** Human-readable label for logs/UI; no functional effect. */
    displayName?: string;
  };
  /** Image override. Non-image runners (Freestyle) MUST ignore. */
  image?: string;
  workload?: Workload;
  /** Frozen for the sandbox's lifetime — changing requires recreate. */
  env?: Record<string, string>;
  /**
   * Tenant identity for cost attribution. Runners MAY surface these as
   * platform-native metadata (k8s pod labels, Docker container labels) so
   * downstream metrics pipelines can attribute resource usage to the owning
   * org/user. Optional — callers without an org context (smoke tests, internal
   * tool sandboxes) leave it unset and pods get only platform-level labels.
   */
  tenant?: {
    orgId: string;
    userId: string;
  };
}

export interface ExecInput {
  command: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ProxyRequestInit {
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal?: AbortSignal;
}

/**
 * Persisted on `vmMap` and `sandbox_runner_state.runner_kind`. When widening,
 * keep `VmMapEntry.runnerKind` in sync.
 */
export type RunnerKind = "host" | "docker" | "freestyle" | "agent-sandbox";

export interface SandboxRunner {
  readonly kind: RunnerKind;

  ensure(id: SandboxId, opts?: EnsureOptions): Promise<Sandbox>;
  exec(handle: string, input: ExecInput): Promise<ExecOutput>;
  delete(handle: string): Promise<void>;
  alive(handle: string): Promise<boolean>;

  /** Null when no workload was requested or the sandbox isn't running. */
  getPreviewUrl(handle: string): Promise<string | null>;

  /**
   * Passthrough to the daemon control plane. Path is daemon-internal; runners
   * translate (Docker prepends `/_daemon`, Freestyle base64-encodes for CF WAF).
   * Bearer tokens stay inside the runner.
   */
  proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response>;

  /**
   * Stream of phase transitions for the pre-Ready lifecycle. Used by mesh's
   * unified `/api/vm-events` SSE so the UI can show meaningful progress
   * between VM_START and the daemon SSE coming online.
   *
   * agent-sandbox is the interesting case: K8s scheduling, image pulls, and
   * node provisioning can each take many seconds, and surfacing them
   * granularly turns a black hole into a progress bar. The other runners
   * have no equivalent black hole — once VM_START's `runner.ensure` returns,
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
