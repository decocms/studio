/**
 * Minimal GitHub Git Data (+ merges/pulls/compare) client for the sandbox-less
 * decofile API. Raw fetch, no SDK — mirrors the header/UA conventions of
 * `shared/github-runtime-detect.ts`, but errors PROPAGATE (a failed write must
 * surface, not degrade to null).
 *
 * The base URL is overridable so the e2e suite can point the whole client at a
 * local stub — tests must never reach api.github.com.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** e2e seam: set GITHUB_API_BASE_URL to a local stub. Read per call site so a
 * long-lived process (dev server) and the test webServer agree on one value. */
function githubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
}

/**
 * Conditional-request cache: url -> { etag, body }. GitHub serves 304s for
 * matching `If-None-Match` and those do NOT count against the primary rate
 * limit, so re-reads of hot mutable endpoints (ref resolves, compares, repo
 * meta) become rate-limit-free when nothing changed. Module-level because a
 * client instance lives for one HTTP request.
 *
 * Content-addressed payloads (blobs, trees, tarballs) are excluded: they are
 * immutable per sha and already cached at the read layer, so an ETag entry
 * would never be re-requested — it would only duplicate large bodies here.
 *
 * Keyed by URL alone, NOT by token: a 304 is only ever served after GitHub
 * authorized THIS request's token, so a cached body is never revealed to a
 * caller GitHub itself would refuse.
 */
const ETAG_CACHE_MAX = 512;
const etagCache = new Map<string, { etag: string; body: unknown }>();

function etagCacheable(method: string, path: string): boolean {
  return (
    method === "GET" &&
    !path.includes("/git/blobs/") &&
    !path.includes("/git/trees/") &&
    !path.includes("/tarball/")
  );
}

function etagCachePut(url: string, etag: string, body: unknown): void {
  etagCache.delete(url);
  etagCache.set(url, { etag, body });
  if (etagCache.size > ETAG_CACHE_MAX) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) etagCache.delete(oldest);
  }
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(`GitHub ${method} ${path} failed (${status}): ${message}`);
    this.name = "GitHubApiError";
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/** Tree write entry — `sha: null` deletes the path (Git Data API contract). */
export interface TreeWriteEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

export interface PullRequestInfo {
  number: number;
  html_url: string;
}

export interface GitDataClient {
  readonly owner: string;
  readonly repo: string;
  getDefaultBranch(): Promise<string>;
  getHeadSha(branch: string): Promise<string>;
  /**
   * Gzipped tar of the repo at `ref` — ONE request for every file, vs one
   * blob request per block. The preferred cold-read path; callers fall back
   * to tree+blob reads when the server doesn't support it (the e2e stub).
   */
  getTarball(ref: string): Promise<Uint8Array>;
  getCommitTreeSha(commitSha: string): Promise<string>;
  getTreeRecursive(treeSha: string): Promise<TreeEntry[]>;
  getBlobText(blobSha: string): Promise<string>;
  createBlob(content: string): Promise<string>;
  createTree(baseTreeSha: string, entries: TreeWriteEntry[]): Promise<string>;
  createCommit(params: {
    message: string;
    treeSha: string;
    parentSha: string;
  }): Promise<string>;
  /** Non-forced ref update; throws GitHubApiError(422) on non-fast-forward. */
  updateRef(branch: string, sha: string): Promise<void>;
  /** Create `refs/heads/<branch>` at `sha`; GitHubApiError(422) if it exists. */
  createRef(branch: string, sha: string): Promise<void>;
  /** Returns the merge commit sha, or null when base already contains head. */
  mergeBranch(
    base: string,
    head: string,
    message: string,
  ): Promise<string | null>;
  createPullRequest(params: {
    base: string;
    head: string;
    title: string;
  }): Promise<PullRequestInfo>;
  findOpenPullRequest(
    base: string,
    head: string,
  ): Promise<PullRequestInfo | null>;
  compare(
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }>;
  /** Compare with per-file detail — feeds the sandbox-less `/git/*` compat. */
  compareDetailed(
    base: string,
    head: string,
  ): Promise<{
    aheadBy: number;
    behindBy: number;
    mergeBaseSha: string;
    files: Array<{
      filename: string;
      status: string;
      sha: string;
      previousFilename?: string;
    }>;
  }>;
}

