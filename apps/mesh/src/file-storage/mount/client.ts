import { type OrgFsApi, OrgFsApiError, type OrgFsNode } from "./api";

/** A fetch-compatible function — injectable so tests can route to an in-process app. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OrgFsClientOptions {
  /** Mesh base URL, e.g. https://cluster.deco.host (no trailing slash needed). */
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

/**
 * Daemon-side client for the mesh org-fs HTTP contract. One instance per
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
}
