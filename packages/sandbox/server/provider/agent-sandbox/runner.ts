/**
 * Agent-sandbox runner.
 *
 * Provisions one SandboxClaim per (user, projectRef) against the
 * kubernetes-sigs/agent-sandbox operator. Studio runs outside the cluster
 * (Stage 1 / local-dev via kind), so traffic reaches the pod via a single
 * lazily-opened 127.0.0.1 TCP listener that tunnels each inbound connection
 * to the daemon container port through the apiserver as a fresh WebSocket.
 *
 * The daemon owns the public surface: it serves `/_sandbox/*` + `/health`
 * in-process and reverse-proxies everything else to in-pod localhost:DEV_PORT
 * (CSP/X-Frame stripping + HMR bootstrap injection live in that proxy). One
 * port-forward per pod is therefore enough; opening a second forwarder for
 * the dev port would bypass the daemon and break SSE + iframe embedding.
 *
 * Stage 3 replaces the port-forward path with real ingress: when
 * `previewUrlPattern` is set, no forwarder is opened for preview traffic and
 * the preview URL is synthesized from the handle.
 *
 * Token model: each claim carries a freshly-generated DAEMON_TOKEN injected
 * via `SandboxClaim.spec.env`. One leak compromises one sandbox.
 * `valueFrom.secretKeyRef` isn't supported on SandboxClaim env; RBAC on
 * the namespace is the secrecy boundary.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { sleep } from "@decocms/shared/std";
import {
  type KubeConfig,
  KubeConfig as KubeConfigClass,
  PortForward,
} from "@kubernetes/client-node";
import type {
  Counter,
  Histogram,
  Meter,
  UpDownCounter,
} from "@opentelemetry/api";
import {
  ConfigRequestError,
  postConfig,
  postOrgFsConfig,
  probeDaemonHealth,
  proxyDaemonRequest,
  waitForDaemonReady,
} from "../../daemon-client";
import {
  Inflight,
  applyPreviewPattern,
  buildConfigPayload,
  computeHandle as composeBranchHandle,
  gitCredentialRefreshPatch,
  withSandboxLock,
} from "../shared";
import type { RunnerStateStore, RunnerStateStoreOps } from "../state-store";
import type {
  EnsureOptions,
  ProxyRequestInit,
  Sandbox,
  SandboxDaemonImpl,
  SandboxId,
  SandboxProvider,
  Workload,
} from "../types";
import {
  applyHttpRoute,
  createSandboxClaim,
  deleteHttpRoute,
  deleteSandboxClaim,
  ensureServicePort,
  getSandboxClaim,
  HTTPROUTE_CONSTANTS,
  patchSandboxClaimShutdown,
  waitForClaimAdoptedSandbox,
  waitForSandboxClaimGone,
  waitForSandboxReady,
  type HttpRoute,
  type SandboxClaim,
  type SandboxResource,
} from "./client";
import {
  K8S_CONSTANTS,
  SandboxAlreadyExistsError,
  SandboxError,
} from "./constants";
import { watchClaimDeletions, watchClaimLifecycle } from "./lifecycle-watcher";
import { refreshCredentialsByConnection } from "./credential-refresh";
import type { ClaimPhase } from "../lifecycle-types";

const RUNNER_KIND = "agent-sandbox" as const;
const LOG_LABEL = "AgentSandboxProvider";

/**
 * Readable message from an unknown throwable. The k8s client's port-forward
 * rejects with a WebSocket `ErrorEvent` (not an `Error`), which `String(err)`
 * renders as the useless `[object ErrorEvent]`; pull `.error.message`/`.message`
 * off it instead.
 */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { error?: unknown; message?: unknown };
    if (e.error instanceof Error) return e.error.message;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return String(err);
}

/**
 * Response-header marker on the preview-proxy's "sandbox not ready" envelopes
 * (404 "sandbox not found" in dev, 502 "sandbox daemon unreachable" in prod).
 * The Studio edge (`apps/api/src/sandbox/preview-proxy.ts`) swaps these for an
 * auto-reloading "connecting" page on top-level document navigations.
 */
export const PREVIEW_NOT_READY_HEADER = "x-sandbox-preview-not-ready";

// Shared-namespace topology for MVP; tenancy enforced by unguessable claim
// names (sha256(userId:projectRef)). Per-org namespaces are deferred.
const DEFAULT_NAMESPACE = "agent-sandbox-system";
const DEFAULT_TEMPLATE_NAME = "studio-sandbox";

const DAEMON_CONTAINER_PORT = 9000;
// In-pod port the daemon's reverse proxy targets. Studio never connects here
// directly — everything funnels through the daemon container port — but the
// value is propagated to the daemon via DEV_PORT so it knows where the dev
// server will bind.
const DEFAULT_DEV_PORT = 3000;
const DEFAULT_WORKDIR = "/app";

// 32 bytes matches Docker's generation so audit logs don't vary by runner.
const DAEMON_TOKEN_BYTES = 32;

/**
 * Env keys studio owns and a caller's `opts.env` MUST NOT shadow. DAEMON_TOKEN
 * is the secrecy boundary; the rest configure the daemon's bootstrap (paths
 * + ports) — silently overriding any of them would break daemon startup.
 *
 * Workload (clone URL, branch, package manager, runtime, intent, dev port)
 * is no longer env-injected: it's POSTed to `/_sandbox/config` after
 * the daemon comes up healthy. See `buildConfigPayload`.
 */
const RESERVED_ENV_KEYS = new Set([
  "DAEMON_TOKEN",
  "DAEMON_BOOT_ID",
  "APP_ROOT",
  "PROXY_PORT",
]);

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

// Periodic git-credential refresh for long-lived sandboxes. The clone token
// expires ~55min after it's minted; a pod that stays alive that long with no
// recovery event would otherwise push with a dead credential on shutdown and
// lose the user's work. The sweep re-mints well before expiry: a token entering
// the BUFFER window is re-minted within one INTERVAL, so the daemon's origin
// token always keeps ≥ ~(BUFFER - INTERVAL) of life — never near the ~55min
// expiry at an unpredictable SIGTERM. Requires BUFFER > INTERVAL.
const CREDENTIAL_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CREDENTIAL_REFRESH_BUFFER_MS = 30 * 60 * 1000;

/**
 * Handle shape: `<slug>-<hash5>` when a branch is supplied, `<hash5>`
 * otherwise — the shared default from `composeBranchHandle` (re-exported
 * as `computeHandle`). With
 * slug(≤24) + 1 + hash(5) = 30 chars max — well under K8s's 63-char DNS
 * label cap.
 */

/**
 * Headers stripped before re-issuing the preview proxy fetch. Hop-by-hop per
 * RFC 7230 + cookies (preview is per-handle, not per-user — no callee session
 * leak) + accept-encoding (Bun fetch auto-decompresses, so a downstream
 * content-encoding would mismatch the actual body).
 */
const PREVIEW_STRIP_REQUEST_HEADERS = [
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "accept-encoding",
  "content-length",
  "upgrade",
];

/**
 * Stripped from the proxied response. content-encoding/length would mismatch
 * after Bun fetch auto-decompresses; CSP/X-Frame-Options the daemon already
 * rewrote — re-passing them defeats the iframe-embedding fix the daemon
 * installed.
 */
const PREVIEW_STRIP_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
];

// Deterministic local-port range for port-forward listeners. Same
// (handle, containerPort) pair → same host port across studio restarts, so
// `previewUrl` cached in the thread's sandboxMap stays valid when the studio
// process recycles. Birthday-collision probability stays <1% up to ~140
// concurrent forwarders. EADDRINUSE walks the range forward until bind.
const PORT_RANGE_START = 40000;
const PORT_RANGE_SIZE = 10000;
const PORT_WALK_LIMIT = 256;

// Structural type for the WebSocket returned by PortForward.portForward — we
// only need close/on to manage lifecycle; a direct `isomorphic-ws` dep for
// one type isn't worth it.
interface ForwardWebSocket {
  close: () => void;
  on: (event: "close" | "error", handler: () => void) => void;
}

interface PortForwarder {
  server: net.Server;
  localPort: number;
}

interface RunnerTenant {
  orgId: string;
  userId: string;
  orgSlug?: string;
  orgName?: string;
  userEmail?: string;
  userName?: string;
}

interface K8sRecord {
  id: SandboxId;
  handle: string;
  /**
   * The Sandbox CR the operator actually bound to this claim, taken from
   * `claim.status.sandbox.name`. Equals `handle` on cold-start (operator
   * names cold Sandboxes after the claim) but diverges on warm-pool
   * adoption — pool sandboxes carry their generated names like
   * `studio-sandbox-kind-abcde`. Studio routes preview traffic via the
   * Service named after this (the operator-managed Service that targets
   * the *actually-bound* pod), not via the same-named cold-path
   * duplicate the v0.4.x adoption race occasionally leaves behind.
   * In agent-sandbox the pod name always matches this (the operator names
   * the Pod after the Sandbox CR), so this doubles as the port-forward target.
   */
  adoptedSandboxName: string;
  token: string;
  workdir: string;
  daemonUrl: string;
  daemonForward: PortForwarder;
  workload: Workload | null;
  /**
   * Per-boot UUID the daemon reports on /health. Generated studio-side and
   * injected via env; re-read from /health on rehydrate so we pick up
   * pod restarts (the daemon's orchestrator handles resume-on-restart
   * itself, this is purely informational on the studio side).
   */
  daemonBootId: string;
  /**
   * Tenant identity carried through for metric attribution on subsequent
   * operations (proxy, exec, delete) where the caller only has a handle.
   * Null when ensure() was called without tenant context (smoke tests,
   * adopt fallback when claim labels were absent).
   */
  tenant: RunnerTenant | null;
  /**
   * The original options the caller passed to `ensure()`. Persisted so
   * `resurrectByHandle` can re-provision an evicted sandbox autonomously
   * (15-min idle TTL deletes the claim — without these we'd come back as
   * an empty pod with no repo cloned). Null on adopt paths where we can't
   * recover the original opts; resurrection falls back to throwing/404 in
   * that case so the caller's normal SANDBOX_START flow can repopulate them.
   */
  ensureOpts: EnsureOptions | null;
  /**
   * Which daemon binary this sandbox's pod is actually running — the metric
   * dimension the Go rollout is compared on. Distinct from
   * `ensureOpts.daemonImpl` (what the caller *asked* for, which the kill
   * switch can collapse) and resolvable on paths that have no `ensureOpts` at
   * all: adopt recovers it from the claim label, which is the cluster-side
   * source of truth. Null only when neither is available — reported as an
   * empty attribute rather than defaulting to `ts`, so a Go sandbox can never
   * be silently counted as a TS one.
   */
  daemonImpl: SandboxDaemonImpl | null;
}

interface PersistedK8sState {
  adoptedSandboxName: string;
  /** @deprecated back-compat with rows written before warm-pool support. */
  podName?: string;
  token: string;
  workdir: string;
  workload?: Workload | null;
  daemonBootId?: string;
  tenant?: RunnerTenant | null;
  /**
   * Original `EnsureOptions`. Persisted so `resurrectByHandle` can re-ensure
   * after the operator deletes the claim on idle TTL. Optional for
   * back-compat: rows written before this field existed lack it; resurrection
   * returns null in that case and the caller surfaces 404 (UI's existing
   * SANDBOX_START reprovision flow then runs with full opts).
   */
  ensureOpts?: EnsureOptions;
  [k: string]: unknown;
}

