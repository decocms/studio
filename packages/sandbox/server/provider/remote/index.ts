/**
 * Hosted sandbox provider over the sandbox controller's MCP tools.
 *
 * The controller answers where a sandbox's daemon is and which bearer opens
 * it, and keeps every sandbox's state in its own database; the daemon traffic
 * itself goes straight from Studio to the pod, so streaming bodies, SSE and
 * preview websockets never take a second hop. Every controller call is mTLS
 * with Studio's client certificate.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  type SandboxImage,
  SandboxImageSchema,
} from "@decocms/shared/git-providers";
import type {
  CapacityRequest,
  Daemon,
  EnsureRequest,
  HandleRequest,
  LifetimeRequest,
  Phase,
  StatusRequest,
  TenantPoolsPushRequest,
} from "../../../controller-types/sandbox-api";
import {
  PathMCP,
  ToolCapacity,
  ToolDelete,
  ToolEnsure,
  ToolImages,
  ToolLifetime,
  ToolStatus,
  ToolTenantPoolsPush,
  ToolWatch,
} from "../../../controller-types/sandbox-api";
import {
  ConfigRequestError,
  proxyDaemonRequest as fetchDaemon,
} from "../../daemon-client";
import type { ClaimPhase } from "../lifecycle-types";
import type { HostedSandboxProvider } from "../hosted";
import { computeHandle } from "../shared";
import {
  PREVIEW_NOT_READY_HEADER,
  PREVIEW_STRIP_REQUEST_HEADERS,
  PREVIEW_STRIP_RESPONSE_HEADERS,
  previewJsonResponse,
} from "../shared/preview-proxy";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
} from "../types";
import {
  capacityResponseSchema,
  deleteResponseSchema,
  emptySchema,
  ensureResponseSchema,
  errorResponseSchema,
  imagesResponseSchema,
  phaseSchema,
  statusResponseSchema,
  tenantPoolsPushResponseSchema,
} from "./schemas";

export {
  cloneUrlRequestSchema,
  orgFsConfigRequestSchema,
} from "./schemas";
export {
  CloneURLPath,
  OrgFsConfigPath,
} from "../../../controller-types/sandbox-api";

const LOG_LABEL = "RemoteSandboxProvider";

/** Bounds every controller call except ensure and watch, which the controller bounds on progress. */
const CONTROL_TIMEOUT_MS = 30_000;
/** Above the controller's own delete deadline, after which it answers draining. */
const DELETE_TIMEOUT_MS = 90_000;
/**
 * The MCP client always arms a request timeout; this one never fires. It is
 * setTimeout's ceiling, since a larger delay fires at once.
 */
const UNBOUNDED_MS = 2 ** 31 - 1;
/** Same reuse window as the in-process capacity probe. */
const CAPACITY_TTL_MS = 3_000;
/** A cached daemon address is re-read after this; a 401 or a dead url re-reads it sooner. */
const DAEMON_CACHE_TTL_MS = 5 * 60_000;
const DAEMON_CACHE_MAX = 5_000;

export interface RemoteSandboxProviderOptions {
  /** e.g. `https://sandbox-controller.agent-sandbox-system.svc:8443`. */
  baseUrl: string;
  /**
   * PEM contents: Studio's certificate and key, presented to the controller,
   * and the CA its server certificate must chain to.
   */
  tls?: { cert: string; key: string; ca: string };
}

/** A failed controller call, with the controller's error code. */
export class SandboxControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxControllerError";
  }
}

/** A delete outlived the controller's deadline: retry, never treat it as gone. */
export class SandboxDrainingError extends Error {
  constructor(readonly handle: string) {
    super(`sandbox ${handle} is still draining; retry the delete`);
    this.name = "SandboxDrainingError";
  }
}

