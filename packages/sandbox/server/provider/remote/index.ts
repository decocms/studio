/**
 * Hosted sandbox provider over the sandbox controller's HTTP API.
 *
 * The controller answers where a sandbox's daemon is and which bearer opens
 * it; the daemon traffic itself goes straight from Studio to the pod, so
 * streaming bodies, SSE and preview websockets never take a second hop. Every
 * controller call is mTLS with Studio's client certificate.
 */

import type { z } from "zod";
import type {
  Daemon,
  EnsureRequest,
  LifetimeRequest,
  Phase,
} from "../../../controller-types/sandbox-api";
import {
  PathCapacity,
  PathEvents,
  PathLifetime,
  PathSandbox,
  PathSandboxes,
} from "../../../controller-types/sandbox-api";
import {
  ConfigRequestError,
  proxyDaemonRequest as fetchDaemon,
} from "../../daemon-client";
import type { ClaimPhase } from "../agent-sandbox/lifecycle-types";
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
  drainingResponseSchema,
  ensureResponseSchema,
  errorResponseSchema,
  phaseSchema,
  statusResponseSchema,
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

/** Bounds every controller call except ensure and events, which the controller bounds on progress. */
const CONTROL_TIMEOUT_MS = 30_000;
/** Above the controller's own DELETE deadline, after which it answers 202. */
const DELETE_TIMEOUT_MS = 90_000;
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

/** A non-2xx controller answer, with the controller's error code. */
export class SandboxControllerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxControllerError";
  }
}

