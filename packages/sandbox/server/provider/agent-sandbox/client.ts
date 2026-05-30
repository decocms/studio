/**
 * Low-level CRUD + readiness watch for agent-sandbox SandboxClaim / Sandbox.
 *
 * Talks to the k8s REST API directly via the runtime's native `fetch` with
 * `{ tls: { cert, key, ca } }`. Credentials (client cert + CA) are extracted
 * from the active `KubeConfig` context using the library's own
 * `applyToHTTPSOptions` helper.
 *
 * Why not `kc.makeApiClient(CustomObjectsApi)` like admin does:
 *   `@kubernetes/client-node` 1.x's generated clients ship an
 *   `IsomorphicFetchHttpLibrary` that calls `fetch(url, { agent })` — a
 *   node-fetch signal that Node's https.Agent (cert/key/ca) should be used
 *   for the TLS handshake. Bun's node-fetch polyfill silently drops the
 *   `agent` option: TLS verification fails and, if bypassed, the cluster
 *   sees `system:anonymous` (no client cert). The fix is Bun-native:
 *   `fetch(url, { tls: { cert, key, ca } })`. The library's Watch hits
 *   the same bug, so readiness is rebuilt from scratch here too.
 *
 * Surface intentionally minimal: create/delete/get/waitForReady. Higher-level
 * "ensure ready" flows live on the runner, not here.
 */

import {
  type KubeConfig,
  type V1Status as V1StatusUpstream,
} from "@kubernetes/client-node";
import {
  K8S_CONSTANTS,
  SandboxAlreadyExistsError,
  SandboxError,
  SandboxTimeoutError,
} from "./constants";

type V1Status = Partial<V1StatusUpstream> & { reason?: string };

/**
 * Subset of SandboxClaim `spec.env[]`. The CRD accepts only literal
 * `{name, value}` pairs — no `valueFrom`/`secretKeyRef`. That's why Stage 2.1
 * injects `DAEMON_TOKEN` here directly rather than via a Secret reference.
 */
export interface SandboxClaimEnvVar {
  name: string;
  value: string;
  containerName?: string;
}

export interface SandboxClaim {
  apiVersion: string;
  kind: "SandboxClaim";
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    sandboxTemplateRef: { name: string };
    env?: SandboxClaimEnvVar[];
    /**
     * Pod-level metadata the operator merges onto the spawned Pod (CRD field,
     * see sandboxclaims.extensions.agents.x-k8s.io v1alpha1). Used to attach
     * tenant labels for downstream metrics attribution.
     */
    additionalPodMetadata?: {
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    /**
     * `"none"` forces a fresh pod per claim — required when `spec.env` is
     * set because the operator rejects custom env when the claim would
     * come from a warm pool (warm pods are pre-started, can't take new
     * env). Passing `undefined` lets the CRD default ("default") apply.
     */
    warmpool?: "none" | "default" | string;
    lifecycle?: {
      shutdownTime?: string;
      shutdownPolicy?: "Delete" | "Retain";
    };
  };
}

export interface SandboxCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface SandboxResource {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /**
     * Set by the API server when a delete is in flight. While the resource
     * still has finalizers, GETs return the object with this field populated
     * and a Ready=False condition. The runner uses this to detect the
     * terminating window and avoid recreating into a 409 AlreadyExists.
     */
    deletionTimestamp?: string;
    /**
     * Finalizer keys the API server must see drained before it actually
     * removes the resource. Surfaced so the runner can log which controller
     * is blocking deletion when `waitForSandboxClaimGone` times out — that's
     * the difference between "operator is slow" and "operator is broken".
     */
    finalizers?: string[];
  };
  /**
   * Present when this came back from `getSandboxClaim` (CRD has a spec);
   * absent from Sandbox-kind resources because `waitForSandboxReady` only
   * projects out metadata/status. `adopt()` reads `spec.env` to recover the
   * per-claim DAEMON_TOKEN it originally injected.
   */
  spec?: {
    sandboxTemplateRef?: { name?: string };
    env?: SandboxClaimEnvVar[];
    lifecycle?: {
      shutdownTime?: string;
      shutdownPolicy?: "Delete" | "Retain";
    };
  };
  status?: {
    conditions?: SandboxCondition[];
    /**
     * SandboxClaim-only — set by the operator to the name of the Sandbox
     * the claim was bound to. For warm-pool claims this is the *pool*
     * pod's name (e.g. `studio-sandbox-kind-abcde`), NOT the claim name.
     * Source of truth for "which pod did the operator pick" — under the
     * v0.4.x adoption race, the operator can also create a same-named
     * cold-path Sandbox alongside the adopted pool one; only this status
     * field reliably points at the actually-bound pod.
     */
    sandbox?: {
      name?: string;
      podIPs?: string[];
    };
  };
}

