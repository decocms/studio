/**
 * Minimal GitHub Git Data (+ merges/pulls/compare) client for the sandbox-less
 * decofile API. Raw fetch, no SDK — mirrors the header/UA conventions of
 * `shared/github-runtime-detect.ts`, but errors PROPAGATE (a failed write must
 * surface, not degrade to null).
 *
 * The base URL is overridable so the e2e suite can point the whole client at a
 * local stub — tests must never reach api.github.com.
 */

import {
  countGithubRateLimited,
  githubRetryAfterMs,
  isGithubRateLimited,
  recordGithubRateLimit,
} from "@/observability/github-rate-limit";

const DEFAULT_TIMEOUT_MS = 15_000;

/** e2e seam: set GITHUB_API_BASE_URL to a local stub. Read per call site so a
 * long-lived process (dev server) and the test webServer agree on one value. */
function githubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
}

/**
 * `default_branch` per repo, cached across requests — a client instance lives
 * for ONE of them (see `client-for-repo.ts`), so its own memo never survives.
 *
 * Ten minutes, not an hour: a renamed default branch compares against a branch
 * that no longer exists until this expires. Keyed by full URL, so the e2e stub
 * and api.github.com can never share an entry.
 */
const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;
const defaultBranchCache = new Map<string, { value: string; at: number }>();

function cachedDefaultBranch(url: string): string | null {
  const hit = defaultBranchCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > DEFAULT_BRANCH_TTL_MS) {
    defaultBranchCache.delete(url);
    return null;
  }
  return hit.value;
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
/** Byte budget across all stored bodies (approximated as the JSON.stringify
 * length, computed once at insert). Primary bound; entry count is secondary. */
const ETAG_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** Bodies over this are not cached at all — one huge response must not evict
 * the whole working set. */
const ETAG_CACHE_MAX_BODY_BYTES = 256 * 1024;
const etagCache = new Map<
  string,
  { etag: string; body: unknown; bytes: number }
>();
let etagCacheBytes = 0;

function etagCacheable(method: string, path: string): boolean {
  return (
    method === "GET" &&
    !path.includes("/git/blobs/") &&
    !path.includes("/git/trees/") &&
    // `/contents/{path}?ref=<sha>` is sha-pinned, hence content-addressed too.
    !path.includes("/contents/") &&
    !path.includes("/tarball/")
  );
}

function etagCacheDelete(url: string): void {
  const existing = etagCache.get(url);
  if (!existing) return;
  etagCache.delete(url);
  etagCacheBytes -= existing.bytes;
}