export interface AgentSandboxProviderOptions {
  stateStore?: RunnerStateStore;
  previewUrlPattern?: string;
  /** Defaults to `new KubeConfig().loadFromDefault()`. Tests pass a stub. */
  kubeConfig?: KubeConfig;
  /** Shared namespace for both SandboxTemplate and SandboxClaims. */
  namespace?: string;
  /** SandboxTemplate all claims reference. */
  sandboxTemplateName?: string;
  /**
   * SandboxTemplate for claims that asked for `daemonImpl: "go"` — the chart's
   * opt-in `<name>-go` twin, identical except `SANDBOX_DAEMON_IMPL=go`.
   *
   * This is the **global kill switch**: leave it unset and `daemonImpl` is
   * ignored everywhere, because there is nothing to point a claim at. That is
   * also why the choice can't be per-claim env — the operator rejects
   * `spec.env` whenever the claim may bind a warm pod, and the entrypoint
   * reads `SANDBOX_DAEMON_IMPL` at container start, before Studio can talk to
   * the daemon at all.
   */
  goSandboxTemplateName?: string;
  /**
   * Shared sentinel token baked into the SandboxTemplate's pod env (via the
   * sandbox-env helm chart's Secret). Presence flips the runner into
   * warm-pool mode:
   *   - claims are created with `warmpool: "default"` and `spec.env: []`
   *     (the operator rejects per-claim env when warmpool != "none"),
   *   - studio's first contact with the daemon authenticates with the
   *     sentinel and rotates to a per-claim token via
   *     `auth.rotateToken` on POST /_sandbox/config,
   *   - subsequent calls use the per-claim token (persisted in
   *     RunnerStateStore.state.token).
   *
   * When undefined, the runner falls back to env-injected per-claim tokens
   * with `warmpool: "none"` — the legacy cold-start path. Useful for
   * deployments that haven't (yet) adopted the chart's sentinel Secret.
   *
   * Trust window: between pod boot and the first rotation call, the
   * sentinel is the only auth on the daemon. NetworkPolicy is the
   * secrecy boundary in that window — same boundary that gates every
   * other studio→daemon request.
   */
  sentinelToken?: string;
  /**
   * Studio environment name. When set, stamped as
   * `studio.decocms.com/env=<envName>` on claims/pods/HTTPRoutes so the
   * sandbox-env housekeeper can scope per-env. Must be DNS-label-safe;
   * validated at construction.
   */
  envName?: string;
  /**
   * Deterministic DAEMON_TOKEN override — tests inject a fixed value so
   * recorded fetch payloads are stable. Prod leaves this undefined.
   */
  tokenGenerator?: () => string;
  /**
   * Idle-reap window (ms). Every `ensure()` hit pushes the claim's
   * `spec.lifecycle.shutdownTime` to `now + idleTtlMs`; the operator
   * deletes claim + pod when the wall clock passes that.
   */
  idleTtlMs?: number;
  /**
   * OpenTelemetry meter for runner-level metrics (active gauge, ensure
   * outcome counter, proxy duration histogram). Optional — when absent,
   * runner is fully functional but emits no metrics. Tests typically pass
   * undefined; Studio wires `metrics.getMeter("studio", "1.0.0")`.
   */
  meter?: Meter;
  /**
   * Per-claim HTTPRoute parent. When set together with `previewUrlPattern`,
   * the runner mints one HTTPRoute per SandboxClaim (same name + namespace
   * as the claim) and tears it down on `delete`. The route attaches to
   * `parentRef = { name, namespace }` and routes `<handle>.<host>` exact
   * matches to the operator-created Service:9000 in `this.namespace`.
   *
   * `namespace` is the gateway's namespace, NOT the route's — the route
   * always lives in `this.namespace` (same as the Service it backends).
   * Both `name` and `namespace` are required when this option is provided;
   * the runner makes no assumption about which gateway controller (Istio,
   * Envoy Gateway, Cilium, ...) is downstream and therefore can't pick a
   * default namespace.
   *
   * When unset (or `previewUrlPattern` unset), the runner does NOT touch
   * HTTPRoute resources. Preview traffic still works in that mode through
   * studio's in-process proxy (the previous design), provided someone else
   * (the chart, an operator, hand-rolled YAML) has wired a wildcard
   * HTTPRoute backed by studio.
   */
  previewGateway?: {
    name: string;
    namespace: string;
  };
  /**
   * Re-mint a fresh credentialed clone URL for a repo. The cloneUrl persisted
   * in `ensureOpts` embeds a ~55min GitHub App token from first provision; on
   * autonomous recovery (a warm-pool pod recreated under a live claim without a
   * new SANDBOX_START) that token has usually lapsed, so replaying it would
   * clone/push with a dead credential — the cause of "Invalid username or
   * token" on shutdown. The runner calls this before re-cloning / rotating
   * origin on recovery. Returns null when it can't re-mint (no connection,
   * legacy repo-scoped token needing an org-scoped context, mint error); the
   * runner then falls back to the persisted URL. Must never throw.
   *
   * `opts.bufferMs` asks the minter to refresh the token when it has less than
   * that many ms of life left — the periodic refresher passes a large value to
   * keep long-lived sandboxes ahead of the ~55min expiry; recovery omits it.
   */
  mintCloneUrl?: (
    repo: NonNullable<EnsureOptions["repo"]>,
    opts?: { bufferMs?: number },
  ) => Promise<string | null>;
}

export class AgentSandboxProvider implements SandboxProvider {
  readonly kind = RUNNER_KIND;

  private readonly records = new Map<string, K8sRecord>();
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly stateStore: RunnerStateStore | null;
  private readonly previewUrlPattern: string | null;
  private readonly kubeConfig: KubeConfig;
  private readonly portForward: PortForward;
  private readonly namespace: string;
  private readonly sandboxTemplateName: string;
  /** See {@link AgentSandboxProviderOptions.goSandboxTemplateName}. */
  private readonly goSandboxTemplateName: string | null;
  private readonly envName: string | null;
  private readonly tokenGenerator: () => string;
  private readonly idleTtlMs: number;
  /**
   * Instruments are null when no meter was provided. All emit-paths must
   * null-check; the alternative — passing the OTel API's no-op meter — would
   * still allocate and dispatch on every call.
   */
  private readonly metrics: RunnerMetrics | null;
  /**
   * Non-null only when both `previewUrlPattern` and `previewGateway` were
   * provided — the two together define the full route shape (hostname +
   * parent). Used as the gate for HTTPRoute mutations across provision,
   * adopt, and delete.
   */
  private readonly previewGateway: { name: string; namespace: string } | null;
  /**
   * Non-null = warm-pool mode (see `AgentSandboxProviderOptions.sentinelToken`).
   * Treated as the bearer token for the *first* daemon contact only;
   * studio rotates to a per-claim token via `auth.rotateToken` immediately
   * after, and persists the new token. Empty/whitespace strings are
   * collapsed to null at construction so a misconfigured env var doesn't
   * silently flip modes with an unusable token.
   */
  private readonly sentinelToken: string | null;
  /** See {@link AgentSandboxProviderOptions.mintCloneUrl}. */
  private readonly mintCloneUrl: AgentSandboxProviderOptions["mintCloneUrl"];
  private closed = false;
  /** Aborts the background SandboxClaim-deletion watch on `close()`. */
  private readonly claimWatchAbort = new AbortController();

  constructor(opts: AgentSandboxProviderOptions = {}) {
    this.stateStore = opts.stateStore ?? null;
    this.previewUrlPattern = opts.previewUrlPattern ?? null;
    this.kubeConfig = opts.kubeConfig ?? loadDefaultKubeConfig();
    this.portForward = new PortForward(this.kubeConfig);
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.sandboxTemplateName =
      opts.sandboxTemplateName ?? DEFAULT_TEMPLATE_NAME;
    const trimmedGoTemplate = opts.goSandboxTemplateName?.trim() ?? "";
    this.goSandboxTemplateName =
      trimmedGoTemplate.length > 0 ? trimmedGoTemplate : null;
    this.envName = normalizeEnvName(opts.envName);
    this.tokenGenerator =
      opts.tokenGenerator ??
      (() => randomBytes(DAEMON_TOKEN_BYTES).toString("hex"));
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.metrics = opts.meter ? buildRunnerMetrics(opts.meter) : null;
    // HTTPRoute routing requires both pieces — the hostname template (so we
    // know what host to attach) and the gateway parent (so we know where).
    // Either alone is meaningless, so refuse to half-enable.
    this.previewGateway =
      opts.previewGateway && opts.previewUrlPattern
        ? { ...opts.previewGateway }
        : null;
    const trimmedSentinel = opts.sentinelToken?.trim() ?? "";
    this.sentinelToken = trimmedSentinel.length > 0 ? trimmedSentinel : null;
    this.mintCloneUrl = opts.mintCloneUrl;
    this.startClaimReaper();
    this.startCredentialRefresher();
  }

  /**
   * Drops the cached record + closes its forwarder the moment the operator
   * reaps a claim (idle-TTL or explicit delete). Without this, a record for a
   * sandbox that's used once then abandoned lingers — with its listening
   * net.Server port-forwarder (an active libuv handle + FD that GC can't
   * reclaim) — until a later request to that exact handle happens to fail,
   * which on cache-bypassing prod hot-paths may never occur.
   */
  private startClaimReaper(): void {
    const labelSelector = [
      "app.kubernetes.io/managed-by=studio",
      "app.kubernetes.io/name=studio-sandbox",
      ...(this.envName ? [`${LABEL_KEYS.env}=${this.envName}`] : []),
    ].join(",");
    void watchClaimDeletions({
      kc: this.kubeConfig,
      namespace: this.namespace,
      labelSelector,
      signal: this.claimWatchAbort.signal,
      onDelete: (handle) => this.invalidateRecord(handle),
    });
  }

