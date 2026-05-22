/**
 * desktop sandbox provider — cluster-side stub that forwards every
 * `SandboxProvider` call to a per-user `link` binary running on the
 * developer's desktop. The link exposes:
 *
 *   - `<tunnelUrl>/api/sandboxes`                 (POST: ensure, DELETE/<h>: tear down)
 *   - `<sandboxApiUrl>/_decopilot_vm/*`              (exec + daemon proxy passthrough)
 *   - `<sandboxApiUrl>/health`                       (alive probe)
 *
 * The control plane is authenticated with the link-protocol HMAC scheme. The
 * per-daemon `sandboxApiUrl` (returned by the link's `POST /api/sandboxes`)
 * is itself a daemon-authenticated URL — the daemon accepts the same HMAC
 * against `DAEMON_LINK_SECRET` (set up by Task 1). HMAC requires symmetric
 * key material; v2 will encrypt at rest with a cluster KMS key.
 *
 * The cluster builds a fresh `DesktopSandboxProvider` per request, so the
 * in-memory `records` map is almost always empty. To remain functional across
 * cluster pod boundaries we mirror docker's pattern: take a `stateStore` in
 * the constructor, persist `{handle, sandboxApiUrl}` on ensure, hydrate on cache
 * miss. The `records` map becomes an advisory in-process cache; the state
 * store is the canonical lookup.
 *
 * `localWorkdir` returns null — the workdir lives on the desktop and is never
 * referenced by cluster code. `watchClaimLifecycle` emits a single synthetic
 * `ready` phase, matching docker semantics — by the time `ensure`
 * resolves the link has already brought the daemon up.
 */

import { signRequest } from "../../../../../apps/mesh/src/links/protocol/hmac";
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

const RUNNER_KIND = "user-desktop" as const;

/**
 * Subset of `LinkEntry` the provider actually needs. The dispatch path passes
 * the full `LinkEntry` it pulled from the registry; we accept anything
 * structurally compatible so tests can fake it without inventing a
 * `createdAt` timestamp.
 */
export interface DesktopLinkRef {
  tunnelUrl: string;
  /**
   * HMAC signing key — the raw bearer secret stored in `LinkEntry`. Both
   * the cluster and the link sign with this same value (symmetric signing).
   */
  linkSecret: string;
}

export interface DesktopProviderOptions {
  link: DesktopLinkRef;
  /** @internal test seam */
  fetchImpl?: typeof fetch;
  /**
   * Persistent handle → URL store. Optional for compatibility with
   * in-process tests that don't need cross-instance hydration; the
   * cluster MUST pass one (KyselySandboxProviderStateStore) so a
   * fresh provider per request can still find a previously-ensured
   * sandbox. Same dependency the docker provider takes.
   */
  stateStore?: RunnerStateStoreOps;
}

interface RemoteRecord {
  handle: string;
  /** Daemon's public URL — `https://<handle>.deco.host` or `http://127.0.0.1:<port>`. */
  sandboxApiUrl: string;
}

export class DesktopSandboxProvider implements SandboxProvider {
  readonly kind = RUNNER_KIND;

  private readonly link: DesktopLinkRef;
  private readonly fetcher: typeof fetch;
  private readonly stateStore: RunnerStateStoreOps | null;
  private readonly records = new Map<string, RemoteRecord>();

  constructor(opts: DesktopProviderOptions) {
    if (!opts.link?.tunnelUrl) {
      throw new Error("DesktopSandboxProvider requires link.tunnelUrl");
    }
    if (!opts.link?.linkSecret) {
      throw new Error("DesktopSandboxProvider requires link.linkSecret");
    }
    this.link = opts.link;
    this.fetcher = opts.fetchImpl ?? fetch;
    this.stateStore = opts.stateStore ?? null;
  }

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    // hashLen=16 mirrors agent-sandbox and the cluster's `computeClaimHandle`
    // — `<handle>.deco.host` is a public hostname, so a short hash is
    // brute-forceable at the deco.host gateway. If this changes, the
    // matching constant in `apps/mesh/src/sandbox/claim-handle.ts` must
    // change too or the cluster's state-store lookup will silently miss.
    const handle = computeHandle(id, opts.repo?.branch, { hashLen: 16 });

