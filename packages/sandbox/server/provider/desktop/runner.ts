/**
 * desktop sandbox provider — cluster-side stub that forwards every
 * `SandboxProvider` call to a per-user link daemon running on the developer's
 * desktop over the NATS-backed dispatch channel.
 *
 * All control requests (ensure, exec, delete, alive, proxyDaemonRequest) are
 * encoded as `DispatchRequest` objects and sent via `dispatch(userSub, req)`.
 * The daemon's in-process control handler (implemented in Task 11) receives
 * them on `links.dispatch.<userSub>` and writes back the response as one or
 * more text chunks followed by an `end` frame.
 *
 * `watchClaimLifecycle` emits a single synthetic `ready` phase — by the time
 * `ensure` resolves the link has already brought the daemon up.
 *
 * `localWorkdir` returns null — the workdir lives on the desktop and is never
 * referenced by cluster code.
 */

import { computeHandle } from "../shared";
import type { ClaimPhase } from "../lifecycle-types";
import type { RunnerStateStoreOps } from "../state-store";
import type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxProvider,
} from "../types";
import type { DispatchFn } from "../../../../../apps/mesh/src/links/dispatcher";

const RUNNER_KIND = "user-desktop" as const;

export interface DesktopProviderOptions {
  /** Better Auth user id — used as the NATS routing key. */
  userSub: string;
  /** NATS-backed dispatch function from `createDispatcher()`. */
  dispatch: DispatchFn;
  /**
   * Persistent handle → state store. Optional for compatibility with
   * in-process tests that don't need cross-instance hydration; the
   * cluster MUST pass one (KyselySandboxProviderStateStore) so a
   * fresh provider per request can still find a previously-ensured
   * sandbox. Same dependency the cluster provider takes.
   */
  stateStore?: RunnerStateStoreOps;
}

interface RemoteRecord {
  handle: string;
  /** Daemon's local sandbox API URL (e.g. `http://127.0.0.1:<port>`).
   *  Used as the workdir-equivalent for the cluster's records and for
   *  sandbox-state-store rehydration. */
  sandboxApiUrl: string;
  /**
   * Public-facing preview URL routed through the daemon's local ingress
   * (`http://<handle>.localhost:<ingressPort>`) — what the user's browser
   * actually hits. Distinct from `sandboxApiUrl` so internal probes can
   * skip the ingress hop.
   */
  previewUrl: string;
}

export class DesktopSandboxProvider implements SandboxProvider {
  readonly kind = RUNNER_KIND;

  private readonly userSub: string;
  private readonly dispatch: DispatchFn;
  private readonly stateStore: RunnerStateStoreOps | null;
  private readonly records = new Map<string, RemoteRecord>();

  constructor(opts: DesktopProviderOptions) {
    if (!opts.userSub) {
      throw new Error("DesktopSandboxProvider requires userSub");
    }
    if (!opts.dispatch) {
      throw new Error("DesktopSandboxProvider requires dispatch");
    }
    this.userSub = opts.userSub;
    this.dispatch = opts.dispatch;
    this.stateStore = opts.stateStore ?? null;
  }

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // hashLen=16 mirrors agent-sandbox and the cluster's `computeClaimHandle`
    // — a 16-hex-char handle is used as a public subdomain prefix
    // (e.g. `<handle>.localhost:<port>`) so a short hash keeps URLs readable.
    // If this changes, the matching constant in
    // `apps/mesh/src/sandbox/claim-handle.ts` must change too or the
    // cluster's state-store lookup will silently miss.
    const handle = computeHandle(id, opts.repo?.branch, { hashLen: 16 });

    // Probe before trusting cached records — a dead daemon leaves a stale URL.
    const cached = this.records.get(handle);
    if (cached) {
      if (await this.probeHealth(handle)) return this.toSandbox(cached);
      this.records.delete(handle);
      if (this.stateStore) {
        await this.stateStore
          .deleteByHandle(RUNNER_KIND, handle)
          .catch(() => {});
      }
    } else if (this.stateStore) {
      const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
      const persisted = row?.state as
        | { sandboxApiUrl?: string; previewUrl?: string }
        | undefined;
      const sandboxApiUrl = persisted?.sandboxApiUrl;
      if (sandboxApiUrl) {
        if (await this.probeHealth(handle)) {
          const rec: RemoteRecord = {
            handle,
            sandboxApiUrl,
            previewUrl: persisted?.previewUrl ?? sandboxApiUrl,
          };
          this.records.set(handle, rec);
          return this.toSandbox(rec);
        }
        await this.stateStore
          .deleteByHandle(RUNNER_KIND, handle)
          .catch(() => {});
      }
    }