  // ---- SandboxProvider surface ------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // Branch is the slug source. Prefer the explicit top-level `opts.branch`
    // (which `sandbox-proxy.ts`'s `computeClaimHandle` also uses) over
    // `opts.repo?.branch` so a repo-less SANDBOX_START — i.e. a virtual MCP
    // with no GitHub connection — still composes the same handle the proxy
    // looks up. The fallback to bare-hash (`s-<hash>`) survives only for
    // legacy tool-only / smoke-test callers that drive `ensure` without
    // ever touching the sandbox-proxy.
    const handle = composeBranchHandle(
      id,
      opts.branch ?? opts.repo?.branch ?? null,
    );
    return this.inflight.run(handle, () =>
      withSandboxLock(this.stateStore, id, RUNNER_KIND, (ops) =>
        this.ensureLocked(id, handle, opts, ops),
      ),
    );
  }

  async delete(handle: string): Promise<void> {
    const rec = await this.getRecord(handle);
    this.records.delete(handle);
    if (rec) {
      this.closeForwarder(rec.daemonForward);
      // Decrement only when we actually held the record — getRecord can be
      // null after restart-without-state-store, in which case the gauge
      // was never incremented for this handle in this process.
      this.metrics?.active.add(-1, tenantAttrs(rec.tenant, rec.daemonImpl));
    }
    // Drop the HTTPRoute first so traffic stops resolving immediately —
    // the operator's claim teardown can take a few seconds, and we don't
    // want browsers landing on a half-deleted Service in the interim.
    // Failures here are logged and continue: a stale HTTPRoute backed by a
    // deleted Service simply 502s, and the next delete attempt (or a
    // garbage-collection sweep) will clean it up. Blocking claim deletion
    // on a transient gateway-API error would be worse for the caller.
    await this.deleteHttpRouteIfManaged(handle).catch((err) => {
      console.warn(
        `[${LOG_LABEL}] HTTPRoute delete failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await deleteSandboxClaim(this.kubeConfig, this.namespace, handle);
    if (this.stateStore) {
      if (rec) await this.stateStore.delete(rec.id, RUNNER_KIND);
      else await this.stateStore.deleteByHandle(RUNNER_KIND, handle);
    }
  }

  async alive(handle: string): Promise<boolean> {
    const claim = await getSandboxClaim(
      this.kubeConfig,
      this.namespace,
      handle,
    );
    return claim !== undefined;
  }

  /**
   * Stream of phase transitions for a SandboxClaim's pre-Ready lifecycle.
   * Used by studio's lifecycle SSE route to surface what's happening between
   * `SANDBOX_START` posting a claim and the daemon SSE coming online.
   *
   * Generator closes on terminal phase (`ready`/`failed`) or on
   * `signal.abort()`. Safe to call before the claim exists — the generator
   * stays in `claiming` until the operator creates the Sandbox/Pod.
   */
  watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    return watchClaimLifecycle({
      kc: this.kubeConfig,
      namespace: this.namespace,
      claimName: handle,
      signal,
    });
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.getRecord(handle);
    if (!rec) return null;
    return this.composePreviewUrl(rec);
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    let rec = await this.getRecord(handle);

    // rehydrate failed (port-forward is pod-local); route via in-cluster Service instead.
    if (!rec && this.previewUrlPattern && this.stateStore) {
      const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
      const state = row?.state as Partial<PersistedK8sState> | undefined;
      const token = state?.token;
      if (row && token) {
        const adoptedName = state?.adoptedSandboxName ?? handle;
        const daemonUrl = `http://${adoptedName}.${this.namespace}.svc.cluster.local:${DAEMON_CONTAINER_PORT}`;
        try {
          const resp = await proxyDaemonRequest(daemonUrl, token, path, init);
          if (resp.status !== 404) {
            return resp;
          }
          try {
            await resp.body?.cancel();
          } catch {
            /* ignore */
          }
        } catch {
          // Stale adoptedSandboxName after operator eviction — fall through
          // to resurrection, same as `proxyPreviewRequest`.
        }
      }
    }

    // Preview traffic can resurrect autonomously (gateway fetch retry) while
    // daemon/git/exec paths still hit a cold records map. `exec` already
    // routes through `requireRecord`; mirror that here so Save-changes/git
    // APIs don't 410 while the iframe preview is live. The operator may have
    // evicted the claim+pod (15-min idle TTL) since the record was cached.
    // resurrectByHandle returns null only for genuine not-found cases (no
    // state-store / no row / row predates ensureOpts) — those fall through to the
    // 404 below. A real ensure() failure (K8s/provisioning/bootstrap) THROWS and
    // must propagate: callers already treat a throw as unreachable, and swallowing
    // it would mislabel a backend failure as a false 404 "sandbox not found".
    if (!rec) {
      rec = await this.resurrectByHandle(handle);
    }

    if (!rec) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    let activeRec = rec;
    const start = performance.now();
    let status = 0;
    const canRetryBody = !(init.body instanceof ReadableStream);
    try {
      let resp = await proxyDaemonRequest(rec.daemonUrl, rec.token, path, init);
      // A 401 means the cached record is stale — the pool pod was recreated
      // and no longer holds our token. Drop it and re-resolve; rehydrate
      // re-bootstraps the fresh daemon. Then retry once. Retry only when the
      // body is re-sendable: of the BodyInit variants only a ReadableStream is
      // one-shot (consumed by the first fetch); strings, buffers,
      // URLSearchParams, FormData and Blobs are re-read from memory on retry.
      if (resp.status === 401 && canRetryBody) {
        this.invalidateRecord(handle);
        const fresh =
          (await this.getRecord(handle).catch(() => null)) ??
          (await this.resurrectByHandle(handle).catch(() => null));
        if (fresh) {
          activeRec = fresh;
          resp = await proxyDaemonRequest(
            fresh.daemonUrl,
            fresh.token,
            path,
            init,
          );
        }
      }
      status = resp.status;
      return resp;
    } catch (err) {
      // Stale port-forward / dead pod after idle eviction — same recovery
      // path as preview's fetch-retry arm.
      if (!canRetryBody) throw err;
      this.invalidateRecord(handle);
      const fresh =
        (await this.resurrectByHandle(handle)) ??
        (await this.getRecord(handle).catch(() => null));
      if (!fresh) throw err;
      activeRec = fresh;
      const resp = await proxyDaemonRequest(
        fresh.daemonUrl,
        fresh.token,
        path,
        init,
      );
      status = resp.status;
      return resp;
    } finally {
      this.recordProxyDuration(
        "daemon",
        status,
        activeRec,
        performance.now() - start,
      );
    }
  }

  /**
   * Repopulate studio's records cache from a SandboxClaim that already exists
   * in the cluster. Preview gateway traffic can keep serving while studio's
   * daemon/git proxy still holds a cold cache or missing state-store row.
   */
  async adoptLiveClaim(id: SandboxId, handle: string): Promise<boolean> {
    if (this.records.has(handle)) return true;
    const existing = await getSandboxClaim(
      this.kubeConfig,
      this.namespace,
      handle,
    ).catch(() => undefined);
    if (!existing || existing.metadata?.deletionTimestamp) return false;

    // The inflight map is keyed on handle and typed to return `Sandbox`, so a
    // concurrent ensure/adopt for the same handle dedupes onto one promise.
    // Throw (not return false) on failure so the callback stays `Sandbox`;
    // the catch below maps any failure back to `false`.
    const sandbox = await this.inflight
      .run(handle, async () => {
        const cached = this.records.get(handle);
        if (cached) return this.toSandbox(cached);
        const adopted = await this.adopt(id, handle, existing);
        if (!adopted) throw new Error(`cannot adopt live claim ${handle}`);
        return withSandboxLock(this.stateStore, id, RUNNER_KIND, (ops) =>
          this.finish(
            adopted,
            ops,
            /* persistNow */ true,
            /* patchTtl */ true,
            "adopt",
          ),
        );
      })
      .catch(() => null);

    return sandbox != null;
  }

  /**
   * Resolves the HTTP base URL for a sandbox's daemon. Used by the preview
   * reverse-proxy at the studio edge.
   *
   * Two modes:
   * 1. `previewUrlPattern` set (Stage 3 / in-cluster studio): synthesize the
   *    in-cluster Service URL straight from the handle. No record lookup, no
   *    port-forward, no health probe — the cluster DNS + downstream fetch
   *    are the source of truth. Crucially this means a cold studio pod (or one
   *    that just restarted with an empty records map) still serves preview
   *    traffic without first having to rehydrate every claim. If the Service
   *    doesn't exist for that handle, the downstream fetch fails and the
   *    caller surfaces a 502.
   * 2. `previewUrlPattern` unset (dev / studio-outside-cluster): fall back to
   *    the 127.0.0.1 port-forwarder opened by `getRecord`. Returns null when
   *    the record can't be found or rehydrated — the caller surfaces 404.
   *
   * Preview must always land on port 9000 (daemon) — never 3000 (dev server)
   * — because the daemon's reverse proxy strips CSP/X-Frame headers and
   * injects the HMR bootstrap script that vite needs to function inside the
   * studio iframe. Bypassing it breaks SSE + iframe embedding.
   */
  async resolvePreviewUpstreamUrl(handle: string): Promise<string | null> {
    if (this.previewUrlPattern) {
      // Production mode: synthesize the in-cluster Service URL. The Service
      // we target is the operator-managed one for the *adopted* Sandbox —
      // on warm-pool adoption this is the pool pod's Service (e.g.
      // `studio-sandbox-kind-abcde`), NOT the same-named cold-path
      // orphan the v0.4.x adoption race occasionally leaves alongside.
      // Records cache hit is O(1); cache miss (cold studio) falls through to
      // a single state-store row read, then to `handle` as a last resort.
      // We deliberately don't pre-validate that the claim is still alive
      // — every preview request would pay a K8s API call. When the
      // sandbox has been evicted, the downstream fetch fails and
      // `proxyPreviewRequest` catches it + drives resurrection from there.
      const serviceName = await this.resolveServiceNameForHandle(handle);
      return `http://${serviceName}.${this.namespace}.svc.cluster.local:${DAEMON_CONTAINER_PORT}`;
    }
    const rec = await this.getRecord(handle);
    if (rec) return rec.daemonUrl;
    // Dev mode: cold cache + state-store miss. Try resurrection before
    // surfacing 404 — the pod may have been operator-evicted on idle TTL
    // and the caller (preview iframe, SSE EventSource probe) needs the
    // sandbox back to make any progress.
    const resurrected = await this.resurrectByHandle(handle);
    return resurrected ? resurrected.daemonUrl : null;
  }

  /**
   * Resolve the operator-managed Service name we should route preview
   * traffic to for `handle`. See `resolvePreviewUpstreamUrl` and
   * `K8sRecord.adoptedSandboxName` for why this differs from the claim
   * name on warm-pool adoption.
   *
   * Cache layers, cheapest first: in-memory records map, then state-store
   * (one DB row), then a `handle` fallback. Falling back to `handle` is
   * wrong for a warm-pool sandbox (it points at the cold-path duplicate's
   * Service), but the only path that lands here is "studio just restarted
   * AND state-store doesn't have the row" — at which point the downstream
   * fetch will fail and `proxyPreviewRequest`'s catch arm runs the
   * resurrection flow, which repopulates records with the right name.
   */
  private async resolveServiceNameForHandle(handle: string): Promise<string> {
    const cached = this.records.get(handle);
    if (cached) return cached.adoptedSandboxName;
    if (this.stateStore) {
      const persisted = await this.stateStore
        .getByHandle(RUNNER_KIND, handle)
        .catch(() => null);
      const adoptedName = (
        persisted?.state as Partial<PersistedK8sState> | undefined
      )?.adoptedSandboxName;
      if (adoptedName) return adoptedName;
    }
    return handle;
  }

  /**
   * Reverse-proxies an inbound preview HTTP request to the sandbox's daemon.
   * Unauthenticated by design — preview URLs are open the same way Vercel
   * preview URLs are; the *handle* is the secret.
   *
   * `/_sandbox/*` access policy at the edge (legacy `/_decopilot_vm/*`
   * dual-served by the daemon is also matched here for the duration of
   * the rename rollout):
   *   - **GET** is allowed through. The daemon's `/events` SSE and `/scripts`
   *     are intentionally unauthenticated and CORS-enabled (`Allow-Origin: *`)
   *     because the studio UI consumes them cross-origin from the preview
   *     URL — that's the only path it has to live setup state. Stripping
   *     them here would break the studio UI's setup tab and SSE event feed.
   *   - **Non-GET** (POST/PUT/DELETE/etc) is rejected as defense-in-depth.
   *     The daemon enforces bearer auth on the mutating endpoints
   *     (read/write/edit/grep/glob/bash/exec/kill), but the only legitimate
   *     caller for those is studio itself via the internal port-forward; the
   *     preview surface should never see them.
   */
  async proxyPreviewRequest(
    handle: string,
    request: Request,
  ): Promise<Response> {
    const start = performance.now();
    // In-memory cache only — preview is the hot path; a state-store hit per
    // request would dominate latency. Tenant attribution is best-effort: when
    // the records map is cold (studio just restarted) the metric still records
    // duration with empty tenant attrs. cAdvisor on the pod side covers
    // bandwidth attribution authoritatively via pod labels.
    const cachedRec = this.records.get(handle) ?? null;
    let status = 0;
    try {
      const upstreamBase = await this.resolvePreviewUpstreamUrl(handle);
      if (!upstreamBase) {
        status = 404;
        const notReady = jsonResponse(404, { error: "sandbox not found" });
        notReady.headers.set(PREVIEW_NOT_READY_HEADER, "1");
        return notReady;
      }

      const reqUrl = new URL(request.url);
      const isAdminPath =
        reqUrl.pathname === "/_sandbox" ||
        reqUrl.pathname.startsWith("/_sandbox/") ||
        reqUrl.pathname === "/_decopilot_vm" ||
        reqUrl.pathname.startsWith("/_decopilot_vm/");
      if (isAdminPath && request.method !== "GET") {
        status = 404;
        return jsonResponse(404, { error: "not found" });
      }

      const reqTarget = (base: string) =>
        `${base}${reqUrl.pathname}${reqUrl.search}`;
      const headers = new Headers(request.headers);
      for (const h of PREVIEW_STRIP_REQUEST_HEADERS) headers.delete(h);

      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
        signal: request.signal,
        duplex: hasBody ? "half" : undefined,
      };

      let upstream: Response;
      try {
        upstream = await fetch(reqTarget(upstreamBase), init as RequestInit);
      } catch (err) {
        // Truncate to host+pathname — query strings can carry secrets
        // (magic-link tokens, signed URLs) and would otherwise end up in
        // studio stdout → kubectl logs → log aggregator.
        const safeTarget = `${upstreamBase}${reqUrl.pathname}`;
        console.warn(
          `[${LOG_LABEL}] preview fetch to ${safeTarget} failed: ${err instanceof Error ? err.message : String(err)}`,
        );

        // Recover from operator-driven eviction (15-min idle TTL): the
        // claim + Service are gone but our records cache (or the
        // synthesized prod-mode URL) still pointed at the stale endpoint.
        // Drop the cache and resurrect via state-store. Retry only for
        // replay-safe methods — `init.body` is a stream that's been
        // consumed by the failed fetch; replaying a POST would silently
        // send an empty body. The browser/caller can retry the mutating
        // request after this 502 surfaces; the resurrected sandbox will
        // be ready for that next attempt.
        if (request.method === "GET" || request.method === "HEAD") {
          this.invalidateRecord(handle);
          const resurrected = await this.resurrectByHandle(handle).catch(
            () => null,
          );
          if (resurrected) {
            const retryBase = await this.resolvePreviewUpstreamUrl(handle);
            if (retryBase) {
              try {
                upstream = await fetch(
                  reqTarget(retryBase),
                  init as RequestInit,
                );
                const responseHeaders = new Headers();
                for (const [k, v] of upstream.headers.entries()) {
                  if (
                    !PREVIEW_STRIP_RESPONSE_HEADERS.includes(k.toLowerCase())
                  ) {
                    responseHeaders.set(k, v);
                  }
                }
                status = upstream.status;
                return new Response(upstream.body, {
                  status: upstream.status,
                  statusText: upstream.statusText,
                  headers: responseHeaders,
                });
              } catch (retryErr) {
                console.warn(
                  `[${LOG_LABEL}] preview fetch retry to ${safeTarget} failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
                );
              }
            }
          }
        } else {
          // Non-replay-safe method: still drop the stale cache so the next
          // request goes through fresh validation.
          this.invalidateRecord(handle);
        }

        status = 502;
        const notReady502 = jsonResponse(502, {
          error: "sandbox daemon unreachable",
        });
        notReady502.headers.set(PREVIEW_NOT_READY_HEADER, "1");
        return notReady502;
      }

      const responseHeaders = new Headers();
      for (const [k, v] of upstream.headers.entries()) {
        if (!PREVIEW_STRIP_RESPONSE_HEADERS.includes(k.toLowerCase())) {
          responseHeaders.set(k, v);
        }
      }
      status = upstream.status;
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } finally {
      this.recordProxyDuration(
        "preview",
        status,
        cachedRec,
        performance.now() - start,
        handle,
      );
    }
  }

  // ---- Ensure flow ----------------------------------------------------------

  private async ensureLocked(
    id: SandboxId,
    handle: string,
    opts: EnsureOptions,
    ops: RunnerStateStoreOps | null,
  ): Promise<Sandbox> {
    if (opts.image) {
      console.warn(
        `[${LOG_LABEL}] opts.image ignored (template ${this.sandboxTemplateName} pins image): got ${opts.image}`,
      );
    }

    // 1. State-store resume.
    if (ops) {
      const persisted = await ops.get(id, RUNNER_KIND);
      if (persisted) {
        const rec = await this.rehydrate(id, handle, persisted);
        if (rec) {
          // Resume reuses the running pod, whose daemon still holds the clone
          // credential baked in at provision — a ~1h GitHub App token that has
          // likely expired. Forward the freshly-minted one so authenticated git
          // keeps working. No-op when unchanged / public clone.
          await this.refreshDaemonGitCredential(rec, opts);
          return this.finish(
            rec,
            ops,
            /* persistNow */ false,
            /* patchTtl */ true,
            "resume",
          );
        }
        await ops.delete(id, RUNNER_KIND);
      }
    }
    // 2. Cluster-side adopt: state store empty but a claim with our
    //    deterministic name already exists.
    const existing = await getSandboxClaim(
      this.kubeConfig,
      this.namespace,
      handle,
    ).catch(() => undefined);
    if (existing) {
      // Terminating claim (operator's idle-TTL fired, finalizers still
      // draining): skip adopt entirely — the pod is going away, port-forward
      // would fail, and the claim is on its way out. Wait for the API server
      // to fully GC the resource before falling through to provision so we
      // don't race into a 409 AlreadyExists.
      if (existing.metadata?.deletionTimestamp) {
        await waitForSandboxClaimGone(
          this.kubeConfig,
          this.namespace,
          handle,
        ).catch((err) => {
          console.warn(
            `[${LOG_LABEL}] wait for terminating claim ${handle} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } else {
        const adopted = await this.adopt(id, handle, existing).catch((err) => {
          console.warn(
            `[${LOG_LABEL}] adopt ${handle} failed, recreating: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        });
        if (adopted) {
          // Same as resume: the adopted pod's daemon holds a clone credential
          // from an earlier provision that may have lapsed. Rotate it.
          await this.refreshDaemonGitCredential(adopted, opts);
          return this.finish(
            adopted,
            ops,
            /* persistNow */ true,
            /* patchTtl */ true,
            "adopt",
          );
        }
        await deleteSandboxClaim(this.kubeConfig, this.namespace, handle).catch(
          () => {},
        );
        // Same wait as the terminating branch — our DELETE just queued a
        // teardown that still has to drain finalizers before the next
        // create won't 409.
        await waitForSandboxClaimGone(
          this.kubeConfig,
          this.namespace,
          handle,
        ).catch((err) => {
          console.warn(
            `[${LOG_LABEL}] wait for deleted claim ${handle} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }
    // 3. Fresh provision.
    const fresh = await this.provision(id, handle, opts);
    return this.finish(
      fresh,
      ops,
      /* persistNow */ true,
      /* patchTtl */ false,
      "fresh",
    );
  }

  private async finish(
    rec: K8sRecord,
    ops: RunnerStateStoreOps | null,
    persistNow: boolean,
    patchTtl: boolean,
    outcome: "fresh" | "resume" | "adopt",
  ): Promise<Sandbox> {
    const prev = this.records.get(rec.handle);
    const wasCached = prev !== undefined;
    if (prev && prev.daemonForward !== rec.daemonForward) {
      this.closeForwarder(prev.daemonForward);
    }
    this.records.set(rec.handle, rec);
    if (persistNow) await this.persist(ops, rec);
    // Fresh provision set a shutdownTime in the claim spec already; resumes
    // and adopts rely on this patch to stay alive.
    if (patchTtl) {
      await patchSandboxClaimShutdown(
        this.kubeConfig,
        this.namespace,
        rec.handle,
        this.computeShutdownTime(),
      ).catch((err) =>
        console.warn(
          `[${LOG_LABEL}] TTL refresh failed for ${rec.handle}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    if (this.metrics) {
      const attrs = tenantAttrs(rec.tenant, rec.daemonImpl);
      this.metrics.ensureOutcome.add(1, { ...attrs, outcome });
      // Only increment the active gauge on first observation to avoid
      // double-counting when the same handle is rehydrated multiple times
      // (studio-process internal cache hit; ensureLocked is invoked again).
      if (!wasCached) this.metrics.active.add(1, attrs);
    }
    return this.toSandbox(rec);
  }

  private buildEnvMap(
    opts: EnsureOptions,
    boot: { token: string; daemonBootId: string; workdir: string },
  ): Record<string, string> {
    const callerEnv: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (RESERVED_ENV_KEYS.has(k)) dropped.push(k);
      else callerEnv[k] = v;
    }
    if (dropped.length > 0) {
      console.warn(
        `[${LOG_LABEL}] opts.env keys overlap reserved bootstrap names and were dropped: ${dropped.join(",")}`,
      );
    }

    return {
      ...callerEnv,
      DAEMON_TOKEN: boot.token,
      DAEMON_BOOT_ID: boot.daemonBootId,
      APP_ROOT: boot.workdir,
      PROXY_PORT: String(DAEMON_CONTAINER_PORT),
    };
  }

  private buildClaim(
    handle: string,
    opts: EnsureOptions,
    boot: { token: string; daemonBootId: string; workdir: string },
  ): SandboxClaim {
    // Warm-pool mode: the operator rejects claim.spec.env outright when
    // warmpool != "none". Studio delivers the per-claim secret post-bind via
    // POST /_sandbox/config + auth.rotateToken instead.
    const warmPoolMode = this.sentinelToken !== null;
    const envEntries = warmPoolMode
      ? []
      : Object.entries(this.buildEnvMap(opts, boot))
          // Sorted so `kubectl diff` doesn't churn across runs that pass the
          // same env in different insertion orders.
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => ({ name, value }));
    // Human-readable ownership/provenance (org name, user email, git repo).
    // Carried on both the claim and the pod; empty → block omitted entirely.
    const annotations = buildTenantAnnotations(opts);
    const hasAnnotations = Object.keys(annotations).length > 0;
    const { impl, templateName } = resolveClaimTemplate(
      opts.daemonImpl,
      this.sandboxTemplateName,
      this.goSandboxTemplateName,
    );
    if (opts.daemonImpl === "go" && impl !== "go") {
      console.warn(
        `[${LOG_LABEL}] daemonImpl=go requested for ${handle} but no Go SandboxTemplate is configured (STUDIO_SANDBOX_GO_TEMPLATE_NAME); landing on ts`,
      );
    }
    return {
      apiVersion: `${K8S_CONSTANTS.CLAIM_API_GROUP}/${K8S_CONSTANTS.CLAIM_API_VERSION}`,
      kind: "SandboxClaim",
      metadata: {
        name: handle,
        namespace: this.namespace,
        // Tenant duplicated on the claim itself (not just the pod) so the
        // adopt path can recover orgId/userId after a state-store wipe;
        // adopt() reads claim.metadata.labels, not pod labels.
        labels: {
          "app.kubernetes.io/name": "studio-sandbox",
          "app.kubernetes.io/managed-by": "studio",
          [LABEL_KEYS.daemonImpl]: impl,
          ...(this.envName ? { [LABEL_KEYS.env]: this.envName } : {}),
          ...buildTenantLabels(opts.tenant),
        },
        ...(hasAnnotations ? { annotations } : {}),
      },
      spec: {
        sandboxTemplateRef: { name: templateName },
        // additionalPodMetadata.labels is the operator's pod-label propagation
        // hook (CRD field, not a generic patch). Tenant labels here flow to
        // the pod and become joinable in cAdvisor/kubelet metrics. `role`
        // distinguishes claimed pods from warm-pool pods (template sets
        // role=sandbox-pod by default).
        additionalPodMetadata: {
          labels: buildTenantLabels(opts.tenant, {
            [LABEL_KEYS.role]: "claimed",
            [LABEL_KEYS.sandboxHandle]: handle,
            // Every panel that splits the Go canary from the TS fleet joins on
            // this. Must NOT also be set in the SandboxTemplate's podTemplate:
            // the operator rejects a claim whose additionalPodMetadata repeats a
            // template label key, even with the same value.
            [LABEL_KEYS.daemonImpl]: impl,
            ...(this.envName ? { [LABEL_KEYS.env]: this.envName } : {}),
          }),
          ...(hasAnnotations ? { annotations } : {}),
        },
        env: envEntries,
        warmpool: warmPoolMode ? "default" : "none",
        lifecycle: {
          shutdownPolicy: "Delete",
          shutdownTime: this.computeShutdownTime(),
        },
      },
    };
  }

  private async provision(
    id: SandboxId,
    handle: string,
    opts: EnsureOptions,
  ): Promise<K8sRecord> {
    const token = this.tokenGenerator();
    const daemonBootId = randomUUID();
    const workdir = DEFAULT_WORKDIR;
    // The impl the claim actually gets — `go` collapses back to `ts` here when
    // the kill switch is off. Resolved once and reused for the record, its
    // persisted opts, and the claim itself (buildClaim re-derives it from the
    // same pure function on the same inputs), so the metric attribute can
    // never disagree with the pod that ran.
    const { impl: resolvedImpl } = resolveClaimTemplate(
      opts.daemonImpl,
      this.sandboxTemplateName,
      this.goSandboxTemplateName,
    );

    const claim = this.buildClaim(handle, opts, {
      token,
      daemonBootId,
      workdir,
    });
    try {
      await createSandboxClaim(this.kubeConfig, this.namespace, claim);
    } catch (err) {
      // ensureLocked already waits for a known-terminating prior claim before
      // falling through here. This catch covers the residual races: a
      // concurrent ensure() from another studio replica raced ours to create,
      // or an external delete (operator TTL, kubectl) finished after we
      // checked but before our POST landed. Wait for the resource to fully
      // disappear and retry exactly once — re-raising AlreadyExists straight
      // to the user surfaces as the "Failed to create SandboxClaim" toast
      // they have to manually recover from.
      if (err instanceof SandboxAlreadyExistsError) {
        await waitForSandboxClaimGone(this.kubeConfig, this.namespace, handle);
        await createSandboxClaim(this.kubeConfig, this.namespace, claim);
      } else {
        throw err;
      }
    }
    // Two-step bind resolution. The operator's reconciler picks an adopted
    // Sandbox first (warm-pool pod or, on cold-start, a freshly-rendered
    // one) and writes its name into `claim.status.sandbox.name`. We wait
    // for that field, then watch the named Sandbox for Ready.
    //
    // Cold-only would let us watch by `metadata.name=<handle>` directly
    // (operator names cold Sandboxes after the claim), but warm-pool
    // adoption picks a pre-existing pool name like
    // `studio-sandbox-kind-abcde` instead — and worse, agent-sandbox
    // v0.4.x has a status-update conflict race that occasionally also
    // creates a stray same-named cold-path Sandbox alongside the adopted
    // pool one. Watching by `<handle>` would talk to that orphan and miss
    // the actually-bound pool pod (the daemon that actually runs the
    // workload). `claim.status.sandbox.name` is the only signal that
    // points at the right one across both shapes.
    //
    // Either bind step can time out — `waitForClaimAdoptedSandbox` if the
    // operator never writes status.sandbox.name (controller crashed,
    // overloaded warm pool exhaustion, etc.), `waitForSandboxReady` if
    // the bound pod never reaches Ready (image pull stall, scheduling
    // failure, kubelet pressure). On either failure we have to delete
    // the orphan claim — leaving it would leak a pod and, worse, the
    // caller's next `ensure()` would adopt-or-recreate against a stuck
    // half-bound claim. Probe results: 3 concurrent ensure() against a
    // size-1 warm pool tripped the 180s readiness timeout on one claim
    // under kind resource pressure, leaving the SandboxClaim behind.
    let adoptedSandboxName: string;
    try {
      adoptedSandboxName = await waitForClaimAdoptedSandbox(
        this.kubeConfig,
        this.namespace,
        handle,
      );
      await waitForSandboxReady(
        this.kubeConfig,
        this.namespace,
        adoptedSandboxName,
      );
    } catch (err) {
      await deleteSandboxClaim(this.kubeConfig, this.namespace, handle).catch(
        () => {},
      );
      throw err;
    }

    // Patch the operator-created Service to declare port 9000, then mint the
    // per-claim HTTPRoute. Both happen before the port-forward opens so that,
    // by the time `Sandbox.previewUrl` reaches the caller, the gateway has a
    // route AND its backend cluster is registered. The Service patch is a
    // workaround for agent-sandbox v0.4.x shipping ports-less Services
    // (`ensureServicePort` doc explains why this matters for Istio). If
    // either step fails the claim is healthy but unroutable — roll back so
    // the caller's retry hits a clean slate.
    try {
      await this.ensureServicePortForAdoptedSandbox(adoptedSandboxName);
      await this.ensureHttpRouteForHandle(
        handle,
        adoptedSandboxName,
        opts.tenant ?? null,
      );
    } catch (err) {
      await deleteSandboxClaim(this.kubeConfig, this.namespace, handle).catch(
        () => {},
      );
      throw err;
    }

    const daemonForward = await this.openForwarder(
      adoptedSandboxName,
      DAEMON_CONTAINER_PORT,
      handle,
    );
    const daemonUrl = `http://127.0.0.1:${daemonForward.localPort}`;
    const configPayload = this.workloadConfigPayload(opts);
    // Warm-pool path: pod boots with the SandboxTemplate's sentinel token;
    // studio authenticates the first /config call with the sentinel and
    // rotates to `token` (per-claim) atomically with the workload patch.
    // After this call returns, only `token` is accepted on the daemon.
    //
    // Cold path: per-claim token was injected via env, daemon already
    // accepts `token`; no rotation needed.
    let resolvedBootId: string = daemonBootId;
    try {
      await waitForDaemonReady(daemonUrl);
      if (this.sentinelToken !== null) {
        const probedHealth = await probeDaemonHealth(daemonUrl);
        if (probedHealth) resolvedBootId = probedHealth.bootId;
        await postConfig(daemonUrl, this.sentinelToken, configPayload ?? {}, {
          rotateToken: token,
        });
      } else if (configPayload) {
        await postConfig(daemonUrl, token, configPayload);
      }
      // Org-fs mounts: relay the config for the pod's privileged sidecar
      // (separate endpoint — see postOrgFsConfig). Post-bind on purpose:
      // warm-pool claims reject spec.env. Best-effort: mounts are additive,
      // a relay failure must not fail provisioning.
      if (opts.orgFsConfigJson) {
        await postOrgFsConfig(daemonUrl, token, opts.orgFsConfigJson).catch(
          (err) => console.warn("[org-fs] sidecar config relay failed", err),
        );
      }
    } catch (err) {
      this.closeForwarder(daemonForward);
      await this.deleteHttpRouteIfManaged(handle).catch(() => {});
      await deleteSandboxClaim(this.kubeConfig, this.namespace, handle).catch(
        () => {},
      );
      throw err;
    }

    return {
      id,
      handle,
      adoptedSandboxName,
      token,
      workdir,
      daemonUrl,
      daemonForward,
      workload: opts.workload ?? null,
      daemonBootId: resolvedBootId,
      tenant: opts.tenant ?? null,
      daemonImpl: resolvedImpl,
      // Persist the impl the claim actually got, not the one asked for: with the
      // kill switch off a `go` request lands on ts, and recovery must replay
      // what ran. Same pure call buildClaim made above.
      ensureOpts: stripEnsureOpts({ ...opts, daemonImpl: resolvedImpl }),
    };
  }

  /**
   * Daemon `/config` payload from ensure opts. Shared by fresh provision and
   * warm-pool re-bootstrap so a recreated pool pod re-clones the same workload.
   */
  private workloadConfigPayload(opts: EnsureOptions | null) {
    return buildConfigPayload({
      runtime: opts?.workload?.runtime ?? "node",
      packageManager: opts?.workload?.packageManager
        ? {
            name: opts.workload.packageManager,
            ...(opts.workload.packageManagerPath
              ? { path: opts.workload.packageManagerPath }
              : {}),
          }
        : null,
      repo: opts?.repo ?? null,
      port: opts?.workload?.devPort ?? DEFAULT_DEV_PORT,
      tenant: opts?.tenant ?? undefined,
    });
  }

  /**
   * Forward a freshly-minted clone credential to a resumed/adopted sandbox's
   * daemon so authenticated git survives the ~1h expiry of the token baked in
   * at provision. Best-effort: a rotation failure must not fail the resume (the
   * sandbox is otherwise healthy; worst case git stays stale until next start).
   * The daemon classifies same-repo + new-token as `git-credential-refresh` and
   * rotates `origin` in place; identical token / public clone is a no-op.
   */
  private async refreshDaemonGitCredential(
    rec: K8sRecord,
    opts: EnsureOptions,
  ): Promise<void> {
    const patch = gitCredentialRefreshPatch(opts);
    if (!patch) return;
    try {
      await postConfig(rec.daemonUrl, rec.token, patch);
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] git credential refresh failed for ${rec.handle}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Return `repo` with a freshly-minted credentialed cloneUrl, or unchanged
   * when no minter is wired or it declines. The persisted cloneUrl embeds a
   * ~55min GitHub App token from first provision; on recovery (pod recreation
   * under a live claim) that token has usually lapsed, so replaying it clones /
   * pushes with a dead credential. Best-effort — a mint failure must not block
   * recovery, so this falls back to the persisted URL.
   */
  private async withFreshCloneUrl(
    repo: NonNullable<EnsureOptions["repo"]>,
    bufferMs?: number,
  ): Promise<NonNullable<EnsureOptions["repo"]>> {
    if (!this.mintCloneUrl) return repo;
    try {
      const fresh = await this.mintCloneUrl(
        repo,
        bufferMs !== undefined ? { bufferMs } : undefined,
      );
      return fresh ? { ...repo, cloneUrl: fresh } : repo;
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] clone credential re-mint failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return repo;
    }
  }

  /**
   * Keep the git credential fresh in long-lived sandboxes this replica serves.
   * A pod alive past the clone token's ~55min expiry with no recovery event
   * would push a dead credential on shutdown and lose the user's work; recovery
   * (resume/adopt/resurrect) only re-mints on a claim/pod event, so a
   * continuously-editing pod is otherwise never refreshed. Runs off the request
   * path (zero hot-path cost); cancelled via `claimWatchAbort` on `close()`.
   *
   * Coverage is per-replica (`this.records` = sandboxes this replica holds
   * warm). That's the replica whose port-forward drives the shutdown push too,
   * so it's the right one in practice — a pod served only by another replica is
   * refreshed by that replica instead.
   */
  private startCredentialRefresher(): void {
    // No minter wired (tests / non-agent-sandbox deploys) → nothing to refresh.
    if (!this.mintCloneUrl) return;
    const { signal } = this.claimWatchAbort;
    void (async () => {
      while (!signal.aborted) {
        await sleep(CREDENTIAL_REFRESH_INTERVAL_MS, { signal }).catch(() => {});
        if (signal.aborted) break;
        try {
          await this.refreshAllGitCredentials();
        } catch (err) {
          console.warn(
            `[${LOG_LABEL}] periodic credential refresh failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    })();
  }

  /**
   * Re-mint + rotate the git credential for every cached sandbox with a
   * connection-backed repo. Grouping/serialization is in
   * `refreshCredentialsByConnection`; this just supplies the per-record work.
   */
  private async refreshAllGitCredentials(): Promise<void> {
    await refreshCredentialsByConnection(
      this.records.values(),
      (rec) => rec.ensureOpts?.repo?.connectionId,
      async (rec) => {
        if (this.claimWatchAbort.signal.aborted) return;
        const repo = rec.ensureOpts?.repo;
        if (!repo) return;
        const fresh = await this.withFreshCloneUrl(
          repo,
          CREDENTIAL_REFRESH_BUFFER_MS,
        );
        await this.refreshDaemonGitCredential(rec, {
          ...rec.ensureOpts,
          repo: fresh,
        });
        // Keep the record's URL current so the next sweep sees the fresh token
        // (a no-op) rather than re-deriving the stale one.
        rec.ensureOpts = { ...rec.ensureOpts, repo: fresh };
      },
    );
  }

  /**
   * Warm-pool re-bootstrap. A pool pod recreated under a live claim (operator
   * rebind, node churn, idle-TTL reap) boots back on the SandboxTemplate
   * sentinel and is "unclaimed": it rejects our persisted per-claim token and
   * has none of the workload. Re-run the bootstrap handshake against the fresh
   * daemon — authenticate with the sentinel, re-post the workload (triggers
   * re-clone/install), and rotate back to our per-claim token.
   *
   * Only `rehydrate` calls this, after `openAndProbeDaemon` confirmed the
   * daemon is reachable and resolved `daemonUrl` from the claim's *current*
   * `status.sandbox.name` — so the pod is authoritatively the one bound to our
   * claim (no stale-name cross-tenant risk). Self-validating: the sentinel
   * handshake only succeeds when the daemon is genuinely sentinel-authenticated
   * (recreated/unclaimed), so a daemon still holding our token is left
   * untouched. Returns false when not in warm-pool mode or the handshake fails;
   * caller purges and reprovisions.
   */
  private async rebootstrapDaemon(
    daemonUrl: string,
    token: string,
    ensureOpts: EnsureOptions | null,
  ): Promise<boolean> {
    if (this.sentinelToken === null) return false;
    const payload = this.workloadConfigPayload(ensureOpts) ?? {};
    try {
      await postConfig(daemonUrl, this.sentinelToken, payload, {
        rotateToken: token,
      });
      return true;
    } catch (err) {
      // A 401 means the daemon no longer accepts the sentinel: it was already
      // rotated to our per-claim token (a stale stored bootId triggered this
      // re-bootstrap against a pod we'd already healed — the resume/reactive-401
      // paths don't persist bootId). The pod is still ours, so re-assert the
      // workload authenticated with our own token (rotating token→token is a
      // no-op) instead of tearing the sandbox down. Only if THAT also fails is
      // the pod genuinely not ours and the caller should reprovision.
      if (err instanceof ConfigRequestError && err.status === 401) {
        try {
          await postConfig(daemonUrl, token, payload, { rotateToken: token });
          return true;
        } catch (retryErr) {
          console.warn(
            `[${LOG_LABEL}] re-bootstrap retry with claim token failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
          return false;
        }
      }
      console.warn(
        `[${LOG_LABEL}] re-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * No-op when `previewGateway` isn't configured. Otherwise Server-Side
   * Apply port 9000 (named "daemon") onto the operator-created Service
   * for the *adopted* Sandbox. The agent-sandbox operator (v0.4.x) ships
   * Services with empty `spec.ports`, which makes Istio refuse to register
   * an upstream cluster — `ensureServicePort` doc has the full rationale.
   * Idempotent: once studio owns `spec.ports[name=daemon]` (first SSA),
   * subsequent calls with the same body are recorded as no-ops by the API
   * server.
   *
   * Targets `adoptedSandboxName`, NOT `handle`. On warm-pool adoption these
   * differ: the adopted Sandbox carries its pool-generated name (e.g.
   * `studio-sandbox-kind-abcde`) and so does its operator-managed Service.
   * The cold-path duplicate Sandbox the v0.4.x adoption race occasionally
   * creates also has a Service (named after the claim), but it backs the
   * unconfigured cold-path pod — patching that one would route preview
   * traffic to the wrong daemon.
   */
  private async ensureServicePortForAdoptedSandbox(
    adoptedSandboxName: string,
  ): Promise<void> {
    if (!this.previewGateway || !this.previewUrlPattern) return;
    await ensureServicePort(
      this.kubeConfig,
      this.namespace,
      adoptedSandboxName,
      {
        name: "daemon",
        port: DAEMON_CONTAINER_PORT,
        targetPort: DAEMON_CONTAINER_PORT,
      },
    );
  }

  /**
   * No-op when `previewGateway` isn't configured. Otherwise upsert (SSA)
   * an HTTPRoute that maps `<handle>.<base>` → Service `<adoptedSandboxName>`
   * port 9000. applyHttpRoute is idempotent and mutating, so calling it from
   * the adopt path re-points the backendRef at the newly bound pool pod
   * rather than leaving it on the previous (deleted) Service.
   *
   * Route name and hostname stay tied to `handle` so the public preview
   * URL is stable across pool re-adoptions and so cleanup
   * (`deleteHttpRouteIfManaged`) can find the route by handle. The
   * backendRef switches to `adoptedSandboxName` for the same reason
   * `ensureServicePortForAdoptedSandbox` does — we want traffic to land on
   * the actually-bound pool pod, not the operator's cold-path orphan.
   */
  private async ensureHttpRouteForHandle(
    handle: string,
    adoptedSandboxName: string,
    tenant: RunnerTenant | null,
  ): Promise<void> {
    if (!this.previewGateway || !this.previewUrlPattern) return;
    const hostname = previewHostnameForHandle(this.previewUrlPattern, handle);
    if (!hostname) {
      throw new SandboxError(
        `Unable to derive preview hostname for ${handle} from pattern: ${this.previewUrlPattern}`,
      );
    }
    const route: HttpRoute = {
      apiVersion: `${HTTPROUTE_CONSTANTS.API_GROUP}/${HTTPROUTE_CONSTANTS.API_VERSION}`,
      kind: "HTTPRoute",
      metadata: {
        name: handle,
        namespace: this.namespace,
        labels: buildTenantLabels(tenant ?? undefined, {
          [LABEL_KEYS.role]: "claimed",
          [LABEL_KEYS.sandboxHandle]: handle,
          "app.kubernetes.io/name": "studio-sandbox",
          "app.kubernetes.io/managed-by": "studio",
          ...(this.envName ? { [LABEL_KEYS.env]: this.envName } : {}),
        }),
      },
      spec: {
        parentRefs: [
          {
            kind: "Gateway",
            group: "gateway.networking.k8s.io",
            name: this.previewGateway.name,
            namespace: this.previewGateway.namespace,
          },
        ],
        hostnames: [hostname],
        rules: [
          {
            backendRefs: [
              {
                group: "",
                kind: "Service",
                name: adoptedSandboxName,
                port: DAEMON_CONTAINER_PORT,
              },
            ],
          },
        ],
      },
    };
    await applyHttpRoute(this.kubeConfig, this.namespace, route);
  }

  /** No-op when `previewGateway` isn't configured. 404-tolerant otherwise. */
  private async deleteHttpRouteIfManaged(handle: string): Promise<void> {
    if (!this.previewGateway) return;
    await deleteHttpRoute(this.kubeConfig, this.namespace, handle);
  }

  /**
   * Reconstruct a record from persisted state. After this returns, the record
   * is ready for any of the six methods — the daemon port-forward is open and
   * its `/health` has been re-probed. Returns null on any mismatch; caller
   * purges and falls through to adopt/provision.
   */
  private async rehydrate(
    id: SandboxId,
    handle: string,
    persisted: { handle: string; state: Record<string, unknown> },
  ): Promise<K8sRecord | null> {
    const state = persisted.state as Partial<PersistedK8sState>;
    if ((!state.adoptedSandboxName && !state.podName) || !state.token)
      return null;

    const claim = await getSandboxClaim(
      this.kubeConfig,
      this.namespace,
      handle,
    ).catch(() => undefined);
    if (!claim || !isSandboxReady(claim)) return null;

    // Persisted `adoptedSandboxName` is missing on rows written before
    // warm-pool support — those rows describe cold-path sandboxes whose
    // Service name equals `handle`. Fall back to `handle` so existing
    // claims keep routing correctly. Cross-check `claim.status.sandbox.name`
    // first: the operator can update it (e.g. on pod recreation), and
    // routing must follow that.
    // Cross-check claim.status.sandbox.name first: the operator can update
    // it (e.g. on pod recreation). Fall back to persisted adoptedSandboxName,
    // then state.podName (back-compat with pre-warm-pool rows), then handle.
    // In agent-sandbox the pod name always equals the Sandbox CR name, so
    // adoptedSandboxName is the correct port-forward target.
    const adoptedSandboxName =
      claim.status?.sandbox?.name ??
      state.adoptedSandboxName ??
      state.podName ??
      handle;

    const live = await this.openAndProbeDaemon(adoptedSandboxName, handle);
    if (!live) return null;

    // bootId change = the pod was recreated. In warm-pool mode the new pool pod
    // booted back on the sentinel (unclaimed): it has neither our rotated token
    // nor the workload, so re-run the bootstrap handshake against it. On
    // failure, purge so the caller reprovisions. In cold mode the env-injected
    // token is stable across restarts and the orchestrator resumes on its own,
    // so a bootId change there is informational only.
    if (state.daemonBootId && state.daemonBootId !== live.bootId) {
      if (this.sentinelToken !== null) {
        // Re-clone with a live credential — the persisted cloneUrl's token has
        // usually lapsed by the time a pool pod is recreated under the claim.
        const rebootstrapOpts: EnsureOptions | null = state.ensureOpts?.repo
          ? {
              ...state.ensureOpts,
              repo: await this.withFreshCloneUrl(state.ensureOpts.repo),
            }
          : (state.ensureOpts ?? null);
        const ok = await this.rebootstrapDaemon(
          live.daemonUrl,
          state.token,
          rebootstrapOpts,
        );
        if (!ok) {
          this.closeForwarder(live.daemonForward);
          return null;
        }
      } else {
        console.warn(
          `[${LOG_LABEL}] daemon restart detected (handle=${handle}): stored bootId=${state.daemonBootId} live bootId=${live.bootId}`,
        );
      }
      // Track the live bootId so a later rehydrate doesn't see the same stale
      // mismatch and re-fire against a pod we've already healed (the resume +
      // reactive-401 paths don't persist via finish). Non-fatal on failure —
      // worst case is a redundant re-bootstrap next time.
      await this.stateStore
        ?.put(id, RUNNER_KIND, {
          handle,
          state: { ...state, daemonBootId: live.bootId },
        })
        .catch((err) =>
          console.warn(
            `[${LOG_LABEL}] bootId persist failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    return {
      id,
      handle,
      adoptedSandboxName,
      token: state.token,
      workdir: state.workdir ?? DEFAULT_WORKDIR,
      daemonUrl: live.daemonUrl,
      daemonForward: live.daemonForward,
      workload: state.workload ?? null,
      daemonBootId: live.bootId,
      tenant: state.tenant ?? null,
      ensureOpts: state.ensureOpts ?? null,
      // Rows written before the rollout gate existed have no persisted impl;
      // they are TS sandboxes by construction, but say null rather than guess.
      daemonImpl: state.ensureOpts?.daemonImpl ?? null,
    };
  }

  private async adopt(
    id: SandboxId,
    handle: string,
    claim: SandboxResource,
  ): Promise<K8sRecord | null> {
    if (!isSandboxReady(claim)) return null;
    const adoptedSandboxName = claim.status?.sandbox?.name ?? handle;
    // Warm-pool mode keeps `claim.spec.env: []` so the per-claim token is
    // not recoverable from the cluster — it lives only in the state-store.
    // When the state-store is wiped (the trigger that brings us into
    // adopt), there's no way to retrieve it. Returning null falls through
    // to delete + reprovision; the pool releases the pod, the operator
    // allocates a fresh one, and studio rotates a new token onto it.
    if (this.sentinelToken !== null) return null;
    const token = readClaimDaemonToken(claim);
    if (!token) return null;

    const live = await this.openAndProbeDaemon(adoptedSandboxName, handle);
    if (!live) return null;

    const tenant = readClaimTenant(claim);
    // Backfill the Service port + HTTPRoute for legacy claims provisioned
    // before per-claim routing existed. Both calls are idempotent SSA upserts
    // — the Service patch is a no-op once `port: 9000` is declared, and
    // applyHttpRoute re-points the backendRef at this adoption's Service even
    // when a route from a prior pool pod survives. Failures here don't block
    // adoption:
    // preview traffic stays unrouted until the next ensure() picks it up;
    // the rest of the sandbox surface (exec, port-forward) is unaffected.
    // Service patch first so that, if the route is missing, recreating it
    // immediately after will already see a working cluster on the gateway
    // side.
    if (this.previewGateway) {
      await this.ensureServicePortForAdoptedSandbox(adoptedSandboxName).catch(
        (err) => {
          console.warn(
            `[${LOG_LABEL}] Service port backfill failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      await this.ensureHttpRouteForHandle(
        handle,
        adoptedSandboxName,
        tenant,
      ).catch((err) => {
        console.warn(
          `[${LOG_LABEL}] HTTPRoute backfill failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return {
      id,
      handle,
      adoptedSandboxName,
      token,
      workdir: DEFAULT_WORKDIR,
      daemonUrl: live.daemonUrl,
      daemonForward: live.daemonForward,
      workload: null,
      daemonBootId: live.bootId,
      // Recovered from claim labels written at provision time. Null if the
      // claim pre-dates tenant labelling (back-compat with already-running
      // sandboxes when this code rolls out).
      tenant,
      // Adopt happens when the state-store is empty but a claim with our
      // deterministic name still exists in the cluster (e.g. studio restart
      // without state-store, or state-store wipe). The original opts aren't
      // recoverable from the claim alone, so resurrection on this record
      // can't autonomously re-provision; falls back to the caller's
      // SANDBOX_START path.
      ensureOpts: null,
      // The one thing that IS recoverable without ensureOpts: the claim label
      // studio stamped at provision time. Without this, every adopted sandbox
      // would drop out of the impl split during exactly the incident (studio
      // restarted, state-store empty) you'd be reading the dashboard for.
      daemonImpl: readClaimDaemonImpl(claim),
    };
  }

  /**
   * Open the daemon port-forward and probe `/health`. Closes the forwarder
   * and returns null on any failure so the caller can fall through to
   * recreate. Both `rehydrate` and `adopt` share this shape — the only
   * difference is whether the bootId match is checked.
   */
  private async openAndProbeDaemon(
    podName: string,
    handle: string,
  ): Promise<{
    daemonForward: PortForwarder;
    daemonUrl: string;
    bootId: string;
  } | null> {
    const daemonForward = await this.openForwarder(
      podName,
      DAEMON_CONTAINER_PORT,
      handle,
    ).catch(() => null);
    if (!daemonForward) return null;
    const daemonUrl = `http://127.0.0.1:${daemonForward.localPort}`;
    // probeDaemonHealth returns null when /health is unreachable OR lacks a
    // bootId (older daemon shape). Either way, purge + re-provision.
    const health = await probeDaemonHealth(daemonUrl);
    if (!health) {
      this.closeForwarder(daemonForward);
      return null;
    }
    return { daemonForward, daemonUrl, bootId: health.bootId };
  }

  // ---- Handle resolution (post-restart) -------------------------------------

  private async getRecord(handle: string): Promise<K8sRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const persisted = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!persisted) return null;
    const rec = await this.rehydrate(persisted.id, handle, persisted);
    if (rec) this.records.set(handle, rec);
    return rec;
  }

  /**
   * Re-ensure a sandbox after operator-driven eviction (15-min idle TTL deletes
   * claim + pod). Looks up the SandboxId from the state-store by handle, then
   * runs the standard `ensure()` path with the persisted `EnsureOptions` so the
   * fresh provision rehydrates with the same repo/env/workload.
   *
   * Returns null when:
   *  - no state-store (test runners) — caller surfaces 404,
   *  - handle has no row (truly unknown) — caller surfaces 404,
   *  - row predates `ensureOpts` persistence (back-compat: rows from before
   *    this change). Resurrecting with empty opts would create an empty pod
   *    with no repo cloned, which is worse than 404. UI's existing
   *    notFound→SANDBOX_START flow re-supplies opts in that case.
   */
  private async resurrectByHandle(handle: string): Promise<K8sRecord | null> {
    if (!this.stateStore) return null;
    const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!row) return null;
    const persistedOpts = (row.state as Partial<PersistedK8sState>).ensureOpts;
    if (!persistedOpts) return null;
    // The persisted cloneUrl carries the first-provision token, long expired by
    // now. Re-mint so the reprovision (and the downstream credential rotation)
    // uses a live credential instead of the dead one.
    const opts: EnsureOptions = persistedOpts.repo
      ? {
          ...persistedOpts,
          repo: await this.withFreshCloneUrl(persistedOpts.repo),
        }
      : persistedOpts;
    // ensure() is idempotent + advisory-locked, so concurrent resurrections
    // for the same handle collapse to a single provision. The lock is keyed
    // on (userId, projectRef, kind), the same identity our state-store row
    // is keyed on.
    await this.ensure(row.id, opts);
    return this.records.get(handle) ?? null;
  }

  /**
   * Drop the in-memory record cache for `handle`. Called when the cached
   * `daemonUrl` proves stale (e.g. fetch fails with connection refused after
   * the operator deleted the underlying pod). The next access goes through
   * the state-store + rehydrate or resurrection path.
   */
  private invalidateRecord(handle: string): void {
    const rec = this.records.get(handle);
    if (!rec) return;
    this.records.delete(handle);
    this.closeForwarder(rec.daemonForward);
  }

  // ---- Metric helpers -------------------------------------------------------

  private recordProxyDuration(
    source: "daemon" | "preview",
    statusCode: number,
    rec: K8sRecord | null,
    durationMs: number,
    fallbackHandle?: string,
  ): void {
    if (!this.metrics) return;
    this.metrics.proxyDurationMs.record(durationMs, {
      ...tenantAttrs(rec?.tenant ?? null, rec?.daemonImpl ?? null),
      source,
      sandbox_handle: rec?.handle ?? fallbackHandle ?? "",
      status_code: statusCode || 0,
    });
  }

  // ---- Identity + preview URL ----------------------------------------------

  // Local mode: route preview traffic through the daemon port-forward, not
  // a separate dev forwarder. The daemon serves /_sandbox/* + /health
  // in-process and reverse-proxies everything else to in-pod localhost:DEV_PORT
  // (with CSP/X-Frame stripping + HMR bootstrap injection). Pointing the URL
  // straight at the dev port would bypass that proxy and break SSE + iframe
  // embedding. Production mode (previewUrlPattern set) goes through the
  // ingress-terminated URL the operator emits.
  private composePreviewUrl(rec: K8sRecord): string {
    if (this.previewUrlPattern) {
      return applyPreviewPattern(this.previewUrlPattern, rec.handle);
    }
    return `http://127.0.0.1:${rec.daemonForward.localPort}/`;
  }

  private toSandbox(rec: K8sRecord): Sandbox {
    return {
      handle: rec.handle,
      workdir: rec.workdir,
      previewUrl: this.composePreviewUrl(rec),
    };
  }

  // ---- Persistence ----------------------------------------------------------

  private async persist(
    ops: RunnerStateStoreOps | null,
    rec: K8sRecord,
  ): Promise<void> {
    if (!ops) return;
    const state: PersistedK8sState = {
      adoptedSandboxName: rec.adoptedSandboxName,
      token: rec.token,
      workdir: rec.workdir,
      workload: rec.workload,
      daemonBootId: rec.daemonBootId,
      tenant: rec.tenant,
      ...(rec.ensureOpts ? { ensureOpts: rec.ensureOpts } : {}),
    };
    await ops.put(rec.id, RUNNER_KIND, { handle: rec.handle, state });
  }

  // ---- TTL helpers ----------------------------------------------------------

  private computeShutdownTime(): string {
    return new Date(Date.now() + this.idleTtlMs).toISOString();
  }

  // ---- Port-forwarding ------------------------------------------------------

  /**
   * Opens a 127.0.0.1 TCP listener whose connections tunnel to
   * `podName:containerPort` via the apiserver. Each TCP connection spawns a
   * fresh WebSocket — matches `kubectl port-forward`'s semantics. Lifecycle
   * is mutual: client socket close → close the k8s WS; WS close → destroy
   * the client socket.
   */
  private openForwarder(
    podName: string,
    containerPort: number,
    // `handle` is passed separately so the deterministic port survives pod
    // recreation (operator-driven): sandboxMap's cached previewUrl stays valid.
    handle: string = podName,
  ): Promise<PortForwarder> {
    const startPort = deterministicLocalPort(handle, containerPort);
    return new Promise((resolve, reject) => {
      const tryBind = (port: number, attempt: number) => {
        const server = net.createServer((socket) =>
          this.handleForwardedConnection(
            socket,
            podName,
            containerPort,
            handle,
          ),
        );
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < PORT_WALK_LIMIT) {
            // Release the failed listener before walking forward — listen()
            // failure leaves the Server object holding the connection handler
            // closure; closing makes the leak trivially visible to GC.
            try {
              server.close();
            } catch {}
            const next =
              PORT_RANGE_START +
              ((port - PORT_RANGE_START + 1) % PORT_RANGE_SIZE);
            tryBind(next, attempt + 1);
            return;
          }
          reject(err);
        });
        server.listen(port, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("port-forward listener failed to bind"));
            return;
          }
          resolve({ server, localPort: address.port });
        });
      };
      tryBind(startPort, 0);
    });
  }

  private handleForwardedConnection(
    socket: net.Socket,
    podName: string,
    containerPort: number,
    handle: string,
  ): void {
    // Inbound bytes pipe through a PassThrough rather than the socket
    // directly: `portForward` attaches its 'data' listener only after the
    // WebSocket opens (async); on Bun, bytes arriving in that window are
    // dropped. Piping synchronously into a PassThrough buffers those bytes
    // until the library drains it.
    const inbound = new PassThrough();
    let ws: ForwardWebSocket | null = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      inbound.destroy();
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      if (!socket.destroyed) socket.destroy();
    };

    socket.pipe(inbound);
    socket.on("error", cleanup);
    socket.on("close", cleanup);

    this.portForward
      .portForward(
        this.namespace,
        podName,
        [containerPort],
        socket,
        null,
        inbound,
      )
      .then((res) => {
        // retryCount=0 (default) → raw WebSocket; retryCount>0 → factory fn.
        const opened = typeof res === "function" ? res() : res;
        if (!opened) {
          cleanup();
          return;
        }
        ws = opened as ForwardWebSocket;
        ws.on("close", cleanup);
        ws.on("error", () => {
          this.invalidateRecord(handle);
          cleanup();
        });
        if (closed) {
          try {
            ws.close();
          } catch {}
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `[${LOG_LABEL}] port-forward to ${podName}:${containerPort} failed: ${errMsg(err)}`,
        );
        this.invalidateRecord(handle);
        cleanup();
      });
  }

  private closeForwarder(forwarder: PortForwarder): void {
    forwarder.server.close((err) => {
      if (err) {
        console.warn(
          `[${LOG_LABEL}] port-forward close on :${forwarder.localPort} errored: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.claimWatchAbort.abort();
    for (const rec of this.records.values()) {
      this.closeForwarder(rec.daemonForward);
    }
    this.records.clear();
  }
}

// ---- Helpers ----------------------------------------------------------------

interface RunnerMetrics {
  active: UpDownCounter;
  ensureOutcome: Counter;
  proxyDurationMs: Histogram;
}

function buildRunnerMetrics(meter: Meter): RunnerMetrics {
  return {
    active: meter.createUpDownCounter("studio.sandbox.active", {
      description:
        "Active sandbox count, by runner kind, owning org, and daemon impl. Cross-checks the cAdvisor-derived count from the cluster — divergence between the two indicates orphaned claims (studio deleted but K8s didn't reap) or unattributed pods.",
      unit: "{sandbox}",
    }),
    ensureOutcome: meter.createCounter("studio.sandbox.ensure.outcome", {
      description:
        "Outcome of each ensure() call: fresh provision, resume from state-store after restart, or adopt of a cluster-side claim studio didn't know about. Cold-start ratio is the primary input for warm-pool sizing.",
      unit: "{call}",
    }),
    proxyDurationMs: meter.createHistogram("studio.sandbox.proxy.duration_ms", {
      description:
        "Wall-clock latency of studio-mediated requests to the sandbox daemon: tool exec proxies (source=daemon) and preview iframe traffic (source=preview).",
      unit: "ms",
    }),
  };
}

function loadDefaultKubeConfig(): KubeConfig {
  const kc = new KubeConfigClass();
  kc.loadFromDefault();
  return kc;
}

function isSandboxReady(resource: SandboxResource): boolean {
  return Boolean(
    resource.status?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True",
    ),
  );
}

function readClaimDaemonToken(claim: SandboxResource): string | null {
  const env = claim.spec?.env;
  if (!env) return null;
  for (const entry of env) {
    if (entry.name === "DAEMON_TOKEN" && entry.value) return entry.value;
  }
  return null;
}

function deterministicLocalPort(handle: string, containerPort: number): number {
  const hash = createHash("sha256")
    .update(`${handle}:${containerPort}`)
    .digest();
  return PORT_RANGE_START + (hash.readUInt32BE(0) % PORT_RANGE_SIZE);
}

// CORS headers on synthesized preview-proxy responses. The studio iframe
// renders under the studio origin and fetches the preview origin cross-site
// (SSE at `/_sandbox/events`, plus the EventSource probeMissing fetch);
// without ACAO the browser blocks the response *and* hides the actual status,
// so a 404 from us looks like an opaque CORS failure in devtools. The daemon
// already sets ACAO on its own responses — these headers only fire on errors
// we synthesize before reaching the daemon.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

// K8s label keys studio attaches. Centralized so writers (buildTenantLabels)
// and the reader (readClaimTenant) can't drift.
const LABEL_KEYS = {
  role: "studio.decocms.com/role",
  sandboxHandle: "studio.decocms.com/sandbox-handle",
  orgId: "studio.decocms.com/org-id",
  userId: "studio.decocms.com/user-id",
  env: "studio.decocms.com/env",
  daemonImpl: "studio.decocms.com/daemon-impl",
} as const;

/**
 * Which SandboxTemplate a claim gets, and therefore which daemon binary its
 * pod's entrypoint execs. Pure so the rollout gate is testable without a
 * cluster: it is the one place `go` can collapse back to `ts`.
 *
 * `goTemplateName === null` (i.e. `STUDIO_SANDBOX_GO_TEMPLATE_NAME` unset) is
 * the global kill switch — pointing a claim at a template that doesn't exist
 * fails provisioning outright, so an unconfigured deploy must ignore the
 * request rather than honor it.
 */
export function resolveClaimTemplate(
  requested: SandboxDaemonImpl | undefined,
  tsTemplateName: string,
  goTemplateName: string | null,
): { impl: SandboxDaemonImpl; templateName: string } {
  if (requested === "go" && goTemplateName) {
    return { impl: "go", templateName: goTemplateName };
  }
  return { impl: "ts", templateName: tsTemplateName };
}

// K8s annotation keys for human-readable ownership/provenance. Unlike labels,
// annotation values aren't charset-limited, so these carry the identity that
// can't be a label (emails with `@`, org names with spaces, repo paths with
// `/`). Purely informational — recovered on adopt for round-trip fidelity but
// never load-bearing for routing or tenancy.
const ANNOTATION_KEYS = {
  orgSlug: "studio.decocms.com/org-slug",
  orgName: "studio.decocms.com/org-name",
  userEmail: "studio.decocms.com/user-email",
  userName: "studio.decocms.com/user-name",
  gitRepo: "studio.decocms.com/git-repo",
  gitRepoUrl: "studio.decocms.com/git-repo-url",
  gitBranch: "studio.decocms.com/git-branch",
} as const;

// K8s label values: ≤63 chars, must match `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`.
// Org/user IDs are UUIDs in studio and pass through unchanged; the regex check
// + truncation is defensive against future ID-shape changes (the operator will
// reject the claim outright if a label value is invalid).
const LABEL_VALUE_RE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const MAX_LABEL_VALUE_LEN = 63;

function sanitizeLabelValue(value: string): string {
  const truncated = value.slice(0, MAX_LABEL_VALUE_LEN);
  return LABEL_VALUE_RE.test(truncated) ? truncated : "";
}

// Tighter than LABEL_VALUE_RE — envName flows into K8s resource names
// (e.g. studio-sandbox-<env>), which require this restricted charset.
// Must match the regex the sandbox-env chart enforces on envName.
const ENV_NAME_RE = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

function normalizeEnvName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!ENV_NAME_RE.test(trimmed)) {
    throw new Error(
      `AgentSandboxProvider: envName=${JSON.stringify(trimmed)} is not a valid DNS-label-safe environment name (lowercase alphanumeric or '-', starts with a letter, ends alphanumeric, ≤32 chars). Studio sets this from STUDIO_ENV; check the studio chart's configMap.`,
    );
  }
  return trimmed;
}

/**
 * Tenant labels for `adopt()` recovery + cost attribution. Used on both the
 * claim (so `kubectl get sandboxclaim` shows ownership and adopt() can read
 * orgId/userId after a state-store wipe) and the pod (where cAdvisor /
 * kubelet metrics pick them up). Pass `extra` for pod-only fields like
 * `role` and `sandbox-handle`.
 */
function buildTenantLabels(
  tenant: EnsureOptions["tenant"],
  extra: Record<string, string> = {},
): Record<string, string> {
  const labels: Record<string, string> = { ...extra };
  if (tenant) {
    const orgId = sanitizeLabelValue(tenant.orgId);
    const userId = sanitizeLabelValue(tenant.userId);
    if (orgId) labels[LABEL_KEYS.orgId] = orgId;
    if (userId) labels[LABEL_KEYS.userId] = userId;
  }
  return labels;
}

// Annotation values have no k8s-imposed charset limit, but we cap length and
// strip control chars/newlines defensively (the operator validates the whole
// object; a stray newline in a value can trip strict YAML round-trips).
const MAX_ANNOTATION_VALUE_LEN = 253;

function sanitizeAnnotationValue(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.slice(0, MAX_ANNOTATION_VALUE_LEN);
}

// Drop any embedded `user:token@` credential before exposing a clone URL as an
// annotation. cloneUrl may carry an OAuth token (see EnsureOptions.repo) and
// annotations are world-readable to anyone with `get` on the namespace.
function stripUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Human-readable ownership/provenance annotations for the claim + pod. Mirrors
 * the label tenant data with the fields that can't be labels (org name, user
 * email) plus git repo provenance. Returns {} when nothing is available so the
 * caller can omit the annotations block entirely.
 */
function buildTenantAnnotations(opts: EnsureOptions): Record<string, string> {
  const annotations: Record<string, string> = {};
  const tenant = opts.tenant;
  if (tenant?.orgSlug) {
    annotations[ANNOTATION_KEYS.orgSlug] = sanitizeAnnotationValue(
      tenant.orgSlug,
    );
  }
  if (tenant?.orgName) {
    annotations[ANNOTATION_KEYS.orgName] = sanitizeAnnotationValue(
      tenant.orgName,
    );
  }
  if (tenant?.userEmail) {
    annotations[ANNOTATION_KEYS.userEmail] = sanitizeAnnotationValue(
      tenant.userEmail,
    );
  }
  if (tenant?.userName) {
    annotations[ANNOTATION_KEYS.userName] = sanitizeAnnotationValue(
      tenant.userName,
    );
  }
  const repo = opts.repo;
  if (repo) {
    if (repo.displayName) {
      annotations[ANNOTATION_KEYS.gitRepo] = sanitizeAnnotationValue(
        repo.displayName,
      );
    }
    const repoUrl = stripUrlCredentials(repo.cloneUrl);
    if (repoUrl) {
      annotations[ANNOTATION_KEYS.gitRepoUrl] =
        sanitizeAnnotationValue(repoUrl);
    }
    const branch = opts.branch ?? repo.branch;
    if (branch) {
      annotations[ANNOTATION_KEYS.gitBranch] = sanitizeAnnotationValue(branch);
    }
  }
  return annotations;
}

/** Read tenant back from a claim's metadata.labels + annotations (adopt path). */
function readClaimTenant(claim: SandboxResource): RunnerTenant | null {
  const labels = claim.metadata?.labels;
  if (!labels) return null;
  const orgId = labels[LABEL_KEYS.orgId];
  const userId = labels[LABEL_KEYS.userId];
  if (!orgId || !userId) return null;
  const annotations = claim.metadata?.annotations ?? {};
  return {
    orgId,
    userId,
    orgSlug: annotations[ANNOTATION_KEYS.orgSlug],
    orgName: annotations[ANNOTATION_KEYS.orgName],
    userEmail: annotations[ANNOTATION_KEYS.userEmail],
    userName: annotations[ANNOTATION_KEYS.userName],
  };
}

/**
 * Which daemon binary a claim's pod runs, per the label studio stamped at
 * provision time. The cluster-side source of truth, and the only way to
 * recover the impl on the adopt path (where `ensureOpts` is unrecoverable).
 * Returns null for claims that predate the label rather than assuming `ts`.
 */
export function readClaimDaemonImpl(
  claim: SandboxResource,
): SandboxDaemonImpl | null {
  const value = claim.metadata?.labels?.[LABEL_KEYS.daemonImpl];
  return value === "go" || value === "ts" ? value : null;
}

/**
 * Convert tenant struct to OTel attribute keys. `runner_kind` is constant for
 * a given runner instance but included on every attrs set so downstream
 * dashboards can pivot across runners without re-aggregating.
 *
 * `daemon_impl` is the Go-rollout comparison dimension: it splits every
 * sandbox metric by the binary the pod actually ran, so `go` and `ts` can be
 * read side by side while both are live. Empty when unknown — never defaulted
 * to `ts`, because a Go sandbox counted as TS is worse than one counted as
 * neither. Cardinality is bounded at 3 (`go` | `ts` | `""`).
 */
function tenantAttrs(
  tenant: RunnerTenant | null,
  daemonImpl: SandboxDaemonImpl | null,
): {
  org_id: string;
  user_id: string;
  runner_kind: string;
  daemon_impl: string;
} {
  return {
    org_id: tenant?.orgId ?? "",
    user_id: tenant?.userId ?? "",
    runner_kind: RUNNER_KIND,
    daemon_impl: daemonImpl ?? "",
  };
}

/**
 * Subset of `EnsureOptions` worth persisting for resurrection. Drops `image`
 * (k8s ignores it — template pins the image) and any nullish entries so the
 * persisted blob stays small.
 */
function stripEnsureOpts(opts: EnsureOptions): EnsureOptions | null {
  const out: EnsureOptions = {};
  if (opts.repo) out.repo = opts.repo;
  if (opts.workload) out.workload = opts.workload;
  if (opts.env && Object.keys(opts.env).length > 0) out.env = opts.env;
  if (opts.tenant) out.tenant = opts.tenant;
  // Stickiness: `resurrectByHandle` re-provisions from these opts with no
  // SANDBOX_START in the loop, so without this an autonomously recovered
  // sandbox would silently come back on the other binary — which makes any
  // incident on it unattributable. Callers persist the *resolved* impl.
  if (opts.daemonImpl) out.daemonImpl = opts.daemonImpl;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract the bare hostname `<handle>.<base>` from a preview URL pattern.
 * Reuses `applyPreviewPattern` to guarantee parity with the URL the runner
 * advertises in `Sandbox.previewUrl` — drift between "URL the user sees"
 * and "hostname the gateway routes" would silently break iframe loading.
 * Returns null when the pattern doesn't parse as a URL (e.g. someone set
 * `{handle}/foo` without a scheme).
 */
function previewHostnameForHandle(
  pattern: string,
  handle: string,
): string | null {
  try {
    return new URL(applyPreviewPattern(pattern, handle)).hostname || null;
  } catch {
    return null;
  }
}