type CallOptions = {
  /** Null leaves the call to the controller's own progress bound. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onprogress?: (progress: Progress) => void;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failed call's text content as the error its ErrorResponse names. */
function failure(tool: string, text: string): Error {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the SDK's own wording, e.g. a schema violation */
  }
  const parsed = errorResponseSchema.safeParse(body);
  if (!parsed.success) {
    return new SandboxControllerError(
      "internal",
      `sandbox controller ${tool} failed: ${text.slice(0, 300)}`,
    );
  }
  const err = parsed.data;
  // start.ts words this one for the agent: the pod refused the handshake,
  // the claim was released, and a retry gets another pod.
  if (err.code === "bootstrap-rejected") {
    return new ConfigRequestError(err.status ?? 502, err.error);
  }
  const reasons = err.reasons
    ? ` (${Object.entries(err.reasons)
        .map(([rt, why]) => `${rt}: ${why}`)
        .join("; ")})`
    : "";
  return new SandboxControllerError(
    err.code,
    `sandbox controller ${tool}: ${err.error}${reasons}`,
  );
}

/** A sandbox the controller does not know reads as absent. */
function nullWhenUnknown(err: unknown): null {
  if (err instanceof SandboxControllerError && err.code === "unknown-handle") {
    return null;
  }
  throw err;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const first: unknown = content[0];
  return typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
    ? first.text
    : "";
}

export class RemoteSandboxProvider implements HostedSandboxProvider {
  private readonly endpoint: URL;
  private readonly tls: RemoteSandboxProviderOptions["tls"];
  private connecting: Promise<Client> | null = null;
  private readonly daemons = new Map<string, { daemon: Daemon; at: number }>();
  private capacity: { value: boolean; at: number } | null = null;
  private capacityInFlight: Promise<boolean> | null = null;

  constructor(opts: RemoteSandboxProviderOptions) {
    this.endpoint = new URL(
      PathMCP,
      `${new URL(opts.baseUrl).toString().replace(/\/$/, "")}/`,
    );
    this.tls = opts.tls;
  }

  // ---- Transport ------------------------------------------------------------