type WatchEvent = {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";
  object: SandboxResource | V1Status;
};

// ---- Transport --------------------------------------------------------------

/** Resolved auth + TLS material for the active kubeconfig context. */
interface KubeAuth {
  server: string;
  headers: Record<string, string>;
  tls: {
    cert?: string;
    key?: string;
    ca?: string;
    rejectUnauthorized?: boolean;
  };
}

async function resolveKubeAuth(kc: KubeConfig): Promise<KubeAuth> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new SandboxError("No active cluster in kubeconfig");

  // `applyToHTTPSOptions` mutates a plain options object, threading through the
  // authenticator chain (token files, exec plugins, etc.). We harvest the bits
  // we care about — headers (bearer/impersonation), cert/key/ca — and discard
  // the `agent` it leaves behind since we route around node-fetch entirely.
  const opts: Record<string, unknown> = {};
  await kc.applyToHTTPSOptions(opts);

  const headers: Record<string, string> = {};
  const optHeaders = (opts.headers ?? {}) as Record<string, string | string[]>;
  for (const [k, v] of Object.entries(optHeaders)) {
    if (Array.isArray(v)) headers[k] = v.join(", ");
    else if (v !== undefined) headers[k] = String(v);
  }
  if (typeof opts.auth === "string" && !headers.Authorization) {
    headers.Authorization = `Basic ${Buffer.from(opts.auth).toString("base64")}`;
  }

  return {
    server: cluster.server.replace(/\/+$/, ""),
    headers,
    tls: {
      cert: bufferLike(opts.cert),
      key: bufferLike(opts.key),
      ca: bufferLike(opts.ca),
      rejectUnauthorized: cluster.skipTLSVerify ? false : undefined,
    },
  };
}

function bufferLike(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return String(v);
}

interface KubeFetchInit {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra Accept / query hints. Merged with auth headers. */
  headers?: Record<string, string>;
  /**
   * Required iff `method === "PATCH"`. Drives the patch content-type:
   *   - `merge`           — RFC 7396 merge-patch (default; CRDs).
   *   - `strategic-merge` — strategic-merge-patch (built-in types).
   *   - `apply`           — Server-Side Apply (declarative; tracks field
   *                         ownership via `?fieldManager=<name>`). Caller
   *                         is responsible for appending `fieldManager`
   *                         (and optionally `force=true`) to `path`.
   */
  patchType?: "merge" | "strategic-merge" | "apply";
}

/**
 * Thin wrapper around `fetch` that threads TLS + auth from the kubeconfig.
 * Returns the raw `Response` so streaming callers (watch) can consume the
 * body themselves; non-streaming callers parse JSON explicitly.
 *
 * @internal Package-internal — re-exported only for sibling modules in this
 *   directory (e.g. lifecycle-watcher) that need the same transport. Not
 *   surfaced via `index.ts` and not part of the package's public API.
 *   External consumers must use `proxyDaemonRequest` or the runner methods.
 */
export async function kubeFetch(
  kc: KubeConfig,
  init: KubeFetchInit,
): Promise<Response> {
  const auth = await resolveKubeAuth(kc);
  const headers: Record<string, string> = { ...auth.headers, ...init.headers };
  if (init.method === "PATCH") {
    // SSA's canonical content-type is `application/apply-patch+yaml`; the
    // API server treats JSON as a strict YAML subset, so we serialize the
    // body as JSON and label it `+yaml` for compat with K8s <1.32 (the
    // `+json` variant only landed in 1.32).
    headers["content-type"] =
      init.patchType === "apply"
        ? "application/apply-patch+yaml"
        : init.patchType === "strategic-merge"
          ? "application/strategic-merge-patch+json"
          : "application/merge-patch+json";
  } else if (init.body !== undefined && !("content-type" in headers)) {
    headers["content-type"] = "application/json";
  }
  const reqInit: RequestInit & { tls?: typeof auth.tls } = {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    tls: auth.tls,
  };
  return fetch(`${auth.server}${init.path}`, reqInit as RequestInit);
}

