/**
 * `RepoContentClient` over GitHub's REST API (Git Data + contents + merges +
 * pulls + compare). Raw fetch, no SDK — mirrors the header/UA conventions of
 * `shared/github-runtime-detect.ts`, but errors PROPAGATE (a failed write must
 * surface, not degrade to null).
 *
 * Ported from `decofile/github-git-data.ts`, whose four-call write sequence
 * (blob → tree → commit → ref) is now folded into `commitFiles` — the only
 * shape GitLab can also implement. Everything else is the same wire traffic.
 *
 * The base URL is overridable so the e2e suite can point the whole client at a
 * local stub — tests must never reach api.github.com.
 */

import { type RepoRef, splitOwnerName } from "@decocms/shared/git-providers";
import {
  countGithubRateLimited,
  githubRetryAfterMs,
  isGithubRateLimited,
  recordGithubRateLimit,
} from "@/observability/github-rate-limit";
import { githubGraphqlRequest } from "./graphql";
import { githubApiBaseUrl } from "./http";
import type { TokenSource } from "../types";
import {
  type BranchPage,
  type ChangeRequestInfo,
  type FileChange,
  type RepoContentClient,
  RepoWriteConflict,
  type TreeEntry,
} from "../content";

/**
 * A tree entry with the `mode` GitHub reports for it. The neutral `TreeEntry`
 * has no use for a Git file mode, but a tree WRITE does: a `copyFromRef`
 * change reproduces the source entry's mode verbatim, which is how an
 * executable file (or a symlink) survives a replay.
 */
