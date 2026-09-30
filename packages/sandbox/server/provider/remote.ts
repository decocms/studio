/**
 * `SandboxProvider` over a host's sandbox API (see `sandbox-api.ts`): the
 * control plane runs `AgentSandboxProvider` against the cluster and answers
 * where a sandbox's daemon is and which bearer opens it. Daemon and preview
 * traffic go straight from Studio to the daemon, never through the host.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Meter } from "@opentelemetry/api";
import type { z } from "zod";
import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";
import { ConfigRequestError } from "../daemon-client";
import type { SandboxProvider } from "./agent-sandbox";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import {
  capacityOutputSchema,
  claimPhaseSchema,
  type CredentialsPush,
  credentialsPushOutputSchema,
  listOutputSchema,
  type SandboxList,
  type Daemon,
  emptySchema,
  ensureOutputSchema,
  SANDBOX_TOOLS,
  SANDBOX_WATCH_KEEPALIVE_MS,
  SANDBOX_WATCH_PATH,
  statusOutputSchema,
  tenantPoolsPushOutputSchema,
  toolErrorSchema,
} from "./sandbox-api";
import { computeHandle } from "./shared";
import { proxyDaemonWithRetry } from "./shared/daemon-proxy";
import { proxyPreview } from "./shared/preview-proxy";
import { tagSandboxProvider } from "./shared/provider-tag";
import { daemonProxyTimer, RUNNER_KIND } from "./shared/proxy-metrics";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxProviderKind,
} from "./types";

const LOG_LABEL = "RemoteSandboxProvider";

/** Bounds every quick call; provisioning is bounded on stalled progress. */
const CONTROL_TIMEOUT_MS = 30_000;
/** The MCP client always arms a timeout; setTimeout's ceiling never fires. */
const UNBOUNDED_MS = 2 ** 31 - 1;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 5_000;
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
  /**
   * How long, at least, the org-fs config an ensure carries stays valid,
   * from the moment it was minted. Sent with each ensure so the host can keep
   * it for recovery; clone credentials carry their own `credentialExpiresAt`.
   */
  credentialLifetimeMs?: { orgFsConfig: number };
  /**
   * How long the host's watch may stay silent — no phase, no keepalive —
   * before a provisioning call or a watch gives up on it. Defaults to four
   * missed keepalives.
   */
  stallMs?: number;
  /** Records daemon request latency by provider; see `daemonProxyTimer`. */
  meter?: Meter;
}

/** A failed host call. */
export class SandboxHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxHostError";
  }
}

/** The host refused the watch outright; reconnecting gets the same answer. */
class WatchRefused extends Error {}

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
  const err =
    parsed.data.code === "bootstrap-rejected"
      ? new ConfigRequestError(parsed.data.status ?? 502, parsed.data.error)
      : new SandboxHostError(`${tool}: ${parsed.data.error}`);
  return parsed.data.provider
    ? tagSandboxProvider(err, parsed.data.provider)
    : err;
}

function failedPhase(message: string): ClaimPhase {
  return { kind: "failed", reason: "unknown", message };
}

function isTerminal(phase: ClaimPhase): boolean {
  return phase.kind === "ready" || phase.kind === "failed";
}

function reconnectDelay(attempt: number): number {
  return exponentialBackoffWithJitter(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS,
    attempt,
    2,
    0.5,
  );
}

function anySignal(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s) => s !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

interface CachedSandbox {
  daemon: Daemon;
  previewUrl: string | null;
  provider: SandboxProviderKind;
  at: number;
}

