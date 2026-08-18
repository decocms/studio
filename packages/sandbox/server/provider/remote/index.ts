/**
 * `SandboxProvider` over HTTP to the sandbox controller.
 *
 * Studio holds no infrastructure credential under this provider: no
 * kubeconfig, no CRD verbs, no `pods/portforward`. What it does keep is the
 * daemon conversation — the controller returns an address and a token, and the
 * fetches below go straight to the pod. Nothing streams through the
 * controller, so preview SSE, dispatch bodies and websocket upgrades are
 * exactly the traffic they were before the split.
 */

import { proxyDaemonRequest as fetchDaemon } from "../../daemon-client";
import { computeHandle } from "../shared";
import type { ClaimPhase } from "../lifecycle-types";
import type {
  EnsureOptions,
  PodTermination,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxProvider,
} from "../types";
import type {
  AdoptResponse,
  CapacityResponse,
  DaemonAddress,
  EnsureRequest,
  EnsureResponse,
  LifetimeRequest,
  StatusResponse,
} from "./protocol";

export interface RemoteSandboxProviderOptions {
  /** e.g. `https://sandbox-controller.deco-studio.svc.cluster.local:8443`. */
  baseUrl: string;
  /** Bearer for deploys without mTLS (dev, single-host). */
  token?: string;
  /** Client cert + trust root. Both peers are installed together; this is the intended auth. */
  tls?: { cert: string; key: string; ca?: string };
  /** Runtime name passed through on every ensure. Opaque to studio. */
  runtime?: string;
  /** Ceiling on control-plane calls. Daemon traffic is not routed through here. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 240_000;

export class RemoteSandboxProvider implements SandboxProvider {
  readonly kind = "remote" as const;
  private readonly base: string;
  private readonly timeoutMs: number;
  /**
   * Daemon address + token per handle. A 401 invalidates the entry and the
   * call is retried once — the same invalidate-and-retry the in-process runner
   * does inline when a warm-pool pod rotates its bearer underneath us.
   */
  private readonly daemons = new Map<string, DaemonAddress>();