export function createGitDataClient(params: {
  owner: string;
  repo: string;
  accessToken: string;
}): GitDataClient {
  const { owner, repo, accessToken } = params;
  const repoBase = `/repos/${owner}/${repo}`;
  let defaultBranch: string | null = null;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allow?: number[] },
  ): Promise<{ status: number; json: T }> {
    const url = `${githubApiBaseUrl()}${path}`;
    const conditional = etagCacheable(method, path)
      ? etagCache.get(url)
      : undefined;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "studio-decofile",
        Authorization: `token ${accessToken}`,
        ...(conditional ? { "If-None-Match": conditional.etag } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (conditional && res.status === 304) {
      return { status: 200, json: conditional.body as T };
    }
    if (!res.ok && !opts?.allow?.includes(res.status)) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep raw text
      }
      throw new GitHubApiError(res.status, method, path, message);
    }
    const json =
      res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    if (res.status === 200 && etagCacheable(method, path)) {
      const etag = res.headers.get("etag");
      if (etag) etagCachePut(url, etag, json);
    }
    return { status: res.status, json };
  }

  return {
    owner,
    repo,

    async getDefaultBranch() {
      if (defaultBranch) return defaultBranch;
      const { json } = await call<{ default_branch: string }>("GET", repoBase);
      defaultBranch = json.default_branch;
      return defaultBranch;
    },

    async getHeadSha(branch) {
      const { json } = await call<{ object: { sha: string } }>(
        "GET",
        `${repoBase}/git/ref/heads/${encodeRefPath(branch)}`,
      );
      return json.object.sha;
    },

    async getTarball(ref) {
      // Redirects to codeload; fetch follows them. Longer deadline — this is
      // one multi-MB download instead of hundreds of small calls.
      const path = `${repoBase}/tarball/${encodeRefPath(ref)}`;
      const res = await fetch(`${githubApiBaseUrl()}${path}`, {
        headers: {
          "User-Agent": "studio-decofile",
          Authorization: `token ${accessToken}`,
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new GitHubApiError(res.status, "GET", path, text.slice(0, 300));
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async getCommitTreeSha(commitSha) {
      const { json } = await call<{ tree: { sha: string } }>(
        "GET",
        `${repoBase}/git/commits/${commitSha}`,
      );
      return json.tree.sha;
    },

    async getTreeRecursive(treeSha) {
      const { json } = await call<{ tree: TreeEntry[]; truncated: boolean }>(
        "GET",
        `${repoBase}/git/trees/${treeSha}?recursive=1`,
      );
      if (json.truncated) {
        // 100k-entry / 7MB response cap. A repo this size needs pagination by
        // subtree; fail loudly rather than serving a silently partial decofile.
        throw new GitHubApiError(
          502,
          "GET",
          `${repoBase}/git/trees/${treeSha}`,
          "tree listing truncated by GitHub; repo too large for recursive read",
        );
      }
      return json.tree;
    },

    async getBlobText(blobSha) {
      const { json } = await call<{ content: string; encoding: string }>(
        "GET",
        `${repoBase}/git/blobs/${blobSha}`,
      );
      if (json.encoding !== "base64") {
        throw new GitHubApiError(
          502,
          "GET",
          `${repoBase}/git/blobs/${blobSha}`,
          `unexpected blob encoding ${json.encoding}`,
        );
      }
      return Buffer.from(json.content, "base64").toString("utf-8");
    },

    async createBlob(content) {
      const { json } = await call<{ sha: string }>(
        "POST",
        `${repoBase}/git/blobs`,
        { content, encoding: "utf-8" },
      );
      return json.sha;
    },

    async createTree(baseTreeSha, entries) {
      const { json } = await call<{ sha: string }>(
        "POST",
        `${repoBase}/git/trees`,
        { base_tree: baseTreeSha, tree: entries },
      );
      return json.sha;
    },

    async createCommit({ message, treeSha, parentSha }) {
      const { json } = await call<{ sha: string }>(
        "POST",
        `${repoBase}/git/commits`,
        { message, tree: treeSha, parents: [parentSha] },
      );
      return json.sha;
    },

    async updateRef(branch, sha) {
      await call(
        "PATCH",
        `${repoBase}/git/refs/heads/${encodeRefPath(branch)}`,
        {
          sha,
          force: false,
        },
      );
    },

    async createRef(branch, sha) {
      await call("POST", `${repoBase}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    },

    async mergeBranch(base, head, message) {
      const { status, json } = await call<{ sha?: string } | undefined>(
        "POST",
        `${repoBase}/merges`,
        { base, head, commit_message: message },
        { allow: [204] },
      );
      // 204 = base already contains head; 201 carries the merge commit.
      return status === 204 ? null : (json?.sha ?? null);
    },

    async createPullRequest({ base, head, title }) {
      const { json } = await call<PullRequestInfo>(
        "POST",
        `${repoBase}/pulls`,
        { base, head, title },
      );
      return { number: json.number, html_url: json.html_url };
    },

    async findOpenPullRequest(base, head) {
      const { json } = await call<PullRequestInfo[]>(
        "GET",
        `${repoBase}/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${head}`)}`,
      );
      const first = json[0];
      return first ? { number: first.number, html_url: first.html_url } : null;
    },

    async compare(base, head) {
      const { json } = await call<{ ahead_by: number; behind_by: number }>(
        "GET",
        `${repoBase}/compare/${encodeRefPath(base)}...${encodeRefPath(head)}`,
      );
      return { aheadBy: json.ahead_by, behindBy: json.behind_by };
    },

    async compareDetailed(base, head) {
      const { json } = await call<{
        ahead_by: number;
        behind_by: number;
        merge_base_commit: { sha: string };
        files?: Array<{
          filename: string;
          status: string;
          sha: string;
          previous_filename?: string;
        }>;
      }>(
        "GET",
        `${repoBase}/compare/${encodeRefPath(base)}...${encodeRefPath(head)}`,
      );
      return {
        aheadBy: json.ahead_by,
        behindBy: json.behind_by,
        mergeBaseSha: json.merge_base_commit.sha,
        files: (json.files ?? []).map((f) => ({
          filename: f.filename,
          status: f.status,
          sha: f.sha,
          ...(f.previous_filename
            ? { previousFilename: f.previous_filename }
            : {}),
        })),
      };
    },
  };
}

/** Encode a branch name for a ref path segment, preserving `/` separators. */
function encodeRefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
