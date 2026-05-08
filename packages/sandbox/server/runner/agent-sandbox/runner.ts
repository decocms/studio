/**
 * Agent-sandbox runner.
 *
 * Provisions one SandboxClaim per (user, projectRef) against the
 * kubernetes-sigs/agent-sandbox operator. Mesh runs outside the cluster
 * (Stage 1 / local-dev via kind), so traffic reaches the pod via a single
 * lazily-opened 127.0.0.1 TCP listener that tunnels each inbound connection
 * to the daemon container port through the apiserver as a fresh WebSocket.
 *
 * The daemon owns the public surface: it serves `/_decopilot_vm/*` + `/health`
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
  daemonBash,
  postConfig,
  probeDaemonHealth,
  proxyDaemonRequest,
  waitForDaemonReady,
} from "../../daemon-client";
import {
  Inflight,
  applyPreviewPattern,
  buildConfigPayload,
  computeHandle as composeBranchHandle,
  withSandboxLock,
} from "../shared";
import type { RunnerStateStore, RunnerStateStoreOps } from "../state-store";
import type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxRunner,
  Workload,
} from "../types";
import {
  createHttpRoute,
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
import { watchClaimLifecycle } from "./lifecycle-watcher";
import type { ClaimPhase } from "../lifecycle-types";

const RUNNER_KIND = "agent-sandbox" as const;
const LOG_LABEL = "AgentSandboxRunner";

// Shared-namespace topology for MVP; tenancy enforced by unguessable claim
// names (sha256(userId:projectRef)). Per-org namespaces are deferred.
const DEFAULT_NAMESPACE = "agent-sandbox-system";
const DEFAULT_TEMPLATE_NAME = "studio-sandbox";

const DAEMON_CONTAINER_PORT = 9000;
// In-pod port the daemon's reverse proxy targets. Mesh never connects here
// directly — everything funnels through the daemon container port — but the
// value is propagated to the daemon via DEV_PORT so it knows where the dev
// server will bind.
const DEFAULT_DEV_PORT = 3000;
const DEFAULT_WORKDIR = "/app";

// 32 bytes matches Docker's generation so audit logs don't vary by runner.
const DAEMON_TOKEN_BYTES = 32;

/**
 * Env keys mesh owns and a caller's `opts.env` MUST NOT shadow. DAEMON_TOKEN
 * is the secrecy boundary; the rest configure the daemon's bootstrap (paths
 * + ports) — silently overriding any of them would break daemon startup.
 *
 * Workload (clone URL, branch, package manager, runtime, intent, dev port)
 * is no longer env-injected: it's POSTed to `/_decopilot_vm/config` after
 * the daemon comes up healthy. See `buildConfigPayload`.
 */
const RESERVED_ENV_KEYS = new Set([
  "DAEMON_TOKEN",
  "DAEMON_BOOT_ID",
  "APP_ROOT",
  "PROXY_PORT",
]);

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

/**
 * Handle shape: `<slug>-<hash5>` when a branch is supplied, `<hash5>`
 * otherwise — identical to the docker/host runners' default from
 * `composeBranchHandle` (re-exported as `computeHandle`). With
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
// (handle, containerPort) pair → same host port across mesh restarts, so
// `previewUrl` cached in the thread's vmMap stays valid when the mesh
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
}

interface K8sRecord {
  id: SandboxId;
  handle: string;
  /**
   * The Sandbox CR the operator actually bound to this claim, taken from
   * `claim.status.sandbox.name`. Equals `handle` on cold-start (operator
   * names cold Sandboxes after the claim) but diverges on warm-pool
   * adoption — pool sandboxes carry their generated names like
   * `studio-sandbox-kind-abcde`. Mesh routes preview traffic via the
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
   * Per-boot UUID the daemon reports on /health. Generated mesh-side and
   * injected via env; re-read from /health on rehydrate so we pick up
   * pod restarts (the daemon's orchestrator handles resume-on-restart
   * itself, this is purely informational on the mesh side).
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
   * that case so the caller's normal VM_START flow can repopulate them.
   */
  ensureOpts: EnsureOptions | null;
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
   * VM_START reprovision flow then runs with full opts).
   */
  ensureOpts?: EnsureOptions;
  [k: string]: unknown;
}