    const cached = this.records.get(handle);
    if (cached) return this.toSandbox(cached);

    if (this.stateStore) {
      const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
      const sandboxApiUrl = (
        row?.state as { sandboxApiUrl?: string } | undefined
      )?.sandboxApiUrl;
      if (sandboxApiUrl) {
        const rec: RemoteRecord = { handle, sandboxApiUrl };
        this.records.set(handle, rec);
        return this.toSandbox(rec);
      }
    }

    const res = await this.signedFetch("POST", "/api/sandboxes", {
      handle,
      repo: opts.repo,
      branch: opts.repo?.branch,
    });
    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new Error(
        `desktop ensure failed: ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    const body = (await res.json()) as { sandboxApiUrl?: unknown };
    if (typeof body.sandboxApiUrl !== "string") {
      throw new Error(
        "desktop ensure: link did not return a sandboxApiUrl string",
      );
    }
    const rec: RemoteRecord = { handle, sandboxApiUrl: body.sandboxApiUrl };
    this.records.set(handle, rec);
    if (this.stateStore) {
      await this.stateStore.put(id, RUNNER_KIND, {
        handle,
        state: { handle, sandboxApiUrl: body.sandboxApiUrl },
      });
    }
    return this.toSandbox(rec);
  }

  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const rec = await this.resolveRecord(handle);
    if (!rec) {
      throw new Error(
        `desktop provider: unknown handle "${handle}" — was ensure() called?`,
      );
    }
    const bodyString = JSON.stringify(input);
    const targetUrl = `${rec.sandboxApiUrl}/_decopilot_vm/exec`;
    const sig = signRequest({
      secret: this.link.linkSecret,
      method: "POST",
      path: new URL(targetUrl).pathname,
      body: bodyString,
    });
    const res = await this.fetcher(targetUrl, {
      method: "POST",
      headers: { ...sig, "content-type": "application/json" },
      body: bodyString,
    });
    if (!res.ok) {
      const detail = await safeReadText(res);
      throw new Error(
        `desktop exec failed: ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    return (await res.json()) as ExecOutput;
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const rec = await this.resolveRecord(handle);
    if (!rec) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const fullPath = path.startsWith("/") ? path : `/${path}`;
    const targetUrl = `${rec.sandboxApiUrl}${fullPath}`;
    const body = await normalizeBodyForSigning(init.body);
    const headers = new Headers(init.headers);
    // Strip hop-by-hop / cookie headers; HMAC headers replace any client-set
    // signature header.
    for (const h of [
      "host",
      "cookie",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "x-mesh-signature",
      "x-mesh-timestamp",
      "x-mesh-nonce",
      "authorization",
    ]) {
      headers.delete(h);
    }
    const sig = signRequest({
      secret: this.link.linkSecret,
      method: init.method,
      path: new URL(targetUrl).pathname,
      body,
    });
    for (const [k, v] of Object.entries(sig)) headers.set(k, v);
    return this.fetcher(targetUrl, {
      method: init.method,
      headers,
      body: body.length > 0 ? body : null,
      signal: init.signal,
    });
  }