interface CallOptions {
  /** Null: bounded by `signal` alone. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export class RemoteSandboxProvider implements SandboxProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly credentialLifetimeMs: RemoteSandboxProviderOptions["credentialLifetimeMs"];
  private readonly stallMs: number;
  private readonly timeDaemonRequest: ReturnType<typeof daemonProxyTimer>;
  private readonly closed = new AbortController();
  private connecting: Promise<Client> | null = null;
  private readonly sandboxes = new Map<string, CachedSandbox>();
  private capacity: { value: boolean; at: number } | null = null;
  private capacityInFlight: Promise<boolean> | null = null;

  constructor(opts: RemoteSandboxProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.credentialLifetimeMs = opts.credentialLifetimeMs;
    this.stallMs = opts.stallMs ?? 4 * SANDBOX_WATCH_KEEPALIVE_MS;
    this.timeDaemonRequest = daemonProxyTimer(opts.meter);
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
          // is ready. Calls are bounded by `call`'s timeout or signal.
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
    opts: CallOptions = {},
  ): Promise<T> {
    const { timeoutMs = CONTROL_TIMEOUT_MS, signal } = opts;
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await (await this.client()).callTool(
        { name: tool, arguments: { ...args } },
        undefined,
        { timeout: timeoutMs ?? UNBOUNDED_MS, signal },
      );
    } catch (err) {
      // The SDK rewords an abort as a timeout; the reason says which it was.
      if (signal?.aborted) throw signal.reason;
      throw err;
    }
    if (result.isError) throw failure(tool, textOf(result.content));
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new SandboxHostError(
        `${tool} returned a malformed result: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /**
   * Runs a call that may provision, bounded on the host's signs of life
   * rather than wall time: a cold image pull legitimately takes minutes, and
   * the host's watch keeps saying so.
   */
  private async whileHostAlive<T>(
    handle: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const settled = new AbortController();
    const stalled = new AbortController();
    void this.hostStall(
      handle,
      anySignal(settled.signal, signal, this.closed.signal) ?? settled.signal,
    ).then((err) => {
      if (err) stalled.abort(err);
    });
    try {
      return await run(
        anySignal(stalled.signal, signal, this.closed.signal) ?? stalled.signal,
      );
    } finally {
      settled.abort();
    }
  }

  // ---- Sandbox cache --------------------------------------------------------

  private cached(handle: string): CachedSandbox | null {
    const entry = this.sandboxes.get(handle);
    if (!entry) return null;
    if (Date.now() - entry.at > DAEMON_CACHE_TTL_MS) {
      this.sandboxes.delete(handle);
      return null;
    }
    return entry;
  }

  private remember(
    handle: string,
    daemon: Daemon | null,
    previewUrl: string | null,
    provider: SandboxProviderKind,
  ): void {
    this.sandboxes.delete(handle);
    if (!daemon) return;
    if (this.sandboxes.size >= DAEMON_CACHE_MAX) {
      const oldest = this.sandboxes.keys().next();
      if (!oldest.done) this.sandboxes.delete(oldest.value);
    }
    this.sandboxes.set(handle, {
      daemon,
      previewUrl,
      provider,
      at: Date.now(),
    });
  }

  private async status(
    handle: string,
    opts: { resurrect?: boolean; signal?: AbortSignal } = {},
  ) {
    const read = (signal?: AbortSignal, timeoutMs?: number | null) =>
      this.call(
        SANDBOX_TOOLS.status,
        { handle, resurrect: opts.resurrect ?? false },
        statusOutputSchema,
        { signal, timeoutMs },
      );
    const status = opts.resurrect
      ? // Resurrecting provisions.
        await this.whileHostAlive(
          handle,
          (signal) => read(signal, null),
          opts.signal,
        )
      : await read(opts.signal);
    this.remember(handle, status.daemon, status.previewUrl, status.provider);
    return status;
  }