/** HTTP error carrier used for the 404 fast-path before SandboxError wrapping. */
class KubeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: V1Status | null,
    message: string,
  ) {
    super(message);
    this.name = "KubeHttpError";
  }
}

async function readStatusBody(resp: Response): Promise<V1Status | null> {
  try {
    return (await resp.json()) as V1Status;
  } catch {
    return null;
  }
}

async function ensureOk(resp: Response, action: string): Promise<void> {
  if (resp.ok) return;
  const body = await readStatusBody(resp);
  const message =
    body?.message ?? `${action} failed: ${resp.status} ${resp.statusText}`;
  throw new KubeHttpError(resp.status, body, message);
}

/**
 * Issue a kube call where 404 is *not* an error (the resource was already
 * gone; mesh's next ensure() recreates it). On 404, returns `null`. On 2xx,
 * returns the parsed JSON body — or `null` for callers that don't need it.
 * All other errors are wrapped in `SandboxError` with `wrapMessage` as the
 * surfaced label.
 */
async function callSwallowing404<T>(
  kc: KubeConfig,
  init: KubeFetchInit,
  action: string,
  wrapMessage: string,
  parse: "json" | "none" = "none",
): Promise<T | null> {
  try {
    const resp = await kubeFetch(kc, init);
    if (resp.status === 404) return null;
    await ensureOk(resp, action);
    if (parse === "json") return (await resp.json()) as T;
    return null;
  } catch (error) {
    throw new SandboxError(wrapMessage, error);
  }
}

// ---- Public surface ---------------------------------------------------------

const CLAIM_PATH_PREFIX = `/apis/${K8S_CONSTANTS.CLAIM_API_GROUP}/${K8S_CONSTANTS.CLAIM_API_VERSION}/namespaces`;