  constructor(private readonly opts: RemoteSandboxProviderOptions) {
    let base = opts.baseUrl;
    // Linear trim instead of /\/+$/ (CodeQL js/polynomial-redos).
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.base = base;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private controllerFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.opts.token) {
      headers.set("authorization", `Bearer ${this.opts.token}`);
    }
    return fetch(`${this.base}${path}`, {
      ...init,
      headers,
      // Bun honours per-request client certs; node/undici ignores the field.
      ...(this.opts.tls ? { tls: this.opts.tls } : {}),
    } as RequestInit);
  }

  /** JSON call with a deadline. An unexpected status becomes an Error carrying the body. */
  private async json<T>(
    path: string,
    init: RequestInit = {},
    okStatuses: number[] = [200, 201, 204],
  ): Promise<{ status: number; body: T | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.controllerFetch(path, {
        ...init,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!okStatuses.includes(res.status)) {
        throw new Error(
          `sandbox-controller ${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 500)}`,
        );
      }
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as T) : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // Handles stay studio-derived: `claim-handle.ts` recomputes them without a
    // DB read to route preview traffic, and a handle that can disagree with
    // itself is a bug this codebase has already paid for.
    const handle = computeHandle(id);
    const payload: EnsureRequest = { id, opts, runtime: this.opts.runtime };
    const { body } = await this.json<EnsureResponse>(
      `/sandboxes?handle=${encodeURIComponent(handle)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!body) throw new Error("sandbox-controller: empty ensure response");
    this.daemons.set(body.handle, body.daemon);
    return {
      handle: body.handle,
      workdir: body.workdir,
      previewUrl: body.previewUrl,
    };
  }

  /**
   * Blocks until the sandbox is collected. 202 means "still draining" — a
   * retry, not success: a caller mid-rebind must not `ensure()` on it, or two
   * daemons end up holding the same git branch.
   */
  async delete(handle: string): Promise<void> {
    const { status } = await this.json<{ state: string }>(
      `/sandboxes/${encodeURIComponent(handle)}`,
      { method: "DELETE" },
      [200, 202, 204, 404],
    );
    this.daemons.delete(handle);
    if (status === 202) {
      throw new Error(
        `sandbox-controller: ${handle} still draining after the controller's deadline — retry`,
      );
    }
  }

  private status(handle: string): Promise<StatusResponse | null> {
    return this.json<StatusResponse>(
      `/sandboxes/${encodeURIComponent(handle)}`,
      {},
      [200, 404],
    ).then(({ status, body }) => (status === 404 ? null : body));
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

  private async lifetime(handle: string, body: LifetimeRequest): Promise<void> {
    await this.json(
      `/sandboxes/${encodeURIComponent(handle)}/lifetime`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      [200, 204, 404],
    );
  }

  renewTtl(handle: string): Promise<void> {
    return this.lifetime(handle, { extendToIdleWindow: true });
  }

  releaseAfter(handle: string, graceMs: number): Promise<void> {
    return this.lifetime(handle, { graceMs });
  }

  /**
   * Drop the cached daemon address without contacting anything. The
   * controller's own cache is its business; `delete()` is the call that ends a
   * sandbox.
   */
  async forgetHandle(handle: string): Promise<void> {
    this.daemons.delete(handle);
  }

  async hasSchedulableCapacity(): Promise<boolean> {
    const { body } = await this.json<CapacityResponse>("/capacity");
    return body?.schedulable ?? true;
  }

  async adoptLiveClaim(id: SandboxId, handle: string): Promise<boolean> {
    const { body } = await this.json<AdoptResponse>(
      `/sandboxes/${encodeURIComponent(handle)}/adopt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      },
      [200, 404],
    );
    if (body?.adopted) this.daemons.delete(handle);
    return body?.adopted ?? false;
  }

  /** Cached address, refetched on a miss or after a 401. */
  private async daemonAddress(
    handle: string,
    refresh = false,
  ): Promise<DaemonAddress | null> {
    if (!refresh) {
      const cached = this.daemons.get(handle);
      if (cached) return cached;
    }
    const daemon = (await this.status(handle))?.daemon ?? null;
    if (daemon) this.daemons.set(handle, daemon);
    else this.daemons.delete(handle);
    return daemon;
  }

  /**
   * Straight to the pod. The controller told us where and with what; it never
   * sees these bytes, which is what keeps streaming dispatch bodies and SSE
   * out of a second hop.
   */
  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const daemon = await this.daemonAddress(handle);
    if (!daemon) {
      return new Response("sandbox not found", { status: 404 });
    }
    const first = await fetchDaemon(daemon.url, daemon.token, path, init);
    if (first.status !== 401) return first;
    // The token rotated under us (pool rebind, adopt). Re-read and retry once
    // — but only when the body can be replayed.
    const rotated = await this.daemonAddress(handle, true);
    if (!rotated || rotated.token === daemon.token) return first;
    return fetchDaemon(rotated.url, rotated.token, path, init);
  }

  /**
   * Preview upstream, for the edge proxy and websocket upgrades. Always the
   * daemon's port, never the dev server's: the daemon strips CSP/X-Frame and
   * injects the HMR bootstrap vite needs inside the studio iframe.
   */
  async resolvePreviewUpstreamUrl(handle: string): Promise<string | null> {
    return (await this.daemonAddress(handle))?.url ?? null;
  }

  /** Preview reverse-proxy for deploys with no per-claim gateway route. */
  async proxyPreviewRequest(
    handle: string,
    request: Request,
  ): Promise<Response> {
    const upstream = await this.resolvePreviewUpstreamUrl(handle);
    if (!upstream) {
      return new Response("sandbox not found", { status: 404 });
    }
    const incoming = new URL(request.url);
    const target = new URL(upstream);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      duplex: "half",
    } as RequestInit);
  }

  async *watchClaimLifecycle(
    handle: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    const res = await this.controllerFetch(
      `/sandboxes/${encodeURIComponent(handle)}/events`,
      { headers: { accept: "text/event-stream" }, signal },
    );
    if (!res.ok || !res.body) {
      yield {
        kind: "failed",
        reason: "unknown",
        message: `controller events ${res.status}`,
      };
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += value;
        // SSE frames are separated by a blank line; only `data:` is emitted.
        let sep = buf.indexOf("\n\n");
        for (; sep !== -1; sep = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (!data) continue;
          const phase = JSON.parse(data) as ClaimPhase;
          yield phase;
          if (phase.kind === "ready" || phase.kind === "failed") return;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