function etagCachePut(url: string, etag: string, body: unknown): void {
  let bytes: number;
  try {
    bytes = JSON.stringify(body)?.length ?? 0;
  } catch {
    return; // unserializable body — don't cache
  }
  etagCacheDelete(url);
  if (bytes > ETAG_CACHE_MAX_BODY_BYTES) return; // stale entry already dropped
  etagCache.set(url, { etag, body, bytes });
  etagCacheBytes += bytes;
  while (
    etagCacheBytes > ETAG_CACHE_MAX_BYTES ||
    etagCache.size > ETAG_CACHE_MAX
  ) {
    const oldest = etagCache.keys().next().value;
    if (oldest === undefined) break;
    etagCacheDelete(oldest);
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

/**
 * GitHub refused the call for rate reasons. NOT retriable: retrying a secondary
 * limit is the burst being limited. `retryAfterMs` tells the caller when to come
 * back; it is never slept on inside a request.
 */
export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    status: number,
    method: string,
    path: string,
    readonly kind: "primary" | "secondary",
    readonly retryAfterMs: number | null,
  ) {
    super(
      status,
      method,
      path,
      `GitHub ${kind} rate limit reached${
        retryAfterMs === null
          ? ""
          : `; retry in ${Math.ceil(retryAfterMs / 1000)}s`
      }`,
    );
    this.name = "GitHubRateLimitError";
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  /** Blob byte size — GitHub returns it for blob entries (absent for
   * trees/commits). Feeds the cold-read tarball pre-validation. */
  size?: number;
}

/** Tree write entry — `sha: null` deletes the path (Git Data API contract). */
export interface TreeWriteEntry {
  path: string;
  /** Git file mode: "100644" for a new file, else the source entry's own. */
  mode: string;
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
   * Branch head sha + the head commit's committer date, in one call. Git stores
   * no ref-creation time, so this date is the branch's last-activity signal: a
   * branch that was edited carries its last edit's date; a branch cut from the
   * default branch and never touched carries the base commit's date (old the
   * moment it lags behind an advancing default branch). The CMS staleness check
   * reads it. Throws GitHubApiError(404) for a branch not yet on GitHub.
   */
  getBranchHead(branch: string): Promise<{ sha: string; committedAt: string }>;
  /**
   * Gzipped tar of the repo at `ref`, as a stream — ONE request for every
   * file, vs one blob request per block. The preferred cold-read path. The
   * body is NEVER buffered here (golden rule 1: the archive must not touch
   * the JS heap); the caller pipes it straight into a `tar` subprocess.
   * Callers fall back to tree+blob reads when the server doesn't support it
   * (the e2e stub) or the download/extraction fails.
   */
  getTarballStream(ref: string): Promise<ReadableStream<Uint8Array>>;
  getCommitTreeSha(commitSha: string): Promise<string>;
  /**
   * Block-dir view of a commit's tree WITHOUT a whole-repo recursive read.
   * A whole-repo recursive read on the root tree of a large repo trips GitHub's
   * 100k-entry / 7MB recursive cap (`truncated: true` → hard 502), which broke
   * every decofile read/write on big storefronts. Instead this walks
   * `<packagePath>/.deco/` non-recursively and returns only the block sources
   * (`<dir>/.deco/blocks/*.json`) plus the merged artifact
   * (`<dir>/.deco/blocks.gen.json`) when the repo commits it — the whole set the
   * decofile read/merge and the commit coalescer consume. Paths are full and
   * repo-relative, so `blockEntriesInTree` and the gen-file check operate on the
   * result unchanged. Empty when the project has no `.deco/` yet.
   */
  getDecofileTree(
    commitTreeSha: string,
    packagePath: string | null,
  ): Promise<TreeEntry[]>;
  /**
   * Blob entries for a bounded, caller-known set of paths — the same
   * 502-on-large-repo cap `getDecofileTree` dodges for decofile reads, but for
   * callers that already know exactly which paths they need (discard's
   * `filepaths`, the branch-wins merge's changed-file list) instead of a
   * whole subdirectory. Walks only the directories those paths live in, so
   * cost scales with the path set, never with repo size. A path absent at
   * this commit (deleted, or never existed) is omitted from the map.
   */
  getBlobsAtPaths(
    commitTreeSha: string,
    paths: string[],
  ): Promise<Map<string, TreeEntry>>;
  getBlobText(blobSha: string): Promise<string>;
  /**
   * One file's text at a ref, addressed by PATH rather than blob sha — null when
   * the path does not exist there. The base side of a diff needs this: the
   * compare response's `files[].sha` is the HEAD blob, never the base one.
   */
  getFileTextAtRef(ref: string, filePath: string): Promise<string | null>;
  createBlob(content: string): Promise<string>;
  createTree(baseTreeSha: string, entries: TreeWriteEntry[]): Promise<string>;
  createCommit(params: {
    message: string;
    treeSha: string;
    /** One parent for a plain commit; two (ours, theirs) for a merge commit. */
    parentShas: string[];
  }): Promise<string>;
  /**
   * Ref update, non-forced by default: a concurrent writer makes it fail
   * non-fast-forward (GitHubApiError 422) instead of being clobbered, which is
   * the commit coalescer's multi-replica safety property.
   *
   * `force: true` rewrites history and there is NO compare-and-swap available:
   * GitHub's ref API accepts no `If-Match`, so a forced caller must re-read the
   * head itself immediately before forcing (see `githubGitRebase`).
   */
  updateRef(
    branch: string,
    sha: string,
    opts?: { force?: boolean },
  ): Promise<void>;
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
    /**
     * Messages of the commits on `head` that `base` lacks — the set a
     * squash collapses. GitHub caps this list at 250 entries; a longer branch
     * is truncated, so it feeds attribution, never correctness.
     */
    commitMessages: string[];
  }>;
}

