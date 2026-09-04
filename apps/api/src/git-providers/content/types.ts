/**
 * Reading and writing a repository's contents, as an intention rather than as
 * one provider's object model.
 *
 * The predecessor (`decofile/github-git-data.ts`) was shaped like GitHub's Git
 * Data API — create a blob, then a tree, then a commit, then move a ref. GitLab
 * exposes no such plumbing at all, so an interface in that shape is not
 * implementable there. The write side is therefore stated as what the caller
 * actually wants: put these files on this branch, atomically, unless the branch
 * moved. GitHub does it in four calls, GitLab in one; neither leaks here.
 *
 * The read side needed no such lift: both providers address tree entries and
 * blobs by object sha, and both accept a commit sha wherever a tree-ish is
 * asked for.
 */

import type { RepoRef } from "@decocms/shared/git-providers";
import { GitProviderError } from "../types";

export interface TreeEntry {
  path: string;
  /** Object sha, as the provider's tree listing reports it. */
  sha: string;
  type: "blob" | "tree";
  size?: number;
}

/**
 * The two file modes this interface writes. A path's executable bit is real
 * content — a discard or a replay that rewrote `run.sh` as `100644` would be
 * losing part of the file, not part of its metadata.
 */
export type FileMode = "100644" | "100755";

export type FileChange =
  /** `mode` defaults to `100644`, as a new regular file. */
  | { path: string; content: string; mode?: FileMode }
  /**
   * "This path should end up with the content it has at `copyFromRef`" — the
   * replay of a blob that is already in the repository. GitHub resolves it to
   * the sha in that ref's tree and points the new tree at it, so nothing is
   * read or uploaded and the source entry's mode (an executable, a symlink)
   * survives verbatim; GitLab, which cannot reference an existing blob from a
   * commit, reads the content and writes it back as one of the two
   * {@link FileMode}s. `mode` overrides the source's; the path must exist at
   * that ref (use the `deleted` variant when it should not).
   */
  | { path: string; copyFromRef: string; mode?: FileMode }
  | { path: string; deleted: true };

export interface ChangeRequestInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
}

/**
 * A write lost its race: the branch (or the file it guarded) moved between the
 * read and the write. The coalescer's multi-replica safety is built on this
 * being distinguishable from every other failure — it rebuilds on the fresh
 * head and retries, rather than clobbering a concurrent writer.
 */
export class RepoWriteConflict extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepoWriteConflict";
  }
}

/**
 * The provider's HTTP status for a failed call, when the error carries one —
 * `GitHubApiError` and `GitProviderError` both expose `status`, and the two
 * codes consumers actually branch on (404 for "not there yet", 409 for "the
 * merge does not apply") mean the same thing on both providers.
 */
export function repoErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * How long the provider asked us to wait, for an error that is a rate refusal:
 * `null` retry-after still means "rate limited, no hint given", and a non-rate
 * failure returns undefined so the caller can tell the two apart.
 */
export function repoRateLimitRetryAfterMs(
  err: unknown,
): number | null | undefined {
  const e = err as { isRateLimited?: unknown; retryAfterMs?: unknown } | null;
  if (e?.isRateLimited !== true) return undefined;
  return typeof e.retryAfterMs === "number" ? e.retryAfterMs : null;
}

/** A branch, as a picker lists it. `author` is null when the provider cannot
 *  attribute the head commit to an account. */
export interface BranchMatch {
  name: string;
  author: string | null;
}

export interface BranchPage {
  branches: BranchMatch[];
  totalCount: number;
  /** Opaque, provider-owned; null when the listing is exhausted. */
  nextCursor: string | null;
}

export interface RepoContentClient {
  readonly repo: RepoRef;