/** DELETE outlived the controller's deadline: retry, never treat it as gone. */
export class SandboxDrainingError extends Error {
  constructor(readonly handle: string) {
    super(`sandbox ${handle} is still draining; retry the delete`);
    this.name = "SandboxDrainingError";
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: string;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  accept?: string;
};

function pathFor(template: string, handle: string): string {
  return template.replace("{handle}", encodeURIComponent(handle));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RemoteSandboxProvider implements HostedSandboxProvider {
  private readonly base: string;
  private readonly tls: RemoteSandboxProviderOptions["tls"];
  private readonly daemons = new Map<string, { daemon: Daemon; at: number }>();
  private capacity: { value: boolean; at: number } | null = null;
  private capacityInFlight: Promise<boolean> | null = null;

  constructor(opts: RemoteSandboxProviderOptions) {
    const url = new URL(opts.baseUrl);
    this.base = url.toString().replace(/\/$/, "");
    this.tls = opts.tls;
  }

  // ---- Transport ------------------------------------------------------------

  private async request(
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const timeoutMs =
      opts.timeoutMs === undefined ? CONTROL_TIMEOUT_MS : opts.timeoutMs;
    const signals = [
      ...(opts.signal ? [opts.signal] : []),
      ...(timeoutMs !== null ? [AbortSignal.timeout(timeoutMs)] : []),
    ];
    const headers = new Headers({ accept: opts.accept ?? "application/json" });
    if (opts.body !== undefined)
      headers.set("content-type", "application/json");
    const init: BunFetchRequestInit & { timeout?: false } = {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      ...(this.tls ? { tls: this.tls } : {}),
      // Bun's own fetch timeout, off as for the kube watch streams in
      // agent-sandbox/client.ts: ensure answers only once the daemon is ready.
      ...(timeoutMs === null ? { timeout: false } : {}),
    };
    return fetch(`${this.base}${path}${opts.query ?? ""}`, init);
  }

  /** Turns a non-2xx answer into the error its body names. */
  private async failure(res: Response, what: string): Promise<Error> {
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const parsed = errorResponseSchema.safeParse(body);
    if (!parsed.success) {
      return new SandboxControllerError(
        res.status,
        "internal",
        `sandbox controller ${what} returned ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const err = parsed.data;
    // start.ts words this one for the agent: the pod refused the handshake,
    // the claim was released, and a retry gets another pod.
    if (err.code === "bootstrap-rejected") {
      return new ConfigRequestError(err.status ?? res.status, err.error);
    }
    const reasons = err.reasons
      ? ` (${Object.entries(err.reasons)
          .map(([rt, why]) => `${rt}: ${why}`)
          .join("; ")})`
      : "";
    return new SandboxControllerError(
      res.status,
      err.code,
      `sandbox controller ${what}: ${err.error}${reasons}`,
    );
  }

  private async parse<T>(
    res: Response,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SandboxControllerError(
        res.status,
        "internal",
        `sandbox controller ${what} returned a non-JSON body`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new SandboxControllerError(
        res.status,
        "internal",
        `sandbox controller ${what} returned a malformed body: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
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

  /** GET /sandboxes/:handle; null when the controller has no such sandbox. */
  private async status(handle: string, resurrect = false) {
    const what = `GET ${handle}`;
    const res = await this.request(pathFor(PathSandbox, handle), {
      query: resurrect ? "?resurrect=1" : "",
      // Resurrecting provisions; the controller bounds it on progress.
      timeoutMs: resurrect ? null : CONTROL_TIMEOUT_MS,
    });
    if (res.status === 404) {
      await this.drain(res);
      return null;
    }
    if (!res.ok) throw await this.failure(res, what);
    const status = await this.parse(res, statusResponseSchema, what);
    this.remember(handle, status.alive ? status.daemon : null);
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
    const body: EnsureRequest = { id, handle, opts: wireOpts };
    const what = `ensure ${handle}`;
    const res = await this.request(PathSandboxes, {
      method: "POST",
      body,
      timeoutMs: null,
    });
    if (!res.ok) throw await this.failure(res, what);
    const out = await this.parse(res, ensureResponseSchema, what);
    if (out.handle !== handle) {
      throw new SandboxControllerError(
        res.status,
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
   * Waits for the controller to collect the sandbox. A 202 means the claim
   * outlived the controller's deadline and is still draining: that throws, so
   * a caller rebinding never provisions a second daemon beside it.
   */
  async delete(handle: string): Promise<void> {
    this.daemons.delete(handle);
    const what = `DELETE ${handle}`;
    const res = await this.request(pathFor(PathSandbox, handle), {
      method: "DELETE",
      timeoutMs: DELETE_TIMEOUT_MS,
    });
    if (res.status === 204 || res.status === 404) {
      await this.drain(res);
      return;
    }
    if (res.status === 202) {
      await this.parse(res, drainingResponseSchema, what);
      throw new SandboxDrainingError(handle);
    }
    throw await this.failure(res, what);
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
  private async lifetime(
    handle: string,
    body: LifetimeRequest,
    what: string,
  ): Promise<void> {
    try {
      const res = await this.request(pathFor(PathLifetime, handle), {
        method: "PATCH",
        body,
      });
      if (res.ok || res.status === 404) {
        await this.drain(res);
        return;
      }
      throw await this.failure(res, `${what} ${handle}`);
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] ${what} failed for ${handle}: ${errMsg(err)}`,
      );
    }
  }

  renewTtl(handle: string): Promise<void> {
    return this.lifetime(handle, { extendToIdleWindow: true }, "TTL renew");
  }

  releaseAfter(handle: string, graceMs: number): Promise<void> {
    return this.lifetime(
      handle,
      { graceMs: Math.max(0, Math.round(graceMs)) },
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
      const res = await this.request(PathCapacity);
      if (!res.ok) throw await this.failure(res, "capacity");
      value = (await this.parse(res, capacityResponseSchema, "capacity"))
        .schedulable;
    } catch (err) {
      console.warn(`[${LOG_LABEL}] capacity probe failed: ${errMsg(err)}`);
    }
    this.capacity = { value, at: Date.now() };
    return value;
  }

  /**
   * The controller owns its claim cache, so there is nothing to adopt here;
   * this re-reads the address, so a caller's one retry dials a live daemon.
   */
  async adoptLiveClaim(_id: SandboxId, handle: string): Promise<boolean> {
    const status = await this.status(handle).catch(() => null);
    return Boolean(status?.alive && status.daemon);
  }

  /** Tenant pools are the controller's to reconcile. */
  markTenantPoolsDirty(_repoFullName: string, _ref: string): string[] {
    return [];
  }

  close(): void {
    this.daemons.clear();
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
    await this.drain(first);
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
   * SSE of the claim's pre-ready phases, ending after `ready` or `failed`. A
   * stream that ends early, or a frame that does not parse, surfaces as a
   * `failed` phase so a waiting UI never hangs.
   */
  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    let res: Response;
    try {
      res = await this.request(pathFor(PathEvents, handle), {
        accept: "text/event-stream",
        timeoutMs: null,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      yield failedPhase(`controller events unreachable: ${errMsg(err)}`);
      return;
    }
    if (!res.ok || !res.body) {
      const err = await this.failure(res, `events ${handle}`);
      yield failedPhase(err.message);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value.replace(/\r\n/g, "\n");
        for (
          let sep = buf.indexOf("\n\n");
          sep !== -1;
          sep = buf.indexOf("\n\n")
        ) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const phase = toClaimPhase(data);
          yield phase;
          if (phase.kind === "ready" || phase.kind === "failed") return;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      yield failedPhase(`controller events stream broke: ${errMsg(err)}`);
      return;
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!signal?.aborted) {
      yield failedPhase("controller events stream ended before ready");
    }
  }
}

function failedPhase(message: string): ClaimPhase {
  return { kind: "failed", reason: "unknown", message };
}

/** One `data:` payload as the phase the lifecycle SSE route speaks. */
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