/**
 * `getBlobsAtPaths`'s directory-scoped walk, factored out for testing: given
 * how to list a subtree's direct children, resolve each path to its blob
 * entry by visiting only the directories the paths actually live in (cached
 * per directory, so siblings share one listing call).
 */
export async function resolveBlobsAtPaths(
  rootTreeSha: string,
  paths: string[],
  ops: {
    resolveSubtreeSha: (
      rootTreeSha: string,
      segments: string[],
    ) => Promise<string | null>;
    treeShallow: (treeSha: string) => Promise<TreeEntry[]>;
  },
): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>();
  const dirListings = new Map<string, TreeEntry[] | null>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const base = slash === -1 ? path : path.slice(slash + 1);
    let listing = dirListings.get(dir);
    if (listing === undefined) {
      const subtreeSha = await ops.resolveSubtreeSha(
        rootTreeSha,
        dir === "" ? [] : dir.split("/"),
      );
      listing = subtreeSha === null ? null : await ops.treeShallow(subtreeSha);
      dirListings.set(dir, listing);
    }
    const entry = listing?.find((e) => e.type === "blob" && e.path === base);
    if (entry) result.set(path, { ...entry, path });
  }
  return result;
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
    recordGithubRateLimit(res.headers, { lane: "rest", operation: method });

    if (conditional && res.status === 304) {
      return { status: 200, json: conditional.body as T };
    }
    if (isGithubRateLimited(res)) {
      const kind =
        res.headers.get("retry-after") !== null ? "secondary" : "primary";
      countGithubRateLimited({ lane: "rest", operation: method, kind });
      await res.body?.cancel().catch(() => {});
      throw new GitHubRateLimitError(
        res.status,
        method,
        path,
        kind,
        githubRetryAfterMs(res.headers),
      );
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

  /** Blob text by sha via the Blob API (base64, up to 100MB). Shared by
   * `getBlobText` and by `getFileTextAtRef`'s large-file fallback. */
  async function blobText(blobSha: string): Promise<string> {
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
  }

  /** One tree's DIRECT children (non-recursive). GitHub returns subdirectories
   * as `type: "tree"` entries carrying their own sha; the entry `path` is the
   * bare child name, not a repo-relative path. */
  async function treeShallow(treeSha: string): Promise<TreeEntry[]> {
    const { json } = await call<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      `${repoBase}/git/trees/${treeSha}`,
    );
    if (json.truncated) {
      // One directory over the cap: unreachable once scoped, but fail loud.
      throw new GitHubApiError(
        502,
        "GET",
        `${repoBase}/git/trees/${treeSha}`,
        "tree listing truncated by GitHub; directory too large",
      );
    }
    return json.tree;
  }

  /** Walk `segments` from `rootTreeSha`, returning the final subtree's sha, or
   * null when any segment is missing or is not a directory. */
  async function resolveSubtreeSha(
    rootTreeSha: string,
    segments: string[],
  ): Promise<string | null> {
    let sha = rootTreeSha;
    for (const segment of segments) {
      const child = (await treeShallow(sha)).find(
        (e) => e.type === "tree" && e.path === segment,
      );
      if (!child) return null;
      sha = child.sha;
    }
    return sha;
  }

  return {
    owner,
    repo,

    async getDefaultBranch() {
      if (defaultBranch) return defaultBranch;
      const url = `${githubApiBaseUrl()}${repoBase}`;
      const shared = cachedDefaultBranch(url);
      if (shared) {
        defaultBranch = shared;
        return shared;
      }
      const { json } = await call<{ default_branch: string }>("GET", repoBase);
      defaultBranch = json.default_branch;
      defaultBranchCache.set(url, { value: defaultBranch, at: Date.now() });
      return defaultBranch;
    },

    async getHeadSha(branch) {
      const { json } = await call<{ object: { sha: string } }>(
        "GET",
        `${repoBase}/git/ref/heads/${encodeRefPath(branch)}`,
      );
      return json.object.sha;
    },

    async getBranchHead(branch) {
      const { json } = await call<{
        commit: { sha: string; commit: { committer: { date: string } } };
      }>("GET", `${repoBase}/branches/${encodeRefPath(branch)}`);
      return {
        sha: json.commit.sha,
        committedAt: json.commit.commit.committer.date,
      };
    },

    async getTarballStream(ref) {
      // Redirects to codeload; fetch follows them. Longer deadline — this is
      // one multi-MB download instead of hundreds of small calls. The signal
      // covers the whole body, so a stalled download aborts the stream and
      // the consumer's tar pipeline fails over to per-blob fetches.
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
      if (!res.body) {
        throw new GitHubApiError(502, "GET", path, "tarball had no body");
      }
      return res.body;
    },

    async getCommitTreeSha(commitSha) {
      const { json } = await call<{ tree: { sha: string } }>(
        "GET",
        `${repoBase}/git/commits/${commitSha}`,
      );
      return json.tree.sha;
    },

    async getDecofileTree(commitTreeSha, packagePath) {
      const decoSegments = [
        ...(packagePath ? packagePath.split("/") : []),
        ".deco",
      ];
      const decoTreeSha = await resolveSubtreeSha(commitTreeSha, decoSegments);
      if (decoTreeSha === null) return []; // no `.deco/` in this project yet
      const decoDir = packagePath ? `${packagePath}/.deco` : ".deco";
      const decoChildren = await treeShallow(decoTreeSha);
      const out: TreeEntry[] = [];
      // The merged artifact, only when this repo commits it (usually gitignored).
      const gen = decoChildren.find(
        (e) => e.type === "blob" && e.path === "blocks.gen.json",
      );
      if (gen) out.push({ ...gen, path: `${decoDir}/blocks.gen.json` });
      const blocksDir = decoChildren.find(
        (e) => e.type === "tree" && e.path === "blocks",
      );
      if (blocksDir) {
        for (const child of await treeShallow(blocksDir.sha)) {
          if (child.type !== "blob") continue;
          out.push({ ...child, path: `${decoDir}/blocks/${child.path}` });
        }
      }
      return out;
    },

    getBlobsAtPaths(commitTreeSha, paths) {
      return resolveBlobsAtPaths(commitTreeSha, paths, {
        resolveSubtreeSha,
        treeShallow,
      });
    },

    getBlobText(blobSha) {
      return blobText(blobSha);
    },

    async getFileTextAtRef(ref, filePath) {
      const { status, json } = await call<{
        content?: string;
        encoding?: string;
        sha?: string;
      }>(
        "GET",
        `${repoBase}/contents/${encodeRefPath(filePath)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        { allow: [404] },
      );
      if (status === 404 || json?.content === undefined) return null;
      /** Files over the Contents API's 1MB limit come back with
       * `encoding: "none"` and empty content, but the blob sha is still there —
       * fetch the blob directly (the Blob API serves up to 100MB). A large
       * `.deco/meta.gen.json` routinely crosses that line. */
      if (json.encoding === "none" && json.sha) {
        return blobText(json.sha);
      }
      if (json.encoding !== "base64") {
        throw new GitHubApiError(
          502,
          "GET",
          `${repoBase}/contents/${filePath}`,
          `unexpected content encoding ${json.encoding}`,
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

    async createCommit({ message, treeSha, parentShas }) {
      const { json } = await call<{ sha: string }>(
        "POST",
        `${repoBase}/git/commits`,
        { message, tree: treeSha, parents: parentShas },
      );
      return json.sha;
    },

    async updateRef(branch, sha, opts) {
      await call(
        "PATCH",
        `${repoBase}/git/refs/heads/${encodeRefPath(branch)}`,
        {
          sha,
          force: opts?.force === true,
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
        commits?: Array<{ commit?: { message?: string } }>;
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
        commitMessages: (json.commits ?? [])
          .map((c) => c.commit?.message ?? "")
          .filter((m) => m.length > 0),
      };
    },
  };
}

/** Encode a branch name for a ref path segment, preserving `/` separators. */
function encodeRefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