type GithubEntry = TreeEntry & { mode: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/** A whole-repo archive is a download, not a REST call — it needs room to stream. */
const ARCHIVE_TIMEOUT_MS = 60_000;

/**
 * `default_branch` per repo, cached across requests — a client instance lives
 * for ONE of them (see `content/index.ts`), so its own memo never survives.
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

/**
 * Note `orderBy` is deliberately ALPHABETICAL — see `searchBranches` for why
 * asking GitHub for recency here would be a lie.
 */
const BRANCH_SEARCH_QUERY = `
query BranchSearch($owner: String!, $repo: String!, $query: String, $limit: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    refs(
      refPrefix: "refs/heads/"
      query: $query
      first: $limit
      after: $after
      orderBy: { field: ALPHABETICAL, direction: ASC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          ... on Commit {
            author { user { login } }
          }
        }
      }
    }
  }
}`;

class GitHubApiError extends Error {
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
class GitHubRateLimitError extends GitHubApiError {
  /** Duck-typed by `repoRateLimitRetryAfterMs`, so a 403 primary limit is
   * recognisable as a rate refusal without importing this class. */
  readonly isRateLimited = true;

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

/** GitHub's own tree entry shape — `mode` and submodule entries included. */
interface GithubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** Tree write entry — `sha: null` deletes the path (Git Data API contract). */
export interface TreeWriteEntry {
  path: string;
  /**
   * Git file mode: the change's own (defaulting to a regular file), or for a
   * `copyFromRef` change the source entry's mode passed through unchanged —
   * so a `100755` script stays executable and a `120000` symlink stays a
   * symlink instead of becoming a text file holding a path.
   */
  mode: string;
  type: "blob";
  sha: string | null;
}

const BLOB_MODE = "100644";

/** What one change points the tree at: a blob sha, or null to delete. */
export interface ChangeSources {
  /** Sha of the blob uploaded for a change that carries content. */
  blobSha: (change: { path: string; content: string }) => string;
  /** The entry `path` has at `ref`, or null when it is absent there. */
  copySource: (
    ref: string,
    path: string,
  ) => { sha: string; mode: string } | null;
}

/**
 * The tree write for one commit's changes: a deletion is `sha: null`, a
 * content write the sha of the blob created for it, and a `copyFromRef` the
 * sha ALREADY in that ref's tree — no blob is uploaded and no body is read,
 * which is what keeps a whole-branch replay the cost of one tree write. Order
 * is preserved (GitHub applies the last entry for a duplicated path), and the
 * mapping is pure so the deletion and mode contracts are asserted without a
 * network.
 */
export function treeWriteEntries(
  changes: readonly FileChange[],
  sources: ChangeSources,
): TreeWriteEntry[] {
  return changes.map((change) => {
    if ("deleted" in change) {
      return { path: change.path, mode: BLOB_MODE, type: "blob", sha: null };
    }
    if ("copyFromRef" in change) {
      const source = sources.copySource(change.copyFromRef, change.path);
      if (!source) {
        throw new GitHubApiError(
          404,
          "POST",
          "git/trees",
          `${change.path} does not exist at ${change.copyFromRef}`,
        );
      }
      return {
        path: change.path,
        mode: change.mode ?? source.mode,
        type: "blob",
        sha: source.sha,
      };
    }
    return {
      path: change.path,
      mode: change.mode ?? BLOB_MODE,
      type: "blob",
      sha: sources.blobSha(change),
    };
  });
}

/** GitHub tree entry → the neutral one (plus its mode, which the write side
 * reads back). Submodules are not addressable content. */
function neutralEntry(entry: GithubTreeEntry): GithubEntry | null {
  if (entry.type !== "blob" && entry.type !== "tree") return null;
  return {
    path: entry.path,
    sha: entry.sha,
    type: entry.type,
    mode: entry.mode,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
}

/**
 * `getEntriesAtPaths`'s directory-scoped walk, factored out for testing: given
 * how to list a subtree's direct children, resolve each path to its entry by
 * visiting only the directories the paths actually live in (cached per
 * directory, so siblings share one listing call).
 */
export async function resolveEntriesAtPaths<E extends TreeEntry>(
  rootTreeSha: string,
  paths: string[],
  ops: {
    resolveSubtreeSha: (
      rootTreeSha: string,
      segments: string[],
    ) => Promise<string | null>;
    treeShallow: (treeSha: string) => Promise<E[]>;
  },
): Promise<Map<string, E>> {
  const result = new Map<string, E>();
  const dirListings = new Map<string, E[] | null>();
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

export interface GithubContentClientOptions {
  repo: RepoRef;
  tokenSource: TokenSource;
}

export class GithubContentClient implements RepoContentClient {
  readonly repo: RepoRef;
  private readonly tokenSource: TokenSource;
  private readonly apiBaseUrl: string;
  private readonly repoBase: string;
  private readonly owner: string;
  private readonly name: string;
  private defaultBranch: string | null = null;
  /** commit sha -> its tree sha. A commit is immutable, and one request can
   * ask for the same commit's tree several times (compare + read + write). */
  private readonly treeShaOfCommit = new Map<string, string>();
  /** tree sha -> its direct children. Also immutable, and also asked for
   * twice by one request: a discard resolves a directory to plan the write,
   * then again to resolve the blobs that write copies. */
  private readonly treeListings = new Map<string, GithubEntry[]>();

  constructor(options: GithubContentClientOptions) {
    this.repo = options.repo;
    this.tokenSource = options.tokenSource;
    this.apiBaseUrl = githubApiBaseUrl(options.repo.host);
    const { owner, name } = splitOwnerName(options.repo);
    this.owner = owner;
    this.name = name;
    this.repoBase = `/repos/${owner}/${name}`;
  }

  private async accessToken(): Promise<string> {
    const token = await this.tokenSource.get();
    if (!token) {
      throw new GitHubApiError(
        401,
        "AUTH",
        this.repoBase,
        `No usable GitHub token for ${this.repo.path}; reconnect the account`,
      );
    }
    return token.token;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allow?: number[] },
  ): Promise<{ status: number; json: T }> {
    const url = `${this.apiBaseUrl}${path}`;
    const accessToken = await this.accessToken();
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

  /** One tree's DIRECT children (non-recursive). GitHub returns subdirectories
   * as `type: "tree"` entries carrying their own sha; the entry `path` is the
   * bare child name, not a repo-relative path. */
  private async treeShallow(treeSha: string): Promise<GithubEntry[]> {
    const memo = this.treeListings.get(treeSha);
    if (memo) return memo;
    const { json } = await this.call<{
      tree: GithubTreeEntry[];
      truncated: boolean;
    }>("GET", `${this.repoBase}/git/trees/${treeSha}`);
    if (json.truncated) {
      // One directory over the cap: unreachable once scoped, but fail loud.
      throw new GitHubApiError(
        502,
        "GET",
        `${this.repoBase}/git/trees/${treeSha}`,
        "tree listing truncated by GitHub; directory too large",
      );
    }
    const entries = json.tree.flatMap((e) => neutralEntry(e) ?? []);
    this.treeListings.set(treeSha, entries);
    return entries;
  }

  /** Walk `segments` from `rootTreeSha`, returning the final subtree's sha, or
   * null when any segment is missing or is not a directory. */
  private async resolveSubtreeSha(
    rootTreeSha: string,
    segments: string[],
  ): Promise<string | null> {
    let sha = rootTreeSha;
    for (const segment of segments) {
      const child = (await this.treeShallow(sha)).find(
        (e) => e.type === "tree" && e.path === segment,
      );
      if (!child) return null;
      sha = child.sha;
    }
    return sha;
  }

  /**
   * The tree sha a tree-ish addresses. Callers hold commit shas (a branch head,
   * a merge base), which GitHub's tree endpoints do NOT accept, so the commit is
   * resolved first; a sha that is already a tree answers 404/422 there and is
   * used as-is.
   */
  private async treeShaFor(treeish: string): Promise<string> {
    const memo = this.treeShaOfCommit.get(treeish);
    if (memo) return memo;
    const { status, json } = await this.call<{ tree?: { sha: string } }>(
      "GET",
      `${this.repoBase}/git/commits/${treeish}`,
      undefined,
      { allow: [404, 422] },
    );
    const treeSha = status === 200 && json?.tree?.sha ? json.tree.sha : treeish;
    this.treeShaOfCommit.set(treeish, treeSha);
    return treeSha;
  }

  /** Blob text by sha via the Blob API (base64, up to 100MB). */
  private async blobText(blobSha: string): Promise<string> {
    const { json } = await this.call<{ content: string; encoding: string }>(
      "GET",
      `${this.repoBase}/git/blobs/${blobSha}`,
    );
    if (json.encoding !== "base64") {
      throw new GitHubApiError(
        502,
        "GET",
        `${this.repoBase}/git/blobs/${blobSha}`,
        `unexpected blob encoding ${json.encoding}`,
      );
    }
    return Buffer.from(json.content, "base64").toString("utf-8");
  }

  async getDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const url = `${this.apiBaseUrl}${this.repoBase}`;
    const shared = cachedDefaultBranch(url);
    if (shared) {
      this.defaultBranch = shared;
      return shared;
    }
    const { json } = await this.call<{ default_branch: string }>(
      "GET",
      this.repoBase,
    );
    this.defaultBranch = json.default_branch;
    defaultBranchCache.set(url, { value: this.defaultBranch, at: Date.now() });
    return this.defaultBranch;
  }

  async getBranch(
    branch: string,
  ): Promise<{ sha: string; committedAt: string } | null> {
    const { status, json } = await this.call<{
      commit?: { sha: string; commit: { committer: { date: string } } };
    }>("GET", `${this.repoBase}/branches/${encodeRefPath(branch)}`, undefined, {
      allow: [404],
    });
    if (status === 404 || !json?.commit) return null;
    return {
      sha: json.commit.sha,
      committedAt: json.commit.commit.committer.date,
    };
  }

  /**
   * GraphQL, not REST: `GET /repos/:o/:r/branches` takes no search, filter or
   * sort parameter at all, so a picker on it can only page 100 at a time and
   * grep locally. `repository.refs(query:)` filters by a case-insensitive
   * substring of the ref name in one round trip ("upstream" finds
   * `claude/fastpreview-upstream-authority`), which is what github.com's own
   * branch dropdown uses, and reports the true `totalCount`.
   */
  async searchBranches(params: {
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<BranchPage> {
    const payload = await githubGraphqlRequest<{
      repository?: {
        refs?: {
          totalCount?: number;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<{
            name?: string | null;
            target?: {
              author?: { user?: { login?: string | null } | null } | null;
            } | null;
          } | null> | null;
        } | null;
      } | null;
    }>({
      getToken: async (force) =>
        (await this.tokenSource.get(force ? { forceRefresh: true } : undefined))
          ?.token ?? null,
      missingTokenMessage: `No usable GitHub token for ${this.repo.path}; reconnect the account`,
      query: BRANCH_SEARCH_QUERY,
      variables: {
        owner: this.owner,
        repo: this.name,
        query: params.query,
        limit: params.limit,
        after: params.cursor ?? null,
      },
      label: `branch search on ${this.repo.path}`,
      operation: "branch_search",
    });
    const repository = payload.repository;
    if (!repository) {
      throw new GitHubApiError(
        404,
        "GET",
        this.repoBase,
        `${this.repo.path} not found or not accessible by this credential`,
      );
    }
    /**
     * Every level is optional: a commit authored by an address with no GitHub
     * account has `author.user === null`, as does a ref whose target does not
     * resolve to a Commit.
     */
    const branches = (repository.refs?.nodes ?? []).flatMap((node) =>
      typeof node?.name === "string"
        ? [
            {
              name: node.name,
              author: node.target?.author?.user?.login ?? null,
            },
          ]
        : [],
    );
    const pageInfo = repository.refs?.pageInfo;
    return {
      branches,
      totalCount: repository.refs?.totalCount ?? branches.length,
      nextCursor: pageInfo?.hasNextPage ? (pageInfo.endCursor ?? null) : null,
    };
  }

  /** The branch head, as a hard requirement — a missing branch is a 404. */
  private async requireBranchSha(branch: string): Promise<string> {
    const head = await this.getBranch(branch);
    if (!head) {
      throw new GitHubApiError(
        404,
        "GET",
        `${this.repoBase}/branches/${branch}`,
        `Branch ${branch} does not exist`,
      );
    }
    return head.sha;
  }

  /**
   * Redirects to codeload; fetch follows them. The signal covers the whole
   * body, so a stalled download aborts the stream and the consumer's tar
   * pipeline fails over to per-blob fetches.
   */
  async getArchive(ref: string): Promise<ReadableStream<Uint8Array> | null> {
    const path = `${this.repoBase}/tarball/${encodeRefPath(ref)}`;
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        "User-Agent": "studio-decofile",
        Authorization: `token ${await this.accessToken()}`,
      },
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubApiError(res.status, "GET", path, text.slice(0, 300));
    }
    if (!res.body) {
      throw new GitHubApiError(502, "GET", path, "tarball had no body");
    }
    return res.body;
  }

  async listDecofileEntries(
    treeish: string,
    packagePath: string | null,
  ): Promise<TreeEntry[]> {
    const rootTreeSha = await this.treeShaFor(treeish);
    const decoSegments = [
      ...(packagePath ? packagePath.split("/") : []),
      ".deco",
    ];
    const decoTreeSha = await this.resolveSubtreeSha(rootTreeSha, decoSegments);
    if (decoTreeSha === null) return []; // no `.deco/` in this project yet
    const decoDir = packagePath ? `${packagePath}/.deco` : ".deco";
    const decoChildren = await this.treeShallow(decoTreeSha);
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
      for (const child of await this.treeShallow(blocksDir.sha)) {
        if (child.type !== "blob") continue;
        out.push({ ...child, path: `${decoDir}/blocks/${child.path}` });
      }
    }
    return out;
  }

  getEntriesAtPaths(
    treeish: string,
    paths: string[],
  ): Promise<Map<string, TreeEntry>> {
    return this.entriesWithModeAt(treeish, paths);
  }

  /** As `getEntriesAtPaths`, keeping the mode the tree write needs. */
  private async entriesWithModeAt(
    treeish: string,
    paths: string[],
  ): Promise<Map<string, GithubEntry>> {
    return resolveEntriesAtPaths(await this.treeShaFor(treeish), paths, {
      resolveSubtreeSha: (root, segments) =>
        this.resolveSubtreeSha(root, segments),
      treeShallow: (treeSha) => this.treeShallow(treeSha),
    });
  }

  readBlob(sha: string): Promise<string> {
    return this.blobText(sha);
  }

  async readFileAtRef(ref: string, path: string): Promise<string | null> {
    const { status, json } = await this.call<{
      content?: string;
      encoding?: string;
      sha?: string;
    }>(
      "GET",
      `${this.repoBase}/contents/${encodeRefPath(path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      { allow: [404] },
    );
    if (status === 404 || json?.content === undefined) return null;
    /** Files over the Contents API's 1MB limit come back with
     * `encoding: "none"` and empty content, but the blob sha is still there —
     * fetch the blob directly (the Blob API serves up to 100MB). A large
     * `.deco/meta.gen.json` routinely crosses that line. */
    if (json.encoding === "none" && json.sha) {
      return this.blobText(json.sha);
    }
    if (json.encoding !== "base64") {
      throw new GitHubApiError(
        502,
        "GET",
        `${this.repoBase}/contents/${path}`,
        `unexpected content encoding ${json.encoding}`,
      );
    }
    return Buffer.from(json.content, "base64").toString("utf-8");
  }

  /**
   * Blob → tree → commit → ref, in that order. The ref moves LAST, which is
   * what makes a `rewriteFrom` commit crash-safe: every object exists before
   * anything is repointed, so an interrupted rewrite loses a commit nobody
   * referenced yet rather than the branch's own history.
   */
  async commitFiles(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom?: string;
    changes: FileChange[];
  }): Promise<{ sha: string }> {
    const { branch, message, changes, rewriteFrom, expectedHead } = params;
    const parent =
      rewriteFrom ?? expectedHead ?? (await this.requireBranchSha(branch));
    const baseTreeSha = await this.treeShaFor(parent);

    const copySources = await this.resolveCopySources(changes);
    const blobShas = new Map<string, string>();
    for (const change of changes) {
      if ("content" in change) {
        blobShas.set(change.path, await this.createBlob(change.content));
      }
    }
    const entries = treeWriteEntries(changes, {
      blobSha: (change) => blobShas.get(change.path) as string,
      copySource: (ref, path) => copySources.get(ref)?.get(path) ?? null,
    });

    const { json: tree } = await this.call<{ sha: string }>(
      "POST",
      `${this.repoBase}/git/trees`,
      { base_tree: baseTreeSha, tree: entries },
    );
    const { json: commit } = await this.call<{ sha: string }>(
      "POST",
      `${this.repoBase}/git/commits`,
      { message, tree: tree.sha, parents: [parent] },
    );
    if (rewriteFrom !== undefined) {
      /** A forced ref update takes no `If-Match`, so the guard is a re-read
       *  here, after the commit exists — the latest point at which the lease
       *  can still be checked, and the shortest window available. */
      if (
        expectedHead !== null &&
        (await this.requireBranchSha(branch)) !== expectedHead
      ) {
        throw new RepoWriteConflict(
          `${branch} moved while rewriting ${this.repo.path}`,
        );
      }
      await this.updateRef(branch, commit.sha, true);
      return { sha: commit.sha };
    }
    try {
      await this.updateRef(branch, commit.sha, false);
    } catch (err) {
      // Non-fast-forward: the branch moved past `parent` while we built this.
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new RepoWriteConflict(
          `${branch} moved while committing to ${this.repo.path}`,
          { cause: err },
        );
      }
      throw err;
    }
    return { sha: commit.sha };
  }

  /**
   * The blobs a commit's `copyFromRef` changes point at, one directory-scoped
   * resolve per distinct ref. Nothing is downloaded: the tree write reuses the
   * sha (and the mode) the entry already has there.
   */
  private async resolveCopySources(
    changes: readonly FileChange[],
  ): Promise<Map<string, Map<string, GithubEntry>>> {
    const pathsByRef = new Map<string, string[]>();
    for (const change of changes) {
      if (!("copyFromRef" in change)) continue;
      const bucket = pathsByRef.get(change.copyFromRef);
      if (bucket) bucket.push(change.path);
      else pathsByRef.set(change.copyFromRef, [change.path]);
    }
    const byRef = new Map<string, Map<string, GithubEntry>>();
    for (const [ref, paths] of pathsByRef) {
      byRef.set(ref, await this.entriesWithModeAt(ref, paths));
    }
    return byRef;
  }

  /** Blob for `content`; GitHub is content-addressed, so this is idempotent. */
  private async createBlob(content: string): Promise<string> {
    const { json } = await this.call<{ sha: string }>(
      "POST",
      `${this.repoBase}/git/blobs`,
      { content, encoding: "utf-8" },
    );
    return json.sha;
  }

  private async updateRef(
    branch: string,
    sha: string,
    force: boolean,
  ): Promise<void> {
    await this.call(
      "PATCH",
      `${this.repoBase}/git/refs/heads/${encodeRefPath(branch)}`,
      { sha, force },
    );
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.call("POST", `${this.repoBase}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new RepoWriteConflict(
          `${branch} already exists on ${this.repo.path}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  forceBranchHead(branch: string, sha: string): Promise<void> {
    return this.updateRef(branch, sha, true);
  }

  async mergeBranches(
    base: string,
    head: string,
    message: string,
  ): Promise<string | null> {
    const { status, json } = await this.call<{ sha?: string } | undefined>(
      "POST",
      `${this.repoBase}/merges`,
      { base, head, commit_message: message },
      { allow: [204] },
    );
    // 204 = base already contains head; 201 carries the merge commit.
    return status === 204 ? null : (json?.sha ?? null);
  }

  async createChangeRequest(params: {
    base: string;
    head: string;
    title: string;
  }): Promise<ChangeRequestInfo> {
    const { json } = await this.call<GithubPullJson>(
      "POST",
      `${this.repoBase}/pulls`,
      params,
    );
    return mapGithubPull(json);
  }

  async findOpenChangeRequest(
    base: string,
    head: string,
  ): Promise<ChangeRequestInfo | null> {
    const { json } = await this.call<GithubPullJson[]>(
      "GET",
      `${this.repoBase}/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${this.owner}:${head}`)}`,
    );
    const first = json[0];
    return first ? mapGithubPull(first) : null;
  }

  async compare(
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }> {
    const { json } = await this.call<{ ahead_by: number; behind_by: number }>(
      "GET",
      `${this.repoBase}/compare/${encodeRefPath(base)}...${encodeRefPath(head)}`,
    );
    return { aheadBy: json.ahead_by, behindBy: json.behind_by };
  }

  async compareDetailed(
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
    commitMessages: string[];
  }> {
    const { json } = await this.call<{
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
      `${this.repoBase}/compare/${encodeRefPath(base)}...${encodeRefPath(head)}`,
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
      /**
       * Messages of the commits on `head` that `base` lacks — the set a squash
       * collapses. GitHub caps this list at 250 entries; a longer branch is
       * truncated, so it feeds attribution, never correctness.
       */
      commitMessages: (json.commits ?? [])
        .map((c) => c.commit?.message ?? "")
        .filter((m) => m.length > 0),
    };
  }
}

interface GithubPullJson {
  number: number;
  html_url: string;
  title?: string;
  state?: string;
  merged?: boolean;
}

/** Pure: GitHub's pull request object → the neutral change request. */
export function mapGithubPull(json: GithubPullJson): ChangeRequestInfo {
  const state =
    json.merged === true
      ? "merged"
      : json.state === "closed"
        ? "closed"
        : "open";
  return {
    number: json.number,
    url: json.html_url,
    title: json.title ?? "",
    state,
  };
}

/** Encode a branch name for a ref path segment, preserving `/` separators. */
function encodeRefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
