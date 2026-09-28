/**
 * `SandboxProvider` over a host's sandbox API (see `sandbox-api.ts`): the
 * control plane runs `AgentSandboxProvider` against the cluster and answers
 * where a sandbox's daemon is and which bearer opens it. Daemon and preview
 * traffic go straight from Studio to the daemon, never through the host.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { z } from "zod";
import {
  ConfigRequestError,
  proxyDaemonRequest as fetchDaemon,
} from "../daemon-client";
import type { SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import {
  capacityOutputSchema,
  claimPhaseSchema,
  type Daemon,
  emptySchema,
  ensureOutputSchema,
  SANDBOX_TOOLS,
  SANDBOX_WATCH_PATH,
  statusOutputSchema,
  tenantPoolsPushOutputSchema,
  toolErrorSchema,
} from "./sandbox-api";
import { computeHandle } from "./shared";
import {
  PREVIEW_NOT_READY_HEADER,
  PREVIEW_STRIP_REQUEST_HEADERS,
  PREVIEW_STRIP_RESPONSE_HEADERS,
  previewJsonResponse,
} from "./shared/preview-proxy";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
} from "./types";

const LOG_LABEL = "RemoteSandboxProvider";

/** Bounds every call except ensure, which the host bounds on progress. */
const CONTROL_TIMEOUT_MS = 30_000;
/** The MCP client always arms a timeout; setTimeout's ceiling never fires. */
const UNBOUNDED_MS = 2 ** 31 - 1;
/** Same reuse window as the in-process capacity probe. */
const CAPACITY_TTL_MS = 3_000;
/** A cached daemon address is re-read after this; a 401 or a dead url re-reads it sooner. */
const DAEMON_CACHE_TTL_MS = 5 * 60_000;
const DAEMON_CACHE_MAX = 5_000;

export interface RemoteSandboxProviderOptions {
  /** The host's origin, e.g. `https://control-plane.example.com`. */
  baseUrl: string;
  /** Bearer the host accepts for its sandbox API. */
  token: string;
}

/** A failed host call. */
export class SandboxHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxHostError";
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** A failed call's text as the error it names. */
function failure(tool: string, text: string): Error {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the SDK's own wording, e.g. a schema violation */
  }
  const parsed = toolErrorSchema.safeParse(body);
  if (!parsed.success) {
    return new SandboxHostError(`${tool} failed: ${text.slice(0, 300)}`);
  }
  // start.ts words this one for the agent: the pod refused the handshake and
  // a retry gets another pod.
  if (parsed.data.code === "bootstrap-rejected") {
    return new ConfigRequestError(parsed.data.status ?? 502, parsed.data.error);
  }
  return new SandboxHostError(`${tool}: ${parsed.data.error}`);
}

function failedPhase(message: string): ClaimPhase {
  return { kind: "failed", reason: "unknown", message };
}