  getDefaultBranch(): Promise<string>;
  /**
   * Branch head sha + the head commit's date, or null when the branch does not
   * exist. Git stores no ref-creation time, so that date is the branch's
   * last-activity signal and what the CMS staleness check reads.
   */
  getBranch(
    branch: string,
  ): Promise<{ sha: string; committedAt: string } | null>;
  /**
   * Branches whose name contains `query`, case-insensitively, filtered by the
   * PROVIDER rather than locally — a repository with hundreds of branches
   * makes a client-side grep over a paged listing useless, since the one you
   * typed shows up several "load more" clicks later. An empty `query` browses
   * from the start, which is why this one method serves both the picker's
   * search and its paging.
   *
   * `totalCount` is the true number of matches, so a caller can say how many
   * it is not showing. `nextCursor` is opaque and provider-owned (a GraphQL
   * cursor, a page number) — pass it back verbatim for the next window, and
   * null means there is no more.
   *
   * Alphabetical, not by recency: GitHub silently ignores a commit-date order
   * for branch refs and answers alphabetically anyway, so sorting the
   * truncated window would look ranked while omitting the actually-newest
   * branch.
   */
  searchBranches(params: {
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<BranchPage>;
  /**
   * Gzipped tar at `ref`, streamed — one request for every file, versus one
   * blob request per block. The body is never buffered here; the caller pipes
   * it into `tar`. Null when the provider cannot serve it.
   */
  getArchive(ref: string): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Block sources under `<packagePath>/.deco/`, without a whole-repo recursive
   * read — that trips GitHub's recursive cap on a large storefront and 502s.
   * Walks only that subtree. Empty when the project has no `.deco/` yet.
   */
  listDecofileEntries(
    treeish: string,
    packagePath: string | null,
  ): Promise<TreeEntry[]>;
  /**
   * Entries for a caller-known set of paths, walking only the directories they
   * live in — cost scales with the path set, never with repo size. A path
   * absent at `treeish` is omitted.
   */
  getEntriesAtPaths(
    treeish: string,
    paths: string[],
  ): Promise<Map<string, TreeEntry>>;
  /** Blob content by object sha. */
  readBlob(sha: string): Promise<string>;
  /** One file's text at a ref, by path — null when absent there. */
  readFileAtRef(ref: string, path: string): Promise<string | null>;

  /**
   * Put `changes` on `branch` in one commit.
   *
   * `expectedHead` is the guard, and the reason this is one call rather than
   * four: when the branch has moved past it the write must fail with
   * `RepoWriteConflict` instead of winning the race. Pass null only for a
   * caller that has already decided to overwrite.
   *
   * `rewriteFrom` makes the commit a history rewrite: it is the new commit's
   * parent, and `branch` ends up at the commit even when that is not a
   * fast-forward from where it points now (the squash-rebase). The commit is
   * always created BEFORE the branch is moved, so a crash in between leaves
   * the branch exactly where it was and the new commit merely unreferenced —
   * never the reverse. `expectedHead` still guards a rewrite, as a re-read
   * taken as late as possible (neither provider offers a compare-and-swap on
   * a non-fast-forward ref move), and on GitLab the move is unavoidably a
   * delete-and-recreate; see that implementation for the residual window.
   */
  commitFiles(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom?: string;
    changes: FileChange[];
  }): Promise<{ sha: string }>;

  /** Create `branch` at `sha`; `RepoWriteConflict` when it already exists. */
  createBranch(branch: string, sha: string): Promise<void>;
  /**
   * Move `branch` to `sha`, discarding whatever it pointed at — the rebase and
   * reset paths. Deliberately unguarded: neither provider offers a
   * compare-and-swap here, so a caller that cares must re-read the head itself
   * immediately before calling.
   */
  forceBranchHead(branch: string, sha: string): Promise<void>;

  /** Merge commit sha, or null when `base` already contains `head`. */
  mergeBranches(
    base: string,
    head: string,
    message: string,
  ): Promise<string | null>;
  createChangeRequest(params: {
    base: string;
    head: string;
    title: string;
  }): Promise<ChangeRequestInfo>;
  findOpenChangeRequest(
    base: string,
    head: string,
  ): Promise<ChangeRequestInfo | null>;

  compare(
    base: string,
    head: string,
  ): Promise<{
    aheadBy: number;
    behindBy: number;
  }>;
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
    /** Commit subjects on `head` that `base` lacks; feeds attribution only. */
    commitMessages: string[];
  }>;
}

/**
 * The branch head, as a hard requirement. Every caller that reads or writes a
 * draft addresses it by branch and has nothing to fall back to when it is
 * absent, so this is where "missing branch" becomes a 404 instead of a null
 * threaded through each of them.
 */
export async function requireBranchHead(
  client: RepoContentClient,
  branch: string,
): Promise<string> {
  const head = await client.getBranch(branch);
  if (head) return head.sha;
  throw new GitProviderError({
    provider: client.repo.provider,
    status: 404,
    message: `Branch ${branch} does not exist in ${client.repo.path}`,
  });
}