export interface AgentSandboxRunnerOptions {
  stateStore?: RunnerStateStore;
  previewUrlPattern?: string;
  /** Defaults to `new KubeConfig().loadFromDefault()`. Tests pass a stub. */
  kubeConfig?: KubeConfig;
  /** Shared namespace for both SandboxTemplate and SandboxClaims. */
  namespace?: string;
  /** SandboxTemplate all claims reference. */
  sandboxTemplateName?: string;
  /**
   * Shared sentinel token baked into the SandboxTemplate's pod env (via the
   * sandbox-env helm chart's Secret). Presence flips the runner into
   * warm-pool mode:
   *   - claims are created with `warmpool: "default"` and `spec.env: []`
   *     (the operator rejects per-claim env when warmpool != "none"),
   *   - mesh's first contact with the daemon authenticates with the
   *     sentinel and rotates to a per-claim token via
   *     `auth.rotateToken` on POST /_decopilot_vm/config,
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
   * other mesh→daemon request.
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
   * undefined; mesh wires `metrics.getMeter("mesh", "1.0.0")`.
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
   * mesh's in-process proxy (the previous design), provided someone else
   * (the chart, an operator, hand-rolled YAML) has wired a wildcard
   * HTTPRoute backed by mesh.
   */
  previewGateway?: {
    name: string;
    namespace: string;
  };
}

export class AgentSandboxRunner implements SandboxRunner {
  readonly kind = RUNNER_KIND;

  private readonly records = new Map<string, K8sRecord>();
  private readonly inflight = new Inflight<string, Sandbox>();
  private readonly stateStore: RunnerStateStore | null;
  private readonly previewUrlPattern: string | null;
  private readonly kubeConfig: KubeConfig;
  private readonly portForward: PortForward;
  private readonly namespace: string;
  private readonly sandboxTemplateName: string;
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
   * Non-null = warm-pool mode (see `AgentSandboxRunnerOptions.sentinelToken`).
   * Treated as the bearer token for the *first* daemon contact only;
   * mesh rotates to a per-claim token via `auth.rotateToken` immediately
   * after, and persists the new token. Empty/whitespace strings are
   * collapsed to null at construction so a misconfigured env var doesn't
   * silently flip modes with an unusable token.
   */
  private readonly sentinelToken: string | null;
  private closed = false;

  constructor(opts: AgentSandboxRunnerOptions = {}) {
    this.stateStore = opts.stateStore ?? null;
    this.previewUrlPattern = opts.previewUrlPattern ?? null;
    this.kubeConfig = opts.kubeConfig ?? loadDefaultKubeConfig();
    this.portForward = new PortForward(this.kubeConfig);
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.sandboxTemplateName =
      opts.sandboxTemplateName ?? DEFAULT_TEMPLATE_NAME;
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
  }