export class RemoteSandboxProvider implements SandboxProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private connecting: Promise<Client> | null = null;
  private readonly daemons = new Map<string, { daemon: Daemon; at: number }>();
  private capacity: { value: boolean; at: number } | null = null;
  private capacityInFlight: Promise<boolean> | null = null;

  constructor(opts: RemoteSandboxProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  // ---- Transport ------------------------------------------------------------

  /** One client for every call; the host is stateless, so a restart costs a reconnect. */
  private client(): Promise<Client> {
    this.connecting ??= (async () => {
      const client = new Client({ name: "studio", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${this.baseUrl}/mcp`),
        {
          requestInit: { headers: this.headers() },
          // Bun's own fetch timeout, off: ensure answers only once the daemon
          // is ready. Calls are bounded by `call`'s timeout.
          fetch: (url, init) =>
            fetch(url, { ...init, timeout: false } as BunFetchRequestInit),
        },
      );
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
    timeoutMs: number | null = CONTROL_TIMEOUT_MS,
  ): Promise<T> {
    const result = await (await this.client()).callTool(
      { name: tool, arguments: { ...args } },
      undefined,
      { timeout: timeoutMs ?? UNBOUNDED_MS },
    );
    if (result.isError) throw failure(tool, textOf(result.content));
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new SandboxHostError(
        `${tool} returned a malformed result: ${parsed.error.message}`,
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

  private async status(handle: string, resurrect = false) {
    const status = await this.call(
      SANDBOX_TOOLS.status,
      { handle, resurrect },
      statusOutputSchema,
      // Resurrecting provisions; the host bounds it on progress.
      resurrect ? null : CONTROL_TIMEOUT_MS,
    );
    this.remember(handle, status.daemon);
    return status;
  }

  /**
   * The daemon to dial: cached, else re-read. A miss resurrects, as the
   * in-process runner does: the idle TTL may have reaped the claim under a
   * caller that still needs it.
   */
  private async daemonFor(
    handle: string,
    refresh = false,
  ): Promise<Daemon | null> {
    if (!refresh) {
      const hit = this.cached(handle);
      if (hit) return hit;
    }
    return (await this.status(handle, true)).daemon;
  }

  // ---- Lifecycle ------------------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const { image: _templatePinned, ...wireOpts } = opts;
    const out = await this.call(
      SANDBOX_TOOLS.ensure,
      { id, opts: wireOpts },
      ensureOutputSchema,
      null,
    );
    // Preview routing recomputes handles without a lookup; a host that
    // derived another one would strand the sandbox.
    if (out.handle !== computeHandle(id)) {
      throw new SandboxHostError(
        `host answered ensure with ${out.handle}, expected ${computeHandle(id)}`,
      );
    }
    this.remember(out.handle, out.daemon);
    return {
      handle: out.handle,
      workdir: out.workdir,
      previewUrl: out.previewUrl,
      warmPoolAdopted: out.warmPoolAdopted,
    };
  }

  async delete(handle: string): Promise<void> {
    this.daemons.delete(handle);
    await this.call(SANDBOX_TOOLS.delete, { handle }, emptySchema);
  }

  async alive(handle: string): Promise<boolean> {
    return (await this.status(handle)).alive;
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    return (await this.status(handle)).previewUrl;
  }

  async lastTermination(handle: string): Promise<PodTermination | null> {
    return (await this.status(handle)).lastTermination;
  }

  /** Best-effort like the in-process runner's: a miss costs idle minutes, never a run. */
  private async lifetime(args: object, what: string): Promise<void> {
    try {
      await this.call(SANDBOX_TOOLS.lifetime, args, emptySchema);
    } catch (err) {
      console.warn(`[${LOG_LABEL}] ${what} failed: ${errMsg(err)}`);
    }
  }

  renewTtl(handle: string): Promise<void> {
    return this.lifetime({ handle }, `TTL renew for ${handle}`);
  }

  releaseAfter(handle: string, graceMs: number): Promise<void> {
    return this.lifetime(
      { handle, graceMs: Math.max(0, Math.round(graceMs)) },
      `release of ${handle}`,
    );
  }

  /** Fail-open like the in-process probe; reused briefly, one request at a time. */
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
      value = (
        await this.call(SANDBOX_TOOLS.capacity, {}, capacityOutputSchema)
      ).schedulable;
    } catch (err) {
      console.warn(`[${LOG_LABEL}] capacity probe failed: ${errMsg(err)}`);
    }
    this.capacity = { value, at: Date.now() };
    return value;
  }

  /** The host owns its claim cache; re-reading the address is the adopt. */
  async adoptLiveClaim(_id: SandboxId, handle: string): Promise<boolean> {
    const status = await this.status(handle).catch(() => null);
    return Boolean(status?.daemon);
  }

  /** An accelerator only: the host's pools refresh on schedule anyway. */
  async markTenantPoolsDirty(
    repoFullName: string,
    ref: string,
  ): Promise<string[]> {
    try {
      return (
        await this.call(
          SANDBOX_TOOLS.tenantPoolsPush,
          { repo: repoFullName, ref },
          tenantPoolsPushOutputSchema,
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
    const attempt = (base: string) =>
      fetch(`${base}${reqUrl.pathname}${reqUrl.search}`, init).catch(
        (err: unknown) => {
          console.warn(
            `[${LOG_LABEL}] preview fetch to ${base}${reqUrl.pathname} failed: ${errMsg(err)}`,
          );
          return null;
        },
      );
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
   * The claim's pre-ready phases from the host's SSE route, ending after
   * `ready` or `failed`. A stream that ends early or sends a bad phase
   * surfaces as `failed`, so a waiting UI never hangs.
   */
  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    const url = new URL(`${this.baseUrl}${SANDBOX_WATCH_PATH}`);
    url.searchParams.set("handle", handle);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal,
        timeout: false,
      } as BunFetchRequestInit);
    } catch (err) {
      if (!signal?.aborted) yield failedPhase(`watch failed: ${errMsg(err)}`);
      return;
    }
    if (!res.ok || !res.body) {
      yield failedPhase(`watch answered ${res.status}`);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
          const data = event
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
      if (!signal?.aborted) yield failedPhase(`watch failed: ${errMsg(err)}`);
      return;
    }
    if (!signal?.aborted) yield failedPhase("watch ended before ready");
  }
}

/** One SSE `data` payload as a phase; anything unparseable is a failure. */
export function toClaimPhase(data: string): ClaimPhase {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return failedPhase("host sent a non-JSON phase");
  }
  const parsed = claimPhaseSchema.safeParse(json);
  return parsed.success
    ? parsed.data
    : failedPhase(`host sent a malformed phase: ${parsed.error.message}`);
}