  /**
   * The daemon to dial: cached, else re-read. A miss resurrects, as the
   * in-process runner does: the idle TTL may have reaped the claim under a
   * caller that still needs it.
   */
  private async daemonFor(
    handle: string,
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<Daemon | null> {
    if (!opts.refresh) {
      const hit = this.cached(handle);
      if (hit) return hit.daemon;
    }
    return (await this.status(handle, { resurrect: true, signal: opts.signal }))
      .daemon;
  }

  // ---- Lifecycle ------------------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const { image: _templatePinned, ...wireOpts } = opts;
    const handle = computeHandle(id);
    const lifetime = this.credentialLifetimeMs;
    const now = Date.now();
    const out = await this.whileHostAlive(handle, (signal) =>
      this.call(
        SANDBOX_TOOLS.ensure,
        {
          id,
          opts: wireOpts,
          ...(lifetime && {
            credentialsValidUntil: {
              orgFsConfig: now + lifetime.orgFsConfig,
            },
          }),
        },
        ensureOutputSchema,
        { timeoutMs: null, signal },
      ),
    );
    // Preview routing recomputes handles without a lookup; a host that
    // derived another one would strand the sandbox.
    if (out.handle !== handle) {
      throw new SandboxHostError(
        `host answered ensure with ${out.handle}, expected ${handle}`,
      );
    }
    this.remember(out.handle, out.daemon, out.previewUrl, out.provider);
    return {
      handle: out.handle,
      workdir: out.workdir,
      previewUrl: out.previewUrl,
      warmPoolAdopted: out.warmPoolAdopted,
      provider: out.provider,
    };
  }

  async delete(handle: string): Promise<void> {
    this.sandboxes.delete(handle);
    await this.call(SANDBOX_TOOLS.delete, { handle }, emptySchema);
  }

  async alive(handle: string): Promise<boolean> {
    return (await this.status(handle)).alive;
  }