  async alive(handle: string): Promise<boolean> {
    // The daemon's /health endpoint is unauthenticated; probe it directly.
    // Hydrate the {handle → sandboxApiUrl} mapping from the state store on
    // cache miss so a fresh provider in a different pod can still reach
    // the daemon.
    const rec = await this.resolveRecord(handle);
    if (!rec) return false;
    try {
      const res = await this.fetcher(`${rec.sandboxApiUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async delete(handle: string): Promise<void> {
    const rec = this.records.get(handle);
    this.records.delete(handle);
    if (this.stateStore) {
      await this.stateStore.deleteByHandle(RUNNER_KIND, handle).catch(() => {
        // best-effort — state-store row may already be gone
      });
    }
    // Always tell the link to tear down, even if we lost our cached record —
    // the link is authoritative for sandbox lifecycle and may still hold the
    // daemon process.
    const res = await this.signedFetch(
      "DELETE",
      `/api/sandboxes/${encodeURIComponent(handle)}`,
    );
    if (!res.ok && res.status !== 404) {
      const detail = await safeReadText(res);
      throw new Error(
        `desktop delete failed: ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    // Hint to dead-code: rec read only for symmetry / future logging.
    void rec;
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.resolveRecord(handle);
    return rec?.sandboxApiUrl ?? null;
  }

  /**
   * Workdir lives on the desktop; cluster code never references it. Returning
   * null lets dispatch-run fall through to its default (`process.cwd()`),
   * which is fine because cluster-side dispatch for `desktop` is the
   * decopilot Code Sandbox tool path — the harness itself runs on the
   * desktop, where `localWorkdir` IS meaningful (different provider).
   */
  async localWorkdir(_handle: string): Promise<string | null> {
    return null;
  }

  // Same shape as host/docker/freestyle: a single synthetic `ready` is the
  // only honest answer here. By the time `ensure` resolves the link has
  // already brought the daemon up — there is no separately-observable
  // pre-Ready window worth surfacing back to the UI.
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
      // workdir is opaque to the cluster — surface the sandboxApiUrl so debug
      // logs that include `sandbox.workdir` show something meaningful, but
      // anything that tries to fs.stat() this string will (correctly) fail.
      workdir: rec.sandboxApiUrl,
      previewUrl: rec.sandboxApiUrl,
    };
  }

  /**
   * Cache → state-store hydration. The cluster builds a fresh provider per
   * request, so the in-process `records` map is almost always empty even
   * when the link previously ensured this handle. Falling back to the state
   * store is what keeps alive/proxy/exec working across pod boundaries.
   */
  private async resolveRecord(handle: string): Promise<RemoteRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const row = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    const sandboxApiUrl = (row?.state as { sandboxApiUrl?: string } | undefined)
      ?.sandboxApiUrl;
    if (!sandboxApiUrl) return null;
    const rec: RemoteRecord = { handle, sandboxApiUrl };
    this.records.set(handle, rec);
    return rec;
  }

  private async signedFetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const bodyString = body === undefined ? "" : JSON.stringify(body);
    const sig = signRequest({
      secret: this.link.linkSecret,
      method,
      path,
      body: bodyString,
    });
    const headers: Record<string, string> = {
      ...sig,
    };
    if (bodyString.length > 0) headers["content-type"] = "application/json";
    return this.fetcher(`${this.link.tunnelUrl}${path}`, {
      method,
      headers,
      body: bodyString.length > 0 ? bodyString : undefined,
    });
  }
}

/**
 * Backwards-compatible factory matching the shape Phase 5 was originally
 * sketched against in the plan. Construct via `new` is the canonical form;
 * this exists so callers don't have to update if they're already importing
 * `createDesktopProvider`.
 */
export function createDesktopProvider(
  opts: DesktopProviderOptions,
): DesktopSandboxProvider {
  return new DesktopSandboxProvider(opts);
}

// ---- Module-private helpers --------------------------------------------------

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return "";
  }
}

/**
 * Reduce a `ProxyRequestInit.body` (BodyInit | null) to the string form HMAC
 * signing expects. Buffers and ArrayBuffers are decoded as UTF-8 because the
 * daemon control plane uses JSON exclusively; streams aren't supported here
 * (decopilot doesn't proxy file uploads through the daemon today). If a
 * future caller needs binary body support we'll have to switch the signing
 * scheme to a content-hash header — punted to a follow-up.
 */
async function normalizeBodyForSigning(body: BodyInit | null): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString(
      "utf8",
    );
  }
  if (body instanceof URLSearchParams) return body.toString();
  // Fallback: drive it through Response.text() so Blob/FormData callers at
  // least get a deterministic serialization. This is best-effort — callers
  // sending FormData through proxyDaemonRequest are out-of-band.
  return await new Response(body).text();
}