  /**
   * One client for every call: the controller is stateless, so the
   * initialize handshake runs once and a controller restart costs nothing.
   */
  private client(): Promise<Client> {
    this.connecting ??= (async () => {
      const client = new Client({ name: "studio", version: "1.0.0" });
      const tls = this.tls;
      const transport = new StreamableHTTPClientTransport(this.endpoint, {
        // Bun's own fetch timeout, off: ensure answers only once the daemon is
        // ready, and a watch is long-lived. Calls are bounded by CallOptions.
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            ...(tls ? { tls } : {}),
            timeout: false,
          } as BunFetchRequestInit),
      });
      await client.connect(transport, { timeout: CONTROL_TIMEOUT_MS });
      return client;
    })().catch((err: unknown) => {
      this.connecting = null;
      throw err;
    });
    return this.connecting;
  }

  /** Calls a tool and parses its output, or throws the error it names. */
  private async call<T>(
    tool: string,
    args: object,
    schema: z.ZodType<T>,
    opts: CallOptions = {},
  ): Promise<T> {
    const timeoutMs =
      opts.timeoutMs === undefined ? CONTROL_TIMEOUT_MS : opts.timeoutMs;
    const result = await (await this.client()).callTool(
      { name: tool, arguments: { ...args } },
      undefined,
      {
        timeout: timeoutMs ?? UNBOUNDED_MS,
        signal: opts.signal,
        onprogress: opts.onprogress,
      },
    );
    if (result.isError) throw failure(tool, textOf(result.content));
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new SandboxControllerError(
        "internal",
        `sandbox controller ${tool} returned a malformed result: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  // ---- Daemon address cache -------------------------------------------------

  private cached(handle: string): Daemon | null {
    const entry = this.daemons.get(handle);
    if (!entry) return null;
    if (Date.now() - entry.at > DAEMON_CACHE_TTL_MS) {
      this.daemons.delete(handle);
      return null;
    }
    return entry.daemon;
  }

  private remember(handle: string, daemon: Daemon | null): void {
    this.daemons.delete(handle);
    if (!daemon) return;
    if (this.daemons.size >= DAEMON_CACHE_MAX) {
      const oldest = this.daemons.keys().next();
      if (!oldest.done) this.daemons.delete(oldest.value);
    }
    this.daemons.set(handle, { daemon, at: Date.now() });
  }

  /** Null when the controller has no such sandbox. */
  private async status(handle: string, resurrect = false) {
    const args: StatusRequest = { handle, resurrect };
    const status = await this.call(ToolStatus, args, statusResponseSchema, {
      // Resurrecting provisions; the controller bounds it on progress.
      timeoutMs: resurrect ? null : CONTROL_TIMEOUT_MS,
    }).catch(nullWhenUnknown);
    this.remember(handle, status?.alive ? status.daemon : null);
    return status;
  }

  /**
   * The daemon to dial: cached, else re-read. A miss resurrects, as the
   * in-process runner does on a cold record: the idle TTL may have reaped the
   * claim under a caller that still needs it.
   */
  private async daemonFor(
    handle: string,
    refresh = false,
  ): Promise<Daemon | null> {
    if (!refresh) {
      const hit = this.cached(handle);
      if (hit) return hit;
    }
    const status = await this.status(handle, true);
    return status?.alive ? status.daemon : null;
  }

  // ---- Lifecycle ------------------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // Studio derives handles so preview routing can recompute them without a
    // database read; the controller never derives one.
    const handle = computeHandle(id);
    if (handle.startsWith("s-")) {
      throw new Error(
        `ensure: projectRef has no slug source: ${id.projectRef}`,
      );
    }
    const { image: _templatePinned, ...wireOpts } = opts;
    const args: EnsureRequest = { id, handle, opts: wireOpts };
    const out = await this.call(ToolEnsure, args, ensureResponseSchema, {
      timeoutMs: null,
    });
    if (out.handle !== handle) {
      throw new SandboxControllerError(
        "internal",
        `sandbox controller answered ensure ${handle} for ${out.handle}`,
      );
    }
    if (out.image.served !== out.image.requested) {
      console.warn(
        `[${LOG_LABEL}] ${handle}: image ${out.image.requested} unavailable, running on ${out.image.served}`,
      );
    }
    if (out.runtimeMismatch) {
      console.warn(
        `[${LOG_LABEL}] ${handle} lives on runtime ${out.runtimeMismatch}, not the one requested`,
      );
    }
    this.remember(handle, out.daemon);
    return {
      handle: out.handle,
      workdir: out.workdir,
      previewUrl: out.previewUrl,
      warmPoolAdopted: out.warmPoolAdopted,
    };
  }

  /**
   * Waits for the controller to collect the sandbox. Draining means the claim
   * outlived the controller's deadline: that throws, so a caller rebinding
   * never provisions a second daemon beside it.
   */
  async delete(handle: string): Promise<void> {
    this.daemons.delete(handle);
    const args: HandleRequest = { handle };
    const out = await this.call(ToolDelete, args, deleteResponseSchema, {
      timeoutMs: DELETE_TIMEOUT_MS,
    }).catch(nullWhenUnknown);
    if (out?.state === "draining") throw new SandboxDrainingError(handle);
  }

  async alive(handle: string): Promise<boolean> {
    return (await this.status(handle))?.alive ?? false;
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    return (await this.status(handle))?.previewUrl ?? null;
  }

  async lastTermination(handle: string): Promise<PodTermination | null> {
    return (await this.status(handle))?.lastTermination ?? null;
  }

  /**
   * Best-effort like the in-process runner's: a missed renewal or release
   * costs idle minutes, never a run, and a gone sandbox stays gone.
   */
  private async lifetime(args: LifetimeRequest, what: string): Promise<void> {
    const { handle } = args;
    try {
      await this.call(ToolLifetime, args, emptySchema).catch(nullWhenUnknown);
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] ${what} failed for ${handle}: ${errMsg(err)}`,
      );
    }
  }

  renewTtl(handle: string): Promise<void> {
    return this.lifetime({ handle, extendToIdleWindow: true }, "TTL renew");
  }

  releaseAfter(handle: string, graceMs: number): Promise<void> {
    return this.lifetime(
      { handle, graceMs: Math.max(0, Math.round(graceMs)) },
      "release",
    );
  }

  /**
   * Admission gate, fail-open like the in-process probe: a broken probe must
   * not park every run. Answers are reused briefly and concurrent callers
   * share one request.
   */
  hasSchedulableCapacity(): Promise<boolean> {
    const cached = this.capacity;
    if (cached && Date.now() - cached.at < CAPACITY_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    this.capacityInFlight ??= this.readCapacity().finally(() => {
      this.capacityInFlight = null;
    });
    return this.capacityInFlight;
  }

  private async readCapacity(): Promise<boolean> {
    let value = true;
    try {
      const args: CapacityRequest = {};
      value = (await this.call(ToolCapacity, args, capacityResponseSchema))
        .schedulable;
    } catch (err) {
      console.warn(`[${LOG_LABEL}] capacity probe failed: ${errMsg(err)}`);
    }
    this.capacity = { value, at: Date.now() };
    return value;
  }

  /**
   * The variants any available runtime serves, as one list: Studio stores an
   * image name on the repository and never picks the runtime. Names a
   * repository cannot hold are dropped rather than offered.
   */
  async listSandboxImages(): Promise<SandboxImage[]> {
    const { runtimes } = await this.call(ToolImages, {}, imagesResponseSchema);
    const names = new Set<SandboxImage>();
    for (const { images } of runtimes) {
      for (const { name } of images) {
        const parsed = SandboxImageSchema.safeParse(name);
        if (parsed.success && parsed.data !== "default") names.add(parsed.data);
      }
    }
    return [...names].sort();
  }

  /**
   * The controller owns its claim cache, so there is nothing to adopt here;
   * this re-reads the address, so a caller's one retry dials a live daemon.
   */
  async adoptLiveClaim(_id: SandboxId, handle: string): Promise<boolean> {
    const status = await this.status(handle).catch(() => null);
    return Boolean(status?.alive && status.daemon);
  }

  /**
   * Asks the controller to refresh the tenant pools warmed on this repo and
   * branch now. An accelerator only: on failure the pools still refresh on
   * the controller's own schedule, so this answers no pools instead of
   * failing the webhook.
   */
  async markTenantPoolsDirty(
    repoFullName: string,
    ref: string,
  ): Promise<string[]> {
    const args: TenantPoolsPushRequest = { repo: repoFullName, ref };
    try {
      return (
        await this.call(
          ToolTenantPoolsPush,
          args,
          tenantPoolsPushResponseSchema,
        )
      ).pools;
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] tenant pool push for ${repoFullName}@${ref} failed: ${errMsg(err)}`,
      );
      return [];
    }
  }

  close(): void {
    this.daemons.clear();
    const connecting = this.connecting;
    this.connecting = null;
    void connecting?.then((client) => client.close()).catch(() => {});
  }

  // ---- Daemon traffic -------------------------------------------------------

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const daemon = await this.daemonFor(handle);
    if (!daemon) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // Only a stream is consumed by the first attempt; other bodies re-send.
    const canRetryBody = !(init.body instanceof ReadableStream);
    let first: Response;
    try {
      first = await fetchDaemon(daemon.url, daemon.token, path, init);
    } catch (err) {
      // A stale address after the pod moved.
      if (!canRetryBody) throw err;
      const fresh = await this.daemonFor(handle, true);
      if (!fresh) throw err;
      return fetchDaemon(fresh.url, fresh.token, path, init);
    }
    if (first.status !== 401 || !canRetryBody) return first;
    // The bearer rotated under the cached one (a recreated pool pod).
    const fresh = await this.daemonFor(handle, true).catch(() => null);
    if (!fresh || (fresh.token === daemon.token && fresh.url === daemon.url)) {
      return first;
    }
    await first.body?.cancel().catch(() => {});
    return fetchDaemon(fresh.url, fresh.token, path, init);
  }

  /** Always the daemon's port: it strips CSP/X-Frame and injects the HMR bootstrap. */
  async resolvePreviewUpstreamUrl(handle: string): Promise<string | null> {
    return (await this.daemonFor(handle))?.url ?? null;
  }

  /**
   * Preview reverse-proxy for deploys without a per-claim gateway route.
   * Unauthenticated by design (the handle is the secret), so mutating
   * `/_sandbox/*` calls are refused here as well as by the daemon.
   */
  async proxyPreviewRequest(
    handle: string,
    request: Request,
  ): Promise<Response> {
    const upstreamBase = await this.resolvePreviewUpstreamUrl(handle).catch(
      (err) => {
        console.warn(
          `[${LOG_LABEL}] preview upstream for ${handle} failed: ${errMsg(err)}`,
        );
        return null;
      },
    );
    if (!upstreamBase) {
      const notReady = previewJsonResponse(404, { error: "sandbox not found" });
      notReady.headers.set(PREVIEW_NOT_READY_HEADER, "1");
      return notReady;
    }
    const reqUrl = new URL(request.url);
    const isAdminPath =
      reqUrl.pathname === "/_sandbox" ||
      reqUrl.pathname.startsWith("/_sandbox/");
    if (isAdminPath && request.method !== "GET") {
      return previewJsonResponse(404, { error: "not found" });
    }
    const headers = new Headers(request.headers);
    for (const h of PREVIEW_STRIP_REQUEST_HEADERS) headers.delete(h);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      signal: request.signal,
      ...(hasBody ? { duplex: "half" } : {}),
    };
    const target = (base: string) =>
      `${base}${reqUrl.pathname}${reqUrl.search}`;
    const attempt = (base: string) =>
      fetch(target(base), init).catch((err: unknown) => {
        console.warn(
          `[${LOG_LABEL}] preview fetch to ${base}${reqUrl.pathname} failed: ${errMsg(err)}`,
        );
        return null;
      });
    let upstream = await attempt(upstreamBase);
    if (!upstream) {
      this.daemons.delete(handle);
      // Only replay-safe methods retry: a consumed body would re-send empty.
      const retryBase =
        request.method === "GET" || request.method === "HEAD"
          ? await this.daemonFor(handle, true)
              .then((d) => d?.url ?? null)
              .catch(() => null)
          : null;
      if (retryBase) upstream = await attempt(retryBase);
      if (!upstream) {
        const notReady = previewJsonResponse(502, {
          error: "sandbox daemon unreachable",
        });
        notReady.headers.set(PREVIEW_NOT_READY_HEADER, "1");
        return notReady;
      }
    }
    const responseHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      if (!PREVIEW_STRIP_RESPONSE_HEADERS.includes(k.toLowerCase())) {
        responseHeaders.set(k, v);
      }
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  // ---- Lifecycle phases -----------------------------------------------------

  /**
   * The claim's pre-ready phases, ending after `ready` or `failed`, from the
   * watch tool's progress notifications. A watch that ends early, or a phase
   * that does not parse, surfaces as a `failed` phase so a waiting UI never
   * hangs.
   */
  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    const queue: ClaimPhase[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (phase: ClaimPhase) => {
      queue.push(phase);
      wake?.();
    };
    const args: HandleRequest = { handle };
    this.call(ToolWatch, args, phaseSchema, {
      timeoutMs: null,
      signal,
      onprogress: (progress) => push(toClaimPhase(progress.message ?? "")),
    })
      .catch((err: unknown) => {
        if (!signal?.aborted) {
          push(failedPhase(`controller watch failed: ${errMsg(err)}`));
        }
      })
      .finally(() => {
        done = true;
        wake?.();
      });
    while (true) {
      const phase = queue.shift();
      if (phase) {
        yield phase;
        if (phase.kind === "ready" || phase.kind === "failed") return;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    if (!signal?.aborted) {
      yield failedPhase("controller watch ended before ready");
    }
  }
}

function failedPhase(message: string): ClaimPhase {
  return { kind: "failed", reason: "unknown", message };
}

/** One progress message as the phase the lifecycle SSE route speaks. */
export function toClaimPhase(data: string): ClaimPhase {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return failedPhase("controller sent a non-JSON phase");
  }
  const parsed = phaseSchema.safeParse(json);
  if (!parsed.success) {
    return failedPhase(
      `controller sent a malformed phase: ${parsed.error.message}`,
    );
  }
  return fromPhase(parsed.data);
}

function fromPhase(p: Phase): ClaimPhase {
  const since = p.since ?? Date.now();
  switch (p.kind) {
    case "ready":
      return { kind: "ready" };
    case "failed":
      return {
        kind: "failed",
        reason: p.reason ?? "unknown",
        message: p.message ?? "",
      };
    case "waiting-for-capacity":
      return {
        kind: "waiting-for-capacity",
        since,
        ...(p.message !== undefined ? { message: p.message } : {}),
        ...(p.nodeClaim !== undefined ? { nodeClaim: p.nodeClaim } : {}),
      };
    case "claiming":
    case "pulling-image":
    case "starting-container":
    case "warming-daemon":
      return { kind: p.kind, since };
  }
}