  /** Stable for a sandbox's life, so a cached one answers without a call. */
  async getPreviewUrl(handle: string): Promise<string | null> {
    const hit = this.cached(handle);
    if (hit) return hit.previewUrl;
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
  async markTenantPoolsDirty(repoUrl: string, ref: string): Promise<string[]> {
    try {
      return (
        await this.call(
          SANDBOX_TOOLS.tenantPoolsPush,
          { repoUrl, ref },
          tenantPoolsPushOutputSchema,
        )
      ).pools;
    } catch (err) {
      console.warn(
        `[${LOG_LABEL}] tenant pool push for ${repoUrl}@${ref} failed: ${errMsg(err)}`,
      );
      return [];
    }
  }

  /** The host's live sandboxes and tenant pools, as untrusted input to a credential push. */
  list(): Promise<SandboxList> {
    return this.call(SANDBOX_TOOLS.list, {}, listOutputSchema);
  }

  /** Hands the host fresh credentials; it keeps them in memory only. */
  pushCredentials(batch: CredentialsPush) {
    return this.call(
      SANDBOX_TOOLS.credentialsPush,
      batch,
      credentialsPushOutputSchema,
    );
  }

  close(): void {
    this.closed.abort();
    this.sandboxes.clear();
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
    const signal = init.signal;
    const daemon = await this.daemonFor(handle, { signal });
    if (!daemon) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const kind = this.sandboxes.get(handle)?.provider ?? "kubernetes";
    return this.timeDaemonRequest(RUNNER_KIND[kind], () =>
      proxyDaemonWithRetry(daemon, path, init, {
        unauthorized: async () => {
          const fresh = await this.daemonFor(handle, {
            refresh: true,
            signal,
          }).catch(() => null);
          // The same bearer again would get the same 401.
          return fresh &&
            (fresh.token !== daemon.token || fresh.url !== daemon.url)
            ? fresh
            : null;
        },
        unreachable: () => this.daemonFor(handle, { refresh: true, signal }),
      }),
    );
  }

  /** Always the daemon's port: it strips CSP/X-Frame and injects the HMR bootstrap. */
  async resolvePreviewUpstreamUrl(
    handle: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return (await this.daemonFor(handle, { signal }))?.url ?? null;
  }

  /** See `proxyPreview`; recovery re-reads the address, resurrecting. */
  proxyPreviewRequest(handle: string, request: Request): Promise<Response> {
    const signal = request.signal;
    return proxyPreview(
      request,
      {
        base: () =>
          this.resolvePreviewUpstreamUrl(handle, signal).catch((err) => {
            console.warn(
              `[${LOG_LABEL}] preview upstream for ${handle} failed: ${errMsg(err)}`,
            );
            return null;
          }),
        invalidate: () => this.sandboxes.delete(handle),
        retryBase: () =>
          this.daemonFor(handle, { refresh: true, signal })
            .then((d) => d?.url ?? null)
            .catch(() => null),
      },
      LOG_LABEL,
    );
  }

  // ---- Lifecycle phases -----------------------------------------------------

  /**
   * One watch connection: its phases, and `"alive"` for every comment. Ends
   * when the host closes the stream; throws when it cannot connect, drops, or
   * goes silent for half of `stallMs`, and `WatchRefused` on a 4xx.
   */
  private async *watchOnce(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase | "alive", void, unknown> {
    const url = new URL(`${this.baseUrl}${SANDBOX_WATCH_PATH}`);
    url.searchParams.set("handle", handle);
    const silent = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Half the stall bound, so a half-open connection gets a reconnect.
    const idleMs = this.stallMs / 2;
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          silent.abort(new Error(`host sent nothing for ${idleMs / 1000}s`)),
        idleMs,
      );
    };
    heard();
    try {
      const res = await fetch(url, {
        headers: { ...this.headers(), accept: "text/event-stream" },
        signal: anySignal(silent.signal, signal),
        timeout: false,
      } as BunFetchRequestInit);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        const message = `watch answered ${res.status}`;
        throw res.status >= 400 && res.status < 500
          ? new WatchRefused(message)
          : new Error(message);
      }
      heard();
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        heard();
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
          yield data ? toClaimPhase(data) : "alive";
        }
      }
    } catch (err) {
      if (silent.signal.aborted && !signal?.aborted) throw silent.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolves with an error once the host has shown no sign of life for
   * `stallMs`, or with null when `signal` aborts or the host refuses the
   * watch. The watch closes after a terminal phase while the host may still
   * be bootstrapping, so it is reopened a keepalive interval later.
   */
  private async hostStall(
    handle: string,
    signal: AbortSignal,
  ): Promise<SandboxHostError | null> {
    let lastSign = Date.now();
    let attempt = 0;
    while (!signal.aborted) {
      let closedCleanly = false;
      let lastError = "";
      try {
        for await (const event of this.watchOnce(handle, signal)) {
          lastSign = Date.now();
          attempt = 0;
          if (event !== "alive" && isTerminal(event)) break;
        }
        closedCleanly = true;
      } catch (err) {
        if (signal.aborted) return null;
        if (err instanceof WatchRefused) {
          console.warn(
            `[${LOG_LABEL}] ${err.message} for ${handle}: its progress is unbounded`,
          );
          return null;
        }
        lastError = errMsg(err);
      }
      if (Date.now() - lastSign >= this.stallMs) {
        return new SandboxHostError(
          `the host showed no progress for ${handle} in ${this.stallMs / 1000}s${lastError ? `: ${lastError}` : ""}`,
        );
      }
      await sleep(
        closedCleanly ? this.stallMs / 4 : reconnectDelay(attempt++),
        { signal },
      ).catch(() => {});
    }
    return null;
  }

  /**
   * The claim's pre-ready phases from the host's SSE route, ending after
   * `ready` or `failed`. A dropped stream reconnects (the host re-sends the
   * current phase, which is not repeated here) until the host has been silent
   * for `stallMs`; only then, or on a refusal, does a lost watch surface as
   * `failed`, so a waiting UI never hangs.
   */
  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    const stop = anySignal(signal, this.closed.signal);
    let lastSign = Date.now();
    let attempt = 0;
    let last = "";
    while (!stop?.aborted) {
      let lastError = "watch ended before ready";
      try {
        for await (const event of this.watchOnce(handle, stop)) {
          lastSign = Date.now();
          attempt = 0;
          if (event === "alive") continue;
          const key = JSON.stringify(event);
          if (key !== last) {
            last = key;
            yield event;
          }
          if (isTerminal(event)) return;
        }
      } catch (err) {
        if (stop?.aborted) return;
        if (err instanceof WatchRefused) {
          yield failedPhase(err.message);
          return;
        }
        lastError = `watch failed: ${errMsg(err)}`;
      }
      if (Date.now() - lastSign >= this.stallMs) {
        yield failedPhase(lastError);
        return;
      }
      await sleep(reconnectDelay(attempt++), { signal: stop }).catch(() => {});
    }
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
