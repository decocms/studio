import { type OrgFsApi, OrgFsApiError, type OrgFsNode } from "./api";

/** A fetch-compatible function — injectable so tests can route to an in-process app. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OrgFsClientOptions {
  /** Studio base URL, e.g. https://cluster.deco.host (no trailing slash needed). */
  baseUrl: string;
  /** Immutable org slug (the `:org` path segment). */
  orgSlug: string;
  /** Volume to serve. */
  volume: string;
  /** Bearer token authorizing ORG_FS_READ/WRITE. */
  token: string;
  /** Override fetch (tests point this at an in-process Hono app). */
  fetch?: FetchLike;
}

/** Shape of an entry as returned by `/api/:org/fs/:volume/*`. */
interface ApiEntry {
  path: string;
  kind: "file" | "dir";
  size: number;
  updatedAt: string;
}

function toNode(e: ApiEntry): OrgFsNode {
  return { path: e.path, kind: e.kind, size: e.size, updatedAt: e.updatedAt };
}

/** One entry from the change feed (a live row or a tombstone). */
export interface OrgFsChange {
  path: string;
  /** Parent dir of `path` ("" = volume root) — the dir to invalidate. */
  parent: string;
  kind: "file" | "dir";
  /** Set when this change is a deletion. */
  deletedAt: string | null;
}

/** A page of the change feed. */
export interface OrgFsChangePage {
  entries: OrgFsChange[];
  /** Cursor to pass as `since` on the next poll. */
  cursor: string;
  /** A full page came back — poll again immediately rather than waiting. */
  hasMore: boolean;
}

/**
 * Daemon-side client for the studio org-fs HTTP contract. One instance per
 * (org, volume). Used by the WebDAV serve layer; never touches the DB.
 */
export class OrgFsClient implements OrgFsApi {
  private readonly base: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: OrgFsClientOptions) {
    this.base = `${opts.baseUrl.replace(/\/$/, "")}/api/${encodeURIComponent(
      opts.orgSlug,
    )}/fs/${encodeURIComponent(opts.volume)}`;
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private url(op: string, params?: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString();
    return `${this.base}/${op}${qs ? `?${qs}` : ""}`;
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` };
  }

  private async fail(res: Response): Promise<never> {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON body
    }
    throw new OrgFsApiError(res.status, detail || `HTTP ${res.status}`);
  }

  async listDir(path: string): Promise<OrgFsNode[]> {
    const res = await this.fetch(this.url("list", { path }), {
      headers: this.headers,
    });
    if (!res.ok) return this.fail(res);
    const body = (await res.json()) as { entries: ApiEntry[] };
    return body.entries.map(toNode);
  }

  async stat(path: string): Promise<OrgFsNode | null> {
    const res = await this.fetch(this.url("stat", { path }), {
      headers: this.headers,
    });
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res);
    const body = (await res.json()) as { entry: ApiEntry };
    return toNode(body.entry);
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await this.fetch(this.url("read", { path }), {
      headers: this.headers,
    });
    if (!res.ok) return this.fail(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async readResponse(path: string, range?: string): Promise<Response | null> {
    const presign = await this.fetch(this.url("read", { path, presign: "1" }), {
      headers: this.headers,
    });
    if (presign.status === 404) return this.fail(presign);
    if (!presign.ok) return null; // presign unavailable — buffered fallback
    const { url } = (await presign.json()) as { url: string };
    // Dev storage presigns to inline `data:` URLs (the full base64 payload) —
    // no push-down win there; the buffered path is strictly cheaper.
    if (!/^https?:/i.test(url)) return null;
    // Global fetch on purpose: the presigned URL is external to the studio (the
    // injected fetch only routes the studio contract).
    let res: Response;
    try {
      res = await fetch(url, range ? { headers: { range } } : undefined);
    } catch {
      // Presigned host unreachable from THIS network (e.g. a cluster pod or
      // remote desktop vs a localhost MinIO endpoint) — the studio can still
      // reach it, so fall back to the buffered read instead of erroring.
      return null;
    }
    if (res.status === 200 || res.status === 206 || res.status === 416) {
      return res;
    }
    return null; // expired/stale URL etc. — the buffered path is authoritative
  }

  async write(
    path: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    const res = await this.fetch(this.url("file", { path }), {
      method: "PUT",
      headers: {
        ...this.headers,
        "content-type": contentType ?? "application/octet-stream",
      },
      // Uint8Array is a valid fetch body; the cast sidesteps the DOM lib's
      // over-narrow BodyInit union.
      body: body as BodyInit,
    });
    if (!res.ok) return this.fail(res);
  }

  async mkdir(path: string): Promise<void> {
    const res = await this.fetch(this.url("dir", { path }), {
      method: "POST",
      headers: this.headers,
    });
    if (!res.ok) return this.fail(res);
  }

  async remove(path: string): Promise<void> {
    const res = await this.fetch(this.url("file", { path }), {
      method: "DELETE",
      headers: this.headers,
    });
    if (!res.ok) return this.fail(res);
  }

  async move(from: string, to: string): Promise<void> {
    const res = await this.fetch(this.url("move"), {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) return this.fail(res);
  }

  /**
   * Read the change feed from `since` ("0" = beginning). Drives the mount's
   * cache invalidation (see the daemon invalidator) — not part of OrgFsApi
   * since the WebDAV serve layer never needs it.
   *
   * `wait: true` long-polls: the server holds the request open until a write
   * nudges it or its hold timeout elapses, so the invalidator wakes on writes
   * instead of polling on a timer.
   */
  async changes(
    since: string,
    opts?: { limit?: number; wait?: boolean },
  ): Promise<OrgFsChangePage> {
    const params: Record<string, string> = { since };
    if (opts?.limit != null) params.limit = String(opts.limit);
    if (opts?.wait) params.wait = "1";
    const res = await this.fetch(this.url("changes", params), {
      headers: this.headers,
    });
    if (!res.ok) return this.fail(res);
    return (await res.json()) as OrgFsChangePage;
  }
}