  // ---- SandboxRunner surface ------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // Branch is the slug source; absent when caller didn't pass `repo`
    // (tool-only sandboxes, smoke tests). The shared computeHandle falls
    // back to a bare hash in that case, preserving stable identity.
    const handle = this.computeHandle(id, opts.repo?.branch ?? null);
    return this.inflight.run(handle, () =>
      withSandboxLock(this.stateStore, id, RUNNER_KIND, (ops) =>
        this.ensureLocked(id, handle, opts, ops),
      ),
    );
  }

  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const rec = await this.requireRecord(handle);
    return daemonBash(rec.daemonUrl, rec.token, input);
  }

  async delete(handle: string): Promise<void> {
    const rec = await this.getRecord(handle);
    this.records.delete(handle);
    if (rec) {
      this.closeForwarder(rec.daemonForward);
      // Decrement only when we actually held the record — getRecord can be
      // null after restart-without-state-store, in which case the gauge
      // was never incremented for this handle in this process.
      this.metrics?.active.add(-1, tenantAttrs(rec.tenant));
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
   * Used by mesh's lifecycle SSE route to surface what's happening between
   * `VM_START` posting a claim and the daemon SSE coming online.
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
    const rec = await this.getRecord(handle);

    // rehydrate failed (port-forward is pod-local); route via in-cluster Service instead.
    if (!rec && this.previewUrlPattern && this.stateStore) {
      const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
      const state = row?.state as Partial<PersistedK8sState> | undefined;
      const token = state?.token;
      if (row && token) {
        const adoptedName = state?.adoptedSandboxName ?? handle;
        const daemonUrl = `http://${adoptedName}.${this.namespace}.svc.cluster.local:${DAEMON_CONTAINER_PORT}`;
        return proxyDaemonRequest(daemonUrl, token, path, init);
      }
    }

    if (!rec) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const start = performance.now();
    let status = 0;
    try {
      const resp = await proxyDaemonRequest(
        rec.daemonUrl,
        rec.token,
        path,
        init,
      );
      status = resp.status;
      return resp;
    } finally {
      this.recordProxyDuration(
        "daemon",
        status,
        rec,
        performance.now() - start,
      );
    }
  }

  /**
   * Resolves the HTTP base URL for a sandbox's daemon. Used by the preview
   * reverse-proxy at the mesh edge.
   *
   * Two modes:
   * 1. `previewUrlPattern` set (Stage 3 / in-cluster mesh): synthesize the
   *    in-cluster Service URL straight from the handle. No record lookup, no
   *    port-forward, no health probe — the cluster DNS + downstream fetch
   *    are the source of truth. Crucially this means a cold mesh pod (or one
   *    that just restarted with an empty records map) still serves preview
   *    traffic without first having to rehydrate every claim. If the Service
   *    doesn't exist for that handle, the downstream fetch fails and the
   *    caller surfaces a 502.
   * 2. `previewUrlPattern` unset (dev / mesh-outside-cluster): fall back to
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
      // Records cache hit is O(1); cache miss (cold mesh) falls through to
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
   * Service), but the only path that lands here is "mesh just restarted
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
   * `/_decopilot_vm/*` access policy at the edge:
   *   - **GET** is allowed through. The daemon's `/events` SSE and `/scripts`
   *     are intentionally unauthenticated and CORS-enabled (`Allow-Origin: *`)
   *     because the studio UI consumes them cross-origin from the preview
   *     URL — that's the only path it has to live setup state. Stripping
   *     them here would break the studio UI's setup tab and SSE event feed.
   *   - **Non-GET** (POST/PUT/DELETE/etc) is rejected as defense-in-depth.
   *     The daemon enforces bearer auth on the mutating endpoints
   *     (read/write/edit/grep/glob/bash/exec/kill), but the only legitimate
   *     caller for those is mesh itself via the internal port-forward; the
   *     preview surface should never see them.
   */
  async proxyPreviewRequest(
    handle: string,
    request: Request,
  ): Promise<Response> {
    const start = performance.now();
    // In-memory cache only — preview is the hot path; a state-store hit per
    // request would dominate latency. Tenant attribution is best-effort: when
    // the records map is cold (mesh just restarted) the metric still records
    // duration with empty tenant attrs. cAdvisor on the pod side covers
    // bandwidth attribution authoritatively via pod labels.
    const cachedRec = this.records.get(handle) ?? null;
    let status = 0;
    try {
      const upstreamBase = await this.resolvePreviewUpstreamUrl(handle);
      if (!upstreamBase) {
        status = 404;
        return jsonResponse(404, { error: "sandbox not found" });
      }

      const reqUrl = new URL(request.url);
      const isAdminPath =
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
        // mesh stdout → kubectl logs → log aggregator.
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
        return jsonResponse(502, { error: "sandbox daemon unreachable" });
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
        if (rec)
          return this.finish(
            rec,
            ops,
            /* persistNow */ false,
            /* patchTtl */ true,
            "resume",
          );
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
        if (adopted)
          return this.finish(
            adopted,
            ops,
            /* persistNow */ true,
            /* patchTtl */ true,
            "adopt",
          );
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
    const wasCached = this.records.has(rec.handle);
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
      const attrs = tenantAttrs(rec.tenant);
      this.metrics.ensureOutcome.add(1, { ...attrs, outcome });
      // Only increment the active gauge on first observation to avoid
      // double-counting when the same handle is rehydrated multiple times
      // (mesh-process internal cache hit; ensureLocked is invoked again).
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
    // warmpool != "none". Mesh delivers the per-claim secret post-bind via
    // POST /_decopilot_vm/config + auth.rotateToken instead.
    const warmPoolMode = this.sentinelToken !== null;
    const envEntries = warmPoolMode
      ? []
      : Object.entries(this.buildEnvMap(opts, boot))
          // Sorted so `kubectl diff` doesn't churn across runs that pass the
          // same env in different insertion orders.
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => ({ name, value }));
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
          ...(this.envName ? { [LABEL_KEYS.env]: this.envName } : {}),
          ...buildTenantLabels(opts.tenant),
        },
      },
      spec: {
        sandboxTemplateRef: { name: this.sandboxTemplateName },
        // additionalPodMetadata.labels is the operator's pod-label propagation
        // hook (CRD field, not a generic patch). Tenant labels here flow to
        // the pod and become joinable in cAdvisor/kubelet metrics. `role`
        // distinguishes claimed pods from warm-pool pods (template sets
        // role=sandbox-pod by default).
        additionalPodMetadata: {
          labels: buildTenantLabels(opts.tenant, {
            [LABEL_KEYS.role]: "claimed",
            [LABEL_KEYS.sandboxHandle]: handle,
            ...(this.envName ? { [LABEL_KEYS.env]: this.envName } : {}),
          }),
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
      // concurrent ensure() from another mesh replica raced ours to create,
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
    const configPayload = buildConfigPayload({
      runtime: opts.workload?.runtime ?? "node",
      packageManager: opts.workload?.packageManager
        ? {
            name: opts.workload.packageManager,
            ...(opts.workload.packageManagerPath
              ? { path: opts.workload.packageManagerPath }
              : {}),
          }
        : null,
      repo: opts.repo ?? null,
      port: opts.workload?.devPort ?? DEFAULT_DEV_PORT,
    });
    // Warm-pool path: pod boots with the SandboxTemplate's sentinel token;
    // mesh authenticates the first /config call with the sentinel and
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
      ensureOpts: stripEnsureOpts(opts),
    };
  }

  /**
   * No-op when `previewGateway` isn't configured. Otherwise Server-Side
   * Apply port 9000 (named "daemon") onto the operator-created Service
   * for the *adopted* Sandbox. The agent-sandbox operator (v0.4.x) ships
   * Services with empty `spec.ports`, which makes Istio refuse to register
   * an upstream cluster — `ensureServicePort` doc has the full rationale.
   * Idempotent: once mesh owns `spec.ports[name=daemon]` (first SSA),
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
   * No-op when `previewGateway` isn't configured. Otherwise PUT-or-create
   * an HTTPRoute that maps `<handle>.<base>` → Service `<adoptedSandboxName>`
   * port 9000. createHttpRoute swallows 409, so this is safe to call from
   * both fresh-provision and adopt-backfill paths.
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
    await createHttpRoute(this.kubeConfig, this.namespace, route);
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

    // Pod bounced but the daemon's orchestrator handles re-bootstrap itself
    // on boot (resume-on-restart). Just refresh our copy of bootId.
    if (state.daemonBootId && state.daemonBootId !== live.bootId) {
      console.warn(
        `[${LOG_LABEL}] daemon restart detected (handle=${handle}): stored bootId=${state.daemonBootId} live bootId=${live.bootId}`,
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
    // allocates a fresh one, and mesh rotates a new token onto it.
    if (this.sentinelToken !== null) return null;
    const token = readClaimDaemonToken(claim);
    if (!token) return null;

    const live = await this.openAndProbeDaemon(adoptedSandboxName, handle);
    if (!live) return null;

    const tenant = readClaimTenant(claim);
    // Backfill the Service port + HTTPRoute for legacy claims provisioned
    // before per-claim routing existed. Both calls are idempotent — Service
    // patch is a no-op once `port: 9000` is already declared, and
    // createHttpRoute swallows 409. Failures here don't block adoption:
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
      // deterministic name still exists in the cluster (e.g. mesh restart
      // without state-store, or state-store wipe). The original opts aren't
      // recoverable from the claim alone, so resurrection on this record
      // can't autonomously re-provision; falls back to the caller's
      // VM_START path.
      ensureOpts: null,
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
   *    notFound→VM_START flow re-supplies opts in that case.
   */
  private async resurrectByHandle(handle: string): Promise<K8sRecord | null> {
    if (!this.stateStore) return null;
    const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!row) return null;
    const persistedOpts = (row.state as Partial<PersistedK8sState>).ensureOpts;
    if (!persistedOpts) return null;
    // ensure() is idempotent + advisory-locked, so concurrent resurrections
    // for the same handle collapse to a single provision. The lock is keyed
    // on (userId, projectRef, kind), the same identity our state-store row
    // is keyed on.
    await this.ensure(row.id, persistedOpts);
    return this.records.get(handle) ?? null;
  }

  private async requireRecord(handle: string): Promise<K8sRecord> {
    const rec = await this.getRecord(handle);
    if (rec) return rec;
    const resurrected = await this.resurrectByHandle(handle);
    if (resurrected) return resurrected;
    throw new Error(`unknown sandbox handle ${handle}`);
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
      ...tenantAttrs(rec?.tenant ?? null),
      source,
      sandbox_handle: rec?.handle ?? fallbackHandle ?? "",
      status_code: statusCode || 0,
    });
  }

  // ---- Identity + preview URL ----------------------------------------------

  private computeHandle(id: SandboxId, branch: string | null): string {
    // hashLen=16 (~64 bits) per handle.ts: runners that expose the handle as
    // a public hostname must use longer hashes to resist brute-force. Also
    // prevents DB handle collisions across users on the no-branch path.
    return composeBranchHandle(id, branch, { hashLen: 16 });
  }

  // Local mode: route preview traffic through the daemon port-forward, not
  // a separate dev forwarder. The daemon serves /_decopilot_vm/* + /health
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
    // recreation (operator-driven): vmMap's cached previewUrl stays valid.
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
          `[${LOG_LABEL}] port-forward to ${podName}:${containerPort} failed: ${err instanceof Error ? err.message : String(err)}`,
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
        "Active sandbox count, by runner kind and owning org. Cross-checks the cAdvisor-derived count from the cluster — divergence between the two indicates orphaned claims (mesh deleted but K8s didn't reap) or unattributed pods.",
      unit: "{sandbox}",
    }),
    ensureOutcome: meter.createCounter("studio.sandbox.ensure.outcome", {
      description:
        "Outcome of each ensure() call: fresh provision, resume from state-store after restart, or adopt of a cluster-side claim mesh didn't know about. Cold-start ratio is the primary input for warm-pool sizing.",
      unit: "{call}",
    }),
    proxyDurationMs: meter.createHistogram("studio.sandbox.proxy.duration_ms", {
      description:
        "Wall-clock latency of mesh-mediated requests to the sandbox daemon: tool exec proxies (source=daemon) and preview iframe traffic (source=preview).",
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
// (SSE at `/_decopilot_vm/events`, plus the EventSource probeMissing fetch);
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

// K8s label keys mesh attaches. Centralized so writers (buildTenantLabels)
// and the reader (readClaimTenant) can't drift.
const LABEL_KEYS = {
  role: "studio.decocms.com/role",
  sandboxHandle: "studio.decocms.com/sandbox-handle",
  orgId: "studio.decocms.com/org-id",
  userId: "studio.decocms.com/user-id",
  env: "studio.decocms.com/env",
} as const;

// K8s label values: ≤63 chars, must match `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`.
// Org/user IDs are UUIDs in mesh and pass through unchanged; the regex check
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
      `AgentSandboxRunner: envName=${JSON.stringify(trimmed)} is not a valid DNS-label-safe environment name (lowercase alphanumeric or '-', starts with a letter, ends alphanumeric, ≤32 chars). Mesh sets this from STUDIO_ENV; check the studio chart's configMap.`,
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

/** Read tenant back from a claim's metadata.labels (adopt path). */
function readClaimTenant(claim: SandboxResource): RunnerTenant | null {
  const labels = claim.metadata?.labels;
  if (!labels) return null;
  const orgId = labels[LABEL_KEYS.orgId];
  const userId = labels[LABEL_KEYS.userId];
  if (!orgId || !userId) return null;
  return { orgId, userId };
}

/**
 * Convert tenant struct to OTel attribute keys. `runner_kind` is constant for
 * a given runner instance but included on every attrs set so downstream
 * dashboards can pivot across runners (k8s vs docker) without re-aggregating.
 */
function tenantAttrs(tenant: RunnerTenant | null): {
  org_id: string;
  user_id: string;
  runner_kind: string;
} {
  return {
    org_id: tenant?.orgId ?? "",
    user_id: tenant?.userId ?? "",
    runner_kind: RUNNER_KIND,
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