    // Forward the workload so the link daemon can pin runtime +
    // packageManager on the spawned sandbox. Without it the orchestrator
    // falls through to lockfile autodetect, which on a repo with
    // `yarn.lock` picks yarn — and the desktop daemon can't reliably
    // shim a yarn binary into PATH.
    const body = JSON.stringify({
      handle,
      repo: opts.repo,
      branch: opts.repo?.branch,
      ...(opts.workload ? { workload: opts.workload } : {}),
    });
    const responseText = await this.dispatchJson(
      "POST",
      "/api/sandboxes",
      body,
    );
    const parsed = JSON.parse(responseText) as {
      sandboxApiUrl?: unknown;
      previewUrl?: unknown;
    };
    if (typeof parsed.sandboxApiUrl !== "string") {
      throw new Error(
        "desktop ensure: daemon did not return a sandboxApiUrl string",
      );
    }
    // Backwards-compat: a daemon running pre-previewUrl code returns only
    // `sandboxApiUrl`. Fall back to it so the browser at least has SOMETHING
    // to load (it just won't be routed through the local ingress).
    const previewUrl =
      typeof parsed.previewUrl === "string"
        ? parsed.previewUrl
        : parsed.sandboxApiUrl;
    const rec: RemoteRecord = {
      handle,
      sandboxApiUrl: parsed.sandboxApiUrl,
      previewUrl,
    };
    this.records.set(handle, rec);
    if (this.stateStore) {
      await this.stateStore.put(id, RUNNER_KIND, {
        handle,
        state: { handle, sandboxApiUrl: parsed.sandboxApiUrl, previewUrl },
      });
    }
    return this.toSandbox(rec);
  }

  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const body = JSON.stringify(input);
    const responseText = await this.dispatchJson(
      "POST",
      `/_sandbox/${encodeURIComponent(handle)}/exec`,
      body,
    );
    return JSON.parse(responseText) as ExecOutput;
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    // Callers pass full paths under the spawned daemon's `/_sandbox/*`
    // namespace (e.g. `/_sandbox/events`, `/_sandbox/config`). The dispatch
    // protocol uses the SAME `/_sandbox/<handle>/...` prefix for routing,
    // and the daemon's `handleStream` proxies to `http://…:<port>/_sandbox`
    // + the part AFTER the handle. So we strip the caller's `/_sandbox`
    // prefix before composing the dispatch path — otherwise the daemon
    // ends up fetching `http://…:<port>/_sandbox/_sandbox/<endpoint>` and
    // the spawned sandbox returns 404.
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const subPath = normalized.startsWith("/_sandbox/")
      ? normalized.slice("/_sandbox".length)
      : normalized;
    const targetPath = `/_sandbox/${encodeURIComponent(handle)}${subPath}`;
    const headers = new Headers(init.headers);
    // Strip hop-by-hop / auth headers — the daemon's control handler
    // re-injects the bearer `daemonToken` on the far side.
    for (const h of [
      "host",
      "cookie",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "authorization",
    ]) {
      headers.delete(h);
    }

    const flatHeaders: Record<string, string> = {};
    headers.forEach((v, k) => {
      flatHeaders[k] = v;
    });

    // Normalize body to string for the dispatch layer
    let bodyStr: string | undefined;
    if (init.body != null) {
      bodyStr = await normalizeBodyToString(init.body);
    }

    // Read the `headers` frame first (always emitted before any body chunks),
    // then return a Response whose body is a ReadableStream that pulls from
    // the dispatch iterator. Buffering the whole body before returning would
    // break SSE consumers (the daemon's `/_sandbox/events` never sends an
    // `end` frame), so vm-events would hang forever waiting for the buffered
    // Response that never resolves.
    const iter = this.dispatch(
      this.userSub,
      {
        method: init.method,
        path: targetPath,
        headers: flatHeaders,
        body: bodyStr,
      },
      { signal: init.signal },
    );
    const iterator = iter[Symbol.asyncIterator]();

    let status = 200;
    let respHeaders: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    // Buffer for any body chunks that arrived in the same loop tick as the
    // headers frame (the dispatcher can deliver several frames back-to-back).
    const initialChunks: string[] = [];
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.headers) {
          status = chunk.headers.status;
          respHeaders = chunk.headers.headers;
          break;
        }
        if (chunk.data != null) initialChunks.push(chunk.data);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "dispatch error";
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    // Track cancellation so a chunk that arrives after the consumer aborts
    // (in-flight `iterator.next()` resolves after `cancel()` fires) doesn't
    // try to enqueue on an already-closed controller.
    let canceled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const data of initialChunks)
          controller.enqueue(encoder.encode(data));
      },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (canceled) return;
          if (next.done) {
            controller.close();
            return;
          }
          const chunk = next.value;
          if (chunk.data != null)
            controller.enqueue(encoder.encode(chunk.data));
        } catch (err) {
          if (!canceled) controller.error(err);
        }
      },
      cancel() {
        canceled = true;
        // Propagate client cancellation to the dispatch iterator so the
        // daemon's `cancel` frame fires and frees server-side resources.
        void iterator.return?.();
      },
    });

    return new Response(body, { status, headers: respHeaders });
  }

  async alive(handle: string): Promise<boolean> {
    return this.probeHealth(handle);
  }

  /**
   * Probe daemon liveness for `handle` via dispatch.
   *
   * Hits `GET /api/sandboxes/<handle>` on the daemon (in-process control
   * handler), which returns 200 if the daemon either has a ready entry OR
   * is currently spawning one. We deliberately do NOT proxy through to the
   * spawned sub-daemon's `/_sandbox/health` — that 404s during the spawn
   * window, and vm-events translates 404 into `event: gone` + state-store
   * cleanup, which would tear down the sandbox the user is mid-start.
   *
   * 1500 ms cap (same as the old HMAC-HTTP path) so a slow NATS channel
   * doesn't block every `ensure`.
   */
  private async probeHealth(handle: string): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      await this.dispatchJson(
        "GET",
        `/api/sandboxes/${encodeURIComponent(handle)}`,
        undefined,
        ac.signal,
      );
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drop our knowledge of `handle` without contacting the daemon. The cluster
   * builds a fresh provider per request, so this provider instance's cache
   * is invisible to the next request — but within a single chat run the
   * harness can call `forgetHandle` to force re-resolution on the next proxy
   * call (auto-restart loop).
   */
  async forgetHandle(handle: string): Promise<void> {
    this.records.delete(handle);
    if (this.stateStore) {
      await this.stateStore.deleteByHandle(RUNNER_KIND, handle).catch(() => {});
    }
  }

  async delete(handle: string): Promise<void> {
    this.records.delete(handle);
    if (this.stateStore) {
      await this.stateStore.deleteByHandle(RUNNER_KIND, handle).catch(() => {
        // best-effort
      });
    }
    // Always tell the daemon to tear down.
    try {
      await this.dispatchJson(
        "DELETE",
        `/api/sandboxes/${encodeURIComponent(handle)}`,
      );
    } catch (err) {
      // 404 is fine — daemon may already have cleaned up.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404")) throw err;
    }
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.resolveRecord(handle);
    return rec?.previewUrl ?? null;
  }

  /**
   * Workdir lives on the desktop; cluster code never references it. Returning
   * null lets dispatch-run fall through to its default.
   */
  async localWorkdir(_handle: string): Promise<string | null> {
    return null;
  }

  // eslint-disable-next-line require-yield
  async *watchClaimLifecycle(
    _handle: string,
    _signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    yield { kind: "ready" };
  }

  // ---- Internal helpers -----------------------------------------------------

  private toSandbox(rec: RemoteRecord): Sandbox {
    return {
      handle: rec.handle,
      workdir: rec.sandboxApiUrl,
      previewUrl: rec.previewUrl,
    };
  }

  /**
   * Cache → state-store hydration. The cluster builds a fresh provider per
   * request so the in-process map is almost always empty.
   */
  private async resolveRecord(handle: string): Promise<RemoteRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    const persisted = row?.state as
      | { sandboxApiUrl?: string; previewUrl?: string }
      | undefined;
    const sandboxApiUrl = persisted?.sandboxApiUrl;
    if (!sandboxApiUrl) return null;
    const rec: RemoteRecord = {
      handle,
      sandboxApiUrl,
      previewUrl: persisted?.previewUrl ?? sandboxApiUrl,
    };
    this.records.set(handle, rec);
    return rec;
  }

  /**
   * Dispatch a control request and collect all response chunks into a single
   * string. Throws on dispatch error (non-200, timeout, etc.).
   */
  private async dispatchJson(
    method: string,
    path: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const iter = this.dispatch(
      this.userSub,
      { method, path, headers, body },
      { signal },
    );

    let status: number | null = null;
    let collected = "";
    for await (const chunk of iter) {
      if (chunk.headers) {
        status = chunk.headers.status;
      } else if (chunk.data != null) {
        collected += chunk.data;
      }
    }
    if (status != null && (status < 200 || status >= 300)) {
      throw new Error(`daemon returned ${status}: ${collected}`);
    }
    return collected;
  }
}

/**
 * Backwards-compatible factory. Construct via `new` is the canonical form.
 */
export function createDesktopProvider(
  opts: DesktopProviderOptions,
): DesktopSandboxProvider {
  return new DesktopSandboxProvider(opts);
}

// ---- Module-private helpers --------------------------------------------------

/**
 * Reduce a `ProxyRequestInit.body` (BodyInit | null) to a string.
 * Buffers and ArrayBuffers are decoded as UTF-8 because the daemon control
 * plane uses JSON exclusively; streams aren't supported here.
 */
async function normalizeBodyToString(body: BodyInit): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "utf8",
    );
  }
  if (body instanceof URLSearchParams) return body.toString();
  return await new Response(body).text();
}