export async function createSandboxClaim(
  kc: KubeConfig,
  namespace: string,
  claim: SandboxClaim,
): Promise<void> {
  const path = `${CLAIM_PATH_PREFIX}/${encodeURIComponent(namespace)}/${K8S_CONSTANTS.CLAIM_PLURAL}`;
  let resp: Response;
  try {
    resp = await kubeFetch(kc, { method: "POST", path, body: claim });
  } catch (error) {
    const causeMsg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[agent-sandbox/client] createSandboxClaim ${claim.metadata.name} transport error: ${causeMsg}`,
    );
    throw new SandboxError(
      `Failed to create SandboxClaim: ${claim.metadata.name} (transport error: ${causeMsg})`,
      error,
    );
  }
  if (resp.ok) return;
  // The status + reason + message must reach the surface — when the user
  // sees "Failed to create SandboxClaim" with no further context, we have no
  // way to tell whether this was a 409 finalizer-drain race (recoverable),
  // a 422 admission-webhook rejection (claim shape problem), a 403/RBAC, or
  // a stuck-terminating claim that the operator never finishes deleting.
  const body = await readStatusBody(resp);
  const reason = body?.reason ? ` ${body.reason}` : "";
  const detail = body?.message ?? resp.statusText;
  const summary = `Failed to create SandboxClaim: ${claim.metadata.name} (${resp.status}${reason}: ${detail})`;
  // Server-side log mirrors the surface error and adds the response body so
  // operators triaging an incident can tell which K8s subsystem rejected
  // the create even if the only artifact in front of them is the user's
  // toast/MCP response.
  console.warn(
    `[agent-sandbox/client] createSandboxClaim ${claim.metadata.name} rejected: status=${resp.status} reason=${body?.reason ?? "<none>"} message=${detail}`,
  );
  // 409 is split out so the runner can wait for the still-terminating prior
  // claim to drain finalizers and retry. This is the canonical race when the
  // operator's idle-TTL just reaped a claim and mesh's next ensure() hits
  // before the resource is fully GC'd. Stuck-finalizer cases also surface as
  // 409 but never recover from a wait — those need operator intervention.
  if (resp.status === 409) {
    throw new SandboxAlreadyExistsError(summary);
  }
  throw new SandboxError(summary);
}

/**
 * Poll until the named SandboxClaim no longer exists in the API server (i.e.
 * its DELETE has drained all finalizers and the API server has GC'd the
 * resource). Returns immediately if the claim is already gone.
 *
 * The agent-sandbox operator's idle-TTL deletes the claim, but pod teardown +
 * any per-claim finalizers can take several seconds. Recreating during that
 * window 409s; this helper bridges the gap so the runner's recreate path is
 * deterministic instead of probabilistic. Polling at 500ms keeps the recovery
 * latency low without hammering the API server (≤120 requests over a 60s
 * window).
 */
export async function waitForSandboxClaimGone(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 500;
  let lastClaim: SandboxResource | undefined;
  while (true) {
    const claim = await getSandboxClaim(kc, namespace, claimName).catch(
      () => undefined,
    );
    if (!claim) return;
    lastClaim = claim;
    if (Date.now() >= deadline) {
      // Include the deletionTimestamp + finalizer set in the error: a
      // stuck finalizer is the most plausible non-recoverable cause and
      // distinguishes "operator is slow" from "operator dropped the claim
      // on the floor and won't ever finish".
      const finalizers = lastClaim.metadata?.finalizers ?? [];
      const since = lastClaim.metadata?.deletionTimestamp ?? "<unknown>";
      throw new SandboxTimeoutError(
        `SandboxClaim ${claimName} still terminating after ${timeoutMs}ms (deletionTimestamp=${since}, finalizers=[${finalizers.join(", ")}])`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function claimPath(namespace: string, claimName: string): string {
  return `${CLAIM_PATH_PREFIX}/${encodeURIComponent(namespace)}/${K8S_CONSTANTS.CLAIM_PLURAL}/${encodeURIComponent(claimName)}`;
}

/**
 * Update the claim's idle-reap clock. The agent-sandbox operator honors
 * `spec.lifecycle.shutdownTime` with `shutdownPolicy: Delete`: once the
 * wall clock passes `shutdownTime`, the operator deletes the claim + pod.
 *
 * Mesh calls this on every `ensure()` hit so an active sandbox continuously
 * pushes its deadline forward; an abandoned one hits the deadline and the
 * operator reaps it. No mesh-side cron/reconcile needed.
 *
 * Uses merge-patch (RFC 7396), which is the documented patch format for
 * CRDs — strategic-merge only works on built-in types that ship merge
 * keys. 404 is swallowed because a deleted-since-lookup claim is not an
 * error from mesh's perspective; the caller's next ensure() will
 * re-provision.
 */
export async function patchSandboxClaimShutdown(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  shutdownTime: string,
): Promise<void> {
  await callSwallowing404(
    kc,
    {
      method: "PATCH",
      path: claimPath(namespace, claimName),
      patchType: "merge",
      body: {
        spec: { lifecycle: { shutdownPolicy: "Delete", shutdownTime } },
      },
    },
    "patchSandboxClaimShutdown",
    `Failed to patch SandboxClaim shutdownTime: ${claimName}`,
  );
}

export async function deleteSandboxClaim(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
): Promise<void> {
  await callSwallowing404(
    kc,
    { method: "DELETE", path: claimPath(namespace, claimName) },
    "deleteSandboxClaim",
    `Failed to delete SandboxClaim: ${claimName}`,
  );
}

export async function getSandboxClaim(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
): Promise<SandboxResource | undefined> {
  const found = await callSwallowing404<SandboxResource>(
    kc,
    { method: "GET", path: claimPath(namespace, claimName) },
    "getSandboxClaim",
    `Failed to get SandboxClaim: ${claimName}`,
    "json",
  );
  return found ?? undefined;
}

/**
 * Poll the SandboxClaim until `status.sandbox.name` is populated, returning
 * the bound Sandbox's name. The operator (v0.4.x) writes this in two paths:
 * cold-start (claim's own template-rendered Sandbox, name == claim name)
 * and warm-pool adoption (an existing pool Sandbox, name = pool pod's
 * generated name). Mesh must use this value, not the claim name, because
 * the v0.4.x adoption reconciler has a status-update conflict race that
 * sometimes also creates a stray same-named cold-path Sandbox alongside
 * the adopted pool one — only `status.sandbox.name` points at the
 * actually-bound pod.
 *
 * Polling beats a watch here because the status field flips a single time
 * shortly after claim creation; a long-lived stream isn't worth the
 * complexity for a sub-second wait. Default timeout 60s tolerates a
 * controller-pod restart in the middle of the create.
 */
export async function waitForClaimAdoptedSandbox(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  timeoutSeconds = 60,
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const intervalMs = 200;
  while (Date.now() < deadline) {
    const claim = await getSandboxClaim(kc, namespace, claimName).catch(
      () => undefined,
    );
    const name = claim?.status?.sandbox?.name;
    if (name) return name;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new SandboxTimeoutError(
    `SandboxClaim ${claimName} did not record an adopted Sandbox (status.sandbox.name) within ${timeoutSeconds}s`,
  );
}

// ---- HTTPRoute (Gateway API) ------------------------------------------------

/**
 * Minimal HTTPRoute shape for per-claim preview routing. Mirrors the v1
 * Gateway API surface, scoped to the fields the runner writes — listener
 * attachment via `parentRefs`, exact-host match via `hostnames`, and a
 * single same-namespace `backendRefs` to the operator-created Service.
 *
 * Cross-namespace backendRefs are deliberately not modeled: HTTPRoute and
 * Service both live in `agent-sandbox-system`, which avoids the
 * ReferenceGrant dance.
 */
export interface HttpRoute {
  apiVersion: string;
  kind: "HTTPRoute";
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    parentRefs: Array<{
      kind?: "Gateway";
      group?: "gateway.networking.k8s.io";
      name: string;
      namespace: string;
      sectionName?: string;
    }>;
    hostnames: string[];
    rules: Array<{
      backendRefs: Array<{
        group?: "";
        kind?: "Service";
        name: string;
        port: number;
      }>;
    }>;
  };
}

const HTTPROUTE_API_GROUP = "gateway.networking.k8s.io";
const HTTPROUTE_API_VERSION = "v1";
const HTTPROUTE_PLURAL = "httproutes";
const HTTPROUTE_PATH_PREFIX = `/apis/${HTTPROUTE_API_GROUP}/${HTTPROUTE_API_VERSION}/namespaces`;

function httpRoutePath(namespace: string, routeName: string): string {
  return `${HTTPROUTE_PATH_PREFIX}/${encodeURIComponent(namespace)}/${HTTPROUTE_PLURAL}/${encodeURIComponent(routeName)}`;
}

function httpRouteCollectionPath(namespace: string): string {
  return `${HTTPROUTE_PATH_PREFIX}/${encodeURIComponent(namespace)}/${HTTPROUTE_PLURAL}`;
}

/**
 * Create an HTTPRoute. 409 (AlreadyExists) is swallowed because the runner
 * calls this from both the fresh-provision path and the adopt-backfill
 * path — a pre-existing route from an earlier provision attempt is the
 * intended steady state, not an error.
 */
export async function createHttpRoute(
  kc: KubeConfig,
  namespace: string,
  route: HttpRoute,
): Promise<void> {
  try {
    const resp = await kubeFetch(kc, {
      method: "POST",
      path: httpRouteCollectionPath(namespace),
      body: route,
    });
    if (resp.status === 409) return;
    await ensureOk(resp, "createHttpRoute");
  } catch (error) {
    if (error instanceof KubeHttpError && error.status === 409) return;
    throw new SandboxError(
      `Failed to create HTTPRoute: ${route.metadata.name}`,
      error,
    );
  }
}

export async function deleteHttpRoute(
  kc: KubeConfig,
  namespace: string,
  routeName: string,
): Promise<void> {
  await callSwallowing404(
    kc,
    { method: "DELETE", path: httpRoutePath(namespace, routeName) },
    "deleteHttpRoute",
    `Failed to delete HTTPRoute: ${routeName}`,
  );
}

export async function getHttpRoute(
  kc: KubeConfig,
  namespace: string,
  routeName: string,
): Promise<HttpRoute | undefined> {
  const found = await callSwallowing404<HttpRoute>(
    kc,
    { method: "GET", path: httpRoutePath(namespace, routeName) },
    "getHttpRoute",
    `Failed to get HTTPRoute: ${routeName}`,
    "json",
  );
  return found ?? undefined;
}

export const HTTPROUTE_CONSTANTS = {
  API_GROUP: HTTPROUTE_API_GROUP,
  API_VERSION: HTTPROUTE_API_VERSION,
  PLURAL: HTTPROUTE_PLURAL,
} as const;

// ---- Service port patching -------------------------------------------------

/**
 * Field-manager identity asserted on Server-Side Apply calls. K8s tracks
 * ownership per-field by this string; reusing it across calls (and across
 * mesh restarts) is what lets the second SSA see "I already own ports[]"
 * and treat it as a no-op rather than a conflict.
 */
const SSA_FIELD_MANAGER = "mesh-sandbox-runner";

/**
 * Server-Side Apply a single named port onto a core Service. Establishes
 * `mesh-sandbox-runner` as the field manager for `spec.ports[name=daemon]`,
 * which prevents the operator's reconciler from silently reverting the
 * field on its next pass.
 *
 * Why this exists: agent-sandbox v0.4.x creates per-Sandbox Services with
 * `spec.ports: []` — the operator assumes callers reach pods via direct
 * pod-IP DNS (`<pod>.<svc>.<ns>.svc.cluster.local`). Istio's k8s service
 * registry only builds an upstream cluster when the Service has at least
 * one declared port. With an empty ports list, an HTTPRoute backed by that
 * Service is "Accepted" by the gateway controller but routes to nowhere:
 * Envoy returns 500 with no body, which the browser misreports as a CORS
 * error (because the empty 500 also has no `access-control-allow-origin`).
 *
 * Why SSA over strategic-merge-patch:
 *   - SSA establishes mesh as the *owner* of `spec.ports`. If a future
 *     operator revision performs a full Update of the Service (Get →
 *     mutate → Put), the API server rejects the conflicting write unless
 *     the operator explicitly forces — which would surface in operator
 *     logs as a managed-fields conflict rather than silently breaking
 *     routing in production.
 *   - Re-applying the same body is a guaranteed no-op (the API server
 *     diffs against our recorded managed-fields), so the call is safe
 *     to issue from both fresh provision and adopt-backfill paths
 *     without any caller-side "already applied?" check.
 *
 * `force=true` is set so the *first* apply takes ownership even if the
 * operator initially set `ports: []` under its own field manager. After
 * the first call, the API server records us as the owner and subsequent
 * applies are no-ops.
 *
 * 404 is NOT swallowed: a missing Service when we expected one indicates
 * a race against operator Service creation, which the caller should
 * surface and potentially retry.
 */
export async function ensureServicePort(
  kc: KubeConfig,
  namespace: string,
  serviceName: string,
  port: {
    name: string;
    port: number;
    targetPort: number;
    protocol?: "TCP" | "UDP";
  },
): Promise<void> {
  // SSA requires apiVersion + kind + metadata.name in the body so the API
  // server can resolve the target type without reading it from the path.
  const body = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: serviceName },
    spec: {
      ports: [
        {
          name: port.name,
          port: port.port,
          targetPort: port.targetPort,
          protocol: port.protocol ?? "TCP",
        },
      ],
    },
  };
  const query = new URLSearchParams({
    fieldManager: SSA_FIELD_MANAGER,
    force: "true",
  });
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(serviceName)}?${query}`;
  try {
    const resp = await kubeFetch(kc, {
      method: "PATCH",
      path,
      patchType: "apply",
      body,
    });
    await ensureOk(resp, "ensureServicePort");
  } catch (error) {
    throw new SandboxError(
      `Failed to apply Service ports: ${serviceName}`,
      error,
    );
  }
}

export interface WaitForSandboxReadyResult {
  sandboxName: string;
  podName: string;
}

/**
 * Resolves on the first `Ready=True` condition on the Sandbox matching
 * `claimName`; rejects on stream error, missing name metadata, or timeout.
 * The watch is aborted exactly once via `settle()`; callers get deterministic
 * teardown regardless of which branch fires first.
 */
export function waitForSandboxReady(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  timeoutSeconds = 180,
): Promise<WaitForSandboxReadyResult> {
  const path = `/apis/${K8S_CONSTANTS.SANDBOX_API_GROUP}/${K8S_CONSTANTS.SANDBOX_API_VERSION}/namespaces/${encodeURIComponent(namespace)}/${K8S_CONSTANTS.SANDBOX_PLURAL}?watch=true&fieldSelector=${encodeURIComponent(`metadata.name=${claimName}`)}`;

  const { resolve, reject, promise } =
    Promise.withResolvers<WaitForSandboxReadyResult>();

  const controller = new AbortController();
  let settled = false;
  const timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    controller.abort();
    reject(
      new SandboxTimeoutError(
        `Sandbox did not become ready within ${timeoutSeconds} seconds`,
      ),
    );
  }, timeoutSeconds * 1000);

  const settleWith = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);
    controller.abort();
    fn();
  };

  (async () => {
    let resp: Response;
    try {
      resp = await kubeFetch(kc, {
        method: "GET",
        path,
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      settleWith(() =>
        reject(
          new SandboxError("Failed to start watch for sandbox readiness", err),
        ),
      );
      return;
    }

    if (!resp.ok || !resp.body) {
      const body = await readStatusBody(resp).catch(() => null);
      settleWith(() =>
        reject(
          new SandboxError(
            `Watch handshake failed (${resp.status}): ${body?.message ?? resp.statusText}`,
          ),
        ),
      );
      return;
    }

    try {
      for await (const event of readNdJson<WatchEvent>(resp.body)) {
        if (settled) return;
        // Bookmark/ERROR/DELETED are never a "ready" signal. ERROR carries a
        // V1Status payload rather than a SandboxResource; treating it as a
        // fatal stream error mirrors client-go's behaviour.
        if (event.type === "ERROR") {
          const status = event.object as V1Status;
          settleWith(() =>
            reject(
              new SandboxError(
                `Watch stream error while waiting for sandbox: ${status.message ?? "unknown"}`,
              ),
            ),
          );
          return;
        }
        if (event.type !== "ADDED" && event.type !== "MODIFIED") continue;

        const sandbox = event.object as SandboxResource;
        const ready = sandbox.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True",
        );
        if (!ready) continue;

        const sandboxName = sandbox.metadata?.name;
        if (!sandboxName) {
          settleWith(() =>
            reject(new SandboxError("Sandbox metadata or name is missing")),
          );
          return;
        }
        const podName =
          sandbox.metadata?.annotations?.[K8S_CONSTANTS.POD_NAME_ANNOTATION] ??
          sandboxName;
        settleWith(() => resolve({ sandboxName, podName }));
        return;
      }
      // Stream ended before Ready observed — treat as transient failure so the
      // caller can retry rather than wait out the timeout.
      settleWith(() =>
        reject(
          new SandboxError("Watch stream closed before sandbox became ready"),
        ),
      );
    } catch (err) {
      if (settled) return;
      // AbortError during in-flight stream is the timeout path above; don't
      // double-reject.
      if (
        err instanceof Error &&
        (err.name === "AbortError" || controller.signal.aborted)
      )
        return;
      settleWith(() =>
        reject(
          new SandboxError("Watch stream error while waiting for sandbox", err),
        ),
      );
    }
  })();

  return promise;
}

/**
 * ND-JSON line reader over a WHATWG ReadableStream.
 *
 * @internal Package-internal — sibling modules (lifecycle-watcher) consume the
 *   same kube watch streams and parse them this way. Not exposed via
 *   `index.ts` and not part of the package's public API.
 */
export async function* readNdJson<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let newline: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line loop
      while ((newline = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, newline).trim();
        buf = buf.slice(newline + 1);
        if (!line) continue;
        yield JSON.parse(line) as T;
      }
    }
    const tail = buf.trim();
    if (tail) yield JSON.parse(tail) as T;
  } finally {
    reader.releaseLock();
  }
}
