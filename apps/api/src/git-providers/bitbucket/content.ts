/**
 * `RepoContentClient` over Bitbucket Cloud's REST 2.0 API.
 *
 * Bitbucket exposes no Git Data plumbing and, unlike GitLab, no object shas
 * either: a directory listing (`/src/{commit}/{dir}/`) names each entry's
 * path, type and size, but not its blob. The interface's `TreeEntry.sha` is
 * therefore SYNTHETIC here — `<commit>:<path>`, a commit in whose tree the
 * path has this content — and `readBlob` reads it back as `/src/{commit}/
 * {path}`. Two commits are used, for two costs:
 *
 * - a listing pins the LISTED commit: one call names every entry, which is
 *   what the read path needs. Its shas change on every commit, so the blob
 *   cache runs cold after a save and the read falls back to the tarball
 *   path, which exists for exactly that;
 * - a path-set lookup pins the LAST commit that touched each path: one
 *   `filehistory` call per path, so the same content at two refs compares
 *   equal — which is what the discard plan needs from `getEntriesAtPaths`.
 *
 * Writes are one `POST /src` per commit, carrying every file as a multipart
 * field and `parents` as the guard. Where Bitbucket cannot express the
 * interface's wording, the gap is documented on the method: file modes
 * (`commitFiles`), moving a branch to an arbitrary sha (`forceBranchHead`),
 * rewriting history (`rewriteBranch`), merging without a pull request
 * (`mergeBranches`). Bitbucket Cloud only — see `http.ts`.
 */

import type { RepoRef } from "@decocms/shared/git-providers";
import { mapBounded, retry, RetryError } from "@decocms/shared/std";
import {
  type BranchPage,
  type ChangeRequestInfo,
  type FileChange,
  type FileMode,
  type RepoContentClient,
  RepoWriteConflict,
  type TreeEntry,
} from "../content";
import { decoDirFor, groupPathsByDirectory } from "../paths";
import { GitProviderError, type TokenSource } from "../types";
import {
  BitbucketProviderClient,
  encodeSrcPath,
  repositoryApiPath,
} from "./client";
import {
  BITBUCKET_API_BASE,
  bbqString,
  bitbucketFailure,
  bitbucketFetch,
  type BitbucketPage,
  nextPageNumber,
} from "./http";

const PAGE_SIZE = 100;
/** 100 pages × 100 entries — a directory or a compare past that is a bug, not a repo. */
const MAX_PAGES = 100;
/** Bounds the per-path fan-out so a large discard does not trip Bitbucket's hourly limit. */
const FANOUT_CONCURRENCY = 8;

/** `<commit>:<path>` — see the module note. */
export function treeSha(commit: string, path: string): string {
  return `${commit}:${path}`;
}

/** The inverse of {@link treeSha}. A commit hash never contains a colon; a path may. */
export function parseTreeSha(sha: string): { commit: string; path: string } {
  const colon = sha.indexOf(":");
  if (colon <= 0 || colon === sha.length - 1) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: 400,
      message: `${sha} is not a Bitbucket tree sha (expected <commit>:<path>)`,
    });
  }
  return { commit: sha.slice(0, colon), path: sha.slice(colon + 1) };
}

/** A `src` directory listing row. `commit.hash` is the commit that was listed. */
interface BitbucketSrcEntry {
  type?: string | null;
  path?: string | null;
  size?: number | null;
  commit?: { hash?: string | null } | null;
}

/** A listing row as a tree entry, or null for anything that is not a file or directory. */
export function mapSrcEntry(
  row: BitbucketSrcEntry,
  listedCommit: string,
): TreeEntry | null {
  if (typeof row.path !== "string" || row.path.length === 0) return null;
  const type =
    row.type === "commit_file"
      ? "blob"
      : row.type === "commit_directory"
        ? "tree"
        : null;
  if (type === null) return null;
  const commit = row.commit?.hash ?? listedCommit;
  return {
    path: row.path,
    sha: treeSha(commit, row.path),
    type,
    ...(type === "blob" && typeof row.size === "number"
      ? { size: row.size }
      : {}),
  };
}

/**
 * A change with its bytes in hand. Bitbucket cannot point a commit at a blob
 * that already exists, so a `copyFromRef` change is read into `content`
 * before the form is built.
 */
export type ResolvedChange =
  | { path: string; content: string; mode?: FileMode }
  | { path: string; deleted: true };

/**
 * The multipart body of `POST /src`: `message`, `branch`, `parents`, one
 * field per written file named by its path, and a `files` entry per deleted
 * path. Two changes to one path collapse to the last one. Null when nothing
 * remains to commit — Bitbucket refuses an empty form.
 *
 * `existsAtParent` decides whether a delete is sent at all: deleting what is
 * not there is a no-op, and Bitbucket would fail the whole commit over it.
 */
export function buildCommitForm(params: {
  branch: string;
  parent: string;
  message: string;
  changes: readonly ResolvedChange[];
  existsAtParent: (path: string) => boolean;
}): FormData | null {
  const collapsed = new Map<string, ResolvedChange>();
  for (const change of params.changes) collapsed.set(change.path, change);

  const form = new FormData();
  let entries = 0;
  for (const [path, change] of collapsed) {
    if ("deleted" in change) {
      if (!params.existsAtParent(path)) continue;
      form.append("files", path);
    } else {
      form.append(path, change.content);
    }
    entries += 1;
  }
  if (entries === 0) return null;
  form.append("message", params.message);
  form.append("branch", params.branch);
  form.append("parents", params.parent);
  return form;
}

/**
 * Whether a refused commit means "someone else wrote first" rather than "this
 * request was wrong": the `parents` guard no longer names the branch tip.
 */
export function isCommitConflict(status: number, message: string): boolean {
  if (status !== 400 && status !== 409) return false;
  return /parent|tip|fast[- ]?forward|behind|conflict|out of date/i.test(
    message,
  );
}

/** `POST /refs/branches` on a name that is taken answers 400. */
export function isBranchExistsConflict(
  status: number,
  message: string,
): boolean {
  return (
    status === 400 && /already exists|BRANCH_ALREADY_EXISTS/i.test(message)
  );
}

/**
 * Bitbucket's pull-request states, in the interface's vocabulary. An
 * unrecognised state is reported as closed rather than as actionable.
 */
export function mapPullRequestState(
  state: string | null | undefined,
): ChangeRequestInfo["state"] {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "closed";
}

interface BitbucketPullRequestRow {
  id: number;
  title?: string | null;
  state?: string | null;
  links?: { html?: { href?: string | null } | null } | null;
  merge_commit?: { hash?: string | null } | null;
}

export function mapPullRequest(pr: BitbucketPullRequestRow): ChangeRequestInfo {
  return {
    number: pr.id,
    url: pr.links?.html?.href ?? "",
    title: pr.title ?? "",
    state: mapPullRequestState(pr.state),
  };
}

interface BitbucketDiffstatEntry {
  status?: string | null;
  old?: { path?: string | null } | null;
  new?: { path?: string | null } | null;
}

/**
 * One diffstat entry in the interface's file shape. Bitbucket's status words
 * are already the interface's (`added`, `removed`, `modified`, `renamed`); a
 * surviving file's sha is the synthetic one at `head`, and a removed path
 * (absent there by definition) keeps `sha: ""`.
 */
export function mapDiffstatEntry(
  entry: BitbucketDiffstatEntry,
  headCommit: string,
): {
  filename: string;
  status: string;
  sha: string;
  previousFilename?: string;
} | null {
  const filename = entry.new?.path ?? entry.old?.path;
  if (!filename) return null;
  const status = entry.status ?? "modified";
  const renamed =
    status === "renamed" && entry.old?.path && entry.old.path !== filename;
  return {
    filename,
    status,
    sha: status === "removed" ? "" : treeSha(headCommit, filename),
    ...(renamed ? { previousFilename: entry.old!.path! } : {}),
  };
}

/** Commit author for a branch row: the account when Bitbucket resolved one, else the raw name. */
export function branchAuthor(row: {
  target?: {
    author?: {
      user?: { nickname?: string | null } | null;
      raw?: string | null;
    } | null;
  } | null;
}): string | null {
  const author = row.target?.author;
  if (author?.user?.nickname) return author.user.nickname;
  const raw = author?.raw?.trim();
  if (!raw) return null;
  const name = raw.replace(/\s*<[^>]*>\s*$/, "").trim();
  return name || null;
}

interface CallInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  accept?: string;
}

export class BitbucketContentClient implements RepoContentClient {
  readonly repo: RepoRef;
  private readonly repoBase: string;
  /** Owns token minting and the archive download; both are already solved there. */
  private readonly provider: BitbucketProviderClient;
  private defaultBranch: string | null = null;

  constructor(params: { repo: RepoRef; tokenSource: TokenSource }) {
    this.repo = params.repo;
    this.repoBase = repositoryApiPath(params.repo);
    this.provider = new BitbucketProviderClient({
      host: params.repo.host,
      tokenSource: params.tokenSource,
    });
  }

  async getDefaultBranch(): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    const repository = await this.json<{
      mainbranch?: { name?: string | null } | null;
    }>(this.repoBase);
    if (repository === null) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket repository ${this.repo.path} not found`,
      });
    }
    if (!repository.mainbranch?.name) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 409,
        message: `Bitbucket repository ${this.repo.path} has no main branch (empty repository)`,
      });
    }
    this.defaultBranch = repository.mainbranch.name;
    return this.defaultBranch;
  }

  async getBranch(
    branch: string,
  ): Promise<{ sha: string; committedAt: string } | null> {
    const json = await this.json<{
      target?: { hash?: string | null; date?: string | null } | null;
    }>(`${this.repoBase}/refs/branches/${encodeRef(branch)}`);
    const target = json?.target;
    if (!target?.hash) return null;
    if (!target.date) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 502,
        message: `Bitbucket branch ${branch} came back without a commit date`,
      });
    }
    return { sha: target.hash, committedAt: target.date };
  }

  /**
   * Bitbucket filters branch names server-side with its query language, so
   * this is one request. `size` is the true match count when Bitbucket
   * bothers to count; when it omits it (a very large repository) the page's
   * length is the honest lower bound.
   */
  async searchBranches(params: {
    query: string;
    limit: number;
    cursor?: string | null;
  }): Promise<BranchPage> {
    // Bitbucket pages by number, so the opaque cursor IS the next page number.
    const page = Number(params.cursor) || 1;
    const query = new URLSearchParams({
      sort: "name",
      pagelen: String(Math.min(params.limit, PAGE_SIZE)),
      page: String(page),
    });
    if (params.query) query.set("q", `name ~ ${bbqString(params.query)}`);
    const listing = await this.json<
      BitbucketPage<{
        name?: string | null;
        target?: {
          author?: {
            user?: { nickname?: string | null } | null;
            raw?: string | null;
          } | null;
        } | null;
      }>
    >(`${this.repoBase}/refs/branches?${query}`);
    if (listing === null) {
      return { branches: [], totalCount: 0, nextCursor: null };
    }
    const branches = (listing.values ?? []).flatMap((row) =>
      typeof row.name === "string"
        ? [{ name: row.name, author: branchAuthor(row) }]
        : [],
    );
    const next = nextPageNumber(listing);
    return {
      branches,
      totalCount:
        typeof listing.size === "number" ? listing.size : branches.length,
      nextCursor: next === null ? null : String(next),
    };
  }

  getArchive(ref: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.provider.archiveTarball(this.repo, ref);
  }

  /**
   * At most two listings: the `.deco/` directory (which reveals whether the
   * merged artifact is committed) and `.deco/blocks/`. Direct blob children
   * are returned unfiltered, exactly as the other implementations do —
   * `blockEntriesInTree` downstream applies the `*.json` rule.
   */
  async listDecofileEntries(
    treeish: string,
    packagePath: string | null,
  ): Promise<TreeEntry[]> {
    const decoDir = decoDirFor(packagePath);
    const children = await this.listTree(treeish, decoDir);
    const out: TreeEntry[] = [];
    const gen = children.find(
      (entry) =>
        entry.type === "blob" && entry.path === `${decoDir}/blocks.gen.json`,
    );
    if (gen) out.push(gen);
    const hasBlocksDir = children.some(
      (entry) => entry.type === "tree" && entry.path === `${decoDir}/blocks`,
    );
    if (!hasBlocksDir) return out;
    for (const child of await this.listTree(treeish, `${decoDir}/blocks`)) {
      if (child.type === "blob") out.push(child);
    }
    return out;
  }

  /**
   * One listing per distinct directory, then one `filehistory` read per file
   * found, so the sha pins the last commit that touched the path — the form
   * that compares equal across refs (see the module note).
   */
  async getEntriesAtPaths(
    treeish: string,
    paths: string[],
  ): Promise<Map<string, TreeEntry>> {
    const byDir = groupPathsByDirectory(paths);
    const listings = await mapBounded(
      [...byDir.keys()],
      FANOUT_CONCURRENCY,
      (dir) => this.listTree(treeish, dir),
    );
    const found: TreeEntry[] = [];
    let index = 0;
    for (const wanted of byDir.values()) {
      const byPath = new Map(
        (listings[index++] ?? []).map((entry) => [entry.path, entry]),
      );
      for (const path of wanted) {
        const entry = byPath.get(path);
        if (entry?.type === "blob") found.push(entry);
      }
    }
    const pinned = await mapBounded(
      found,
      FANOUT_CONCURRENCY,
      async (entry) => {
        const { commit } = parseTreeSha(entry.sha);
        const touched = await this.lastCommitTouching(commit, entry.path);
        return touched
          ? { ...entry, sha: treeSha(touched, entry.path) }
          : entry;
      },
    );
    return new Map(pinned.map((entry) => [entry.path, entry]));
  }

  async readBlob(sha: string): Promise<string> {
    const { commit, path } = parseTreeSha(sha);
    const content = await this.readFileAtRef(commit, path);
    if (content === null) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket has no ${path} at ${commit} in ${this.repo.path}`,
      });
    }
    return content;
  }

  async readFileAtRef(ref: string, path: string): Promise<string | null> {
    const res = await this.call(
      `${this.repoBase}/src/${encodeRef(ref)}/${encodeSrcPath(path)}`,
      { accept: "text/plain, */*" },
    );
    return res === null ? null : res.text();
  }

  /**
   * One `POST /src`, guarded by `parents`. `branch` must already exist —
   * creating one as a side effect of a write is `createBranch`'s job.
   *
   * The head is read first so the common lost race costs one request and no
   * upload, then `parents` carries the approved sha into Bitbucket's own
   * transaction, where a branch that moved meanwhile refuses the commit. Both
   * refusals become `RepoWriteConflict` so the coalescer rebuilds and retries
   * rather than clobbering the other writer.
   *
   * Bitbucket's form has no file mode: an executable written here keeps the
   * mode the path already had and a NEW file is regular. `mode` is accepted
   * for the interface and cannot be honoured — the one content bit this
   * provider loses.
   */
  async commitFiles(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom?: string;
    changes: FileChange[];
  }): Promise<{ sha: string }> {
    const { branch, message, expectedHead, rewriteFrom } = params;
    const head = await this.getBranch(branch);
    if (expectedHead !== null && head?.sha !== expectedHead) {
      throw new RepoWriteConflict(
        `Bitbucket branch ${branch} is at ${head?.sha ?? "(absent)"}, expected ${expectedHead}`,
      );
    }
    const changes = await this.resolveCopies(params.changes);
    if (rewriteFrom !== undefined) {
      return this.rewriteBranch({
        branch,
        message,
        expectedHead,
        rewriteFrom,
        changes,
      });
    }
    if (head === null) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket branch ${branch} does not exist in ${this.repo.path}`,
      });
    }
    const sha = await this.commitOnto({
      branch,
      parent: head.sha,
      message,
      changes,
    });
    return { sha: sha ?? head.sha };
  }

  /**
   * A history rewrite. `POST /src` with `parents` set to an ancestor of the
   * branch tip is attempted first — Bitbucket refuses it when the branch is
   * protected against force pushes, or when it treats the move as a
   * non-fast-forward at all. Only then does this fall back to replacing the
   * branch: build the commit on a throwaway first so the content exists
   * before the target is touched, then delete and recreate the target at it.
   * The fallback is what costs a window — the branch briefly does not exist —
   * and it fails too if the branch is protected against deletion.
   */
  private async rewriteBranch(params: {
    branch: string;
    message: string;
    expectedHead: string | null;
    rewriteFrom: string;
    changes: readonly ResolvedChange[];
  }): Promise<{ sha: string }> {
    const { branch, message, expectedHead, rewriteFrom, changes } = params;

    await this.assertHeadIs(branch, expectedHead);
    const direct = await this.commitOnto({
      branch,
      parent: rewriteFrom,
      message,
      changes,
    }).catch((cause: unknown) => {
      if (
        cause instanceof GitProviderError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        ![401, 403, 404, 429].includes(cause.status)
      ) {
        return undefined;
      }
      throw cause;
    });
    if (direct === null) {
      // Nothing to commit: the rewrite is a plain move to `rewriteFrom`.
      await this.forceBranchHead(branch, rewriteFrom);
      return { sha: rewriteFrom };
    }
    if (direct !== undefined) return { sha: direct };

    const staging = `studio-rewrite-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.createBranch(staging, rewriteFrom);
    let sha: string;
    try {
      sha =
        (await this.commitOnto({
          branch: staging,
          parent: rewriteFrom,
          message,
          changes,
        })) ?? rewriteFrom;
      /** Re-read as late as possible: the guard has to hold when the target is
       * replaced, not when this call started. */
      const current = await this.getBranch(branch);
      if (expectedHead !== null && current?.sha !== expectedHead) {
        throw new RepoWriteConflict(
          `Bitbucket branch ${branch} moved to ${current?.sha ?? "(absent)"} while rewriting it`,
        );
      }
    } catch (cause) {
      await this.deleteBranch(staging).catch(() => {});
      throw cause;
    }
    await this.deleteBranch(branch);
    await this.createBranchAt(branch, sha);
    await this.deleteBranch(staging).catch(() => {});
    return { sha };
  }

  private async assertHeadIs(
    branch: string,
    expectedHead: string | null,
  ): Promise<void> {
    if (expectedHead === null) return;
    const current = await this.getBranch(branch);
    if (current?.sha !== expectedHead) {
      throw new RepoWriteConflict(
        `Bitbucket branch ${branch} is at ${current?.sha ?? "(absent)"}, not ${expectedHead}`,
      );
    }
  }

  /**
   * One `POST /src` on `branch` parented on `parent`. Null when the changes
   * reduce to nothing (deletes for paths that are already gone). Bitbucket
   * answers 201 with an empty body, so the new sha is the branch head read
   * straight after — a write landing in that gap would be reported as ours,
   * which is the residual window of a provider with no commit-returning write.
   */
  private async commitOnto(params: {
    branch: string;
    parent: string;
    message: string;
    changes: readonly ResolvedChange[];
  }): Promise<string | null> {
    const { branch, parent, message, changes } = params;
    const deletions = changes.flatMap((change) =>
      "deleted" in change ? [change.path] : [],
    );
    const present = new Set(
      (
        await mapBounded(deletions, FANOUT_CONCURRENCY, async (path) =>
          (await this.existsAt(parent, path)) ? [path] : [],
        )
      ).flat(),
    );
    const form = buildCommitForm({
      branch,
      parent,
      message,
      changes,
      existsAtParent: (path) => present.has(path),
    });
    if (form === null) return null;

    const res = await bitbucketFetch(
      `${BITBUCKET_API_BASE}${this.repoBase}/src`,
      await this.token(),
      { method: "POST", body: form },
    );
    if (!res.ok) {
      const failure = await bitbucketFailure(res);
      if (isCommitConflict(failure.status, failure.message)) {
        throw new RepoWriteConflict(
          `Bitbucket refused the commit on ${branch}: ${failure.message}`,
          { cause: failure },
        );
      }
      throw failure;
    }
    await res.body?.cancel().catch(() => {});
    const head = await this.getBranch(branch);
    if (!head) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 502,
        message: `Bitbucket accepted the commit on ${branch} but the branch cannot be read back`,
      });
    }
    return head.sha;
  }

  /** `copyFromRef` changes, read into content. */
  private resolveCopies(
    changes: readonly FileChange[],
  ): Promise<ResolvedChange[]> {
    return mapBounded(
      [...changes],
      FANOUT_CONCURRENCY,
      async (change): Promise<ResolvedChange> => {
        if (!("copyFromRef" in change)) return change;
        const content = await this.readFileAtRef(
          change.copyFromRef,
          change.path,
        );
        if (content === null) {
          throw new GitProviderError({
            provider: "bitbucket",
            status: 404,
            message: `${change.path} does not exist at ${change.copyFromRef} in ${this.repo.path}`,
          });
        }
        return { path: change.path, content, mode: change.mode };
      },
    );
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.createBranchAt(branch, sha);
    } catch (cause) {
      if (
        cause instanceof GitProviderError &&
        isBranchExistsConflict(cause.status, cause.message)
      ) {
        throw new RepoWriteConflict(
          `Bitbucket branch ${branch} already exists in ${this.repo.path}`,
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * Bitbucket has no ref-update endpoint: a branch can only be created or
   * deleted, never repointed. So this deletes and recreates, which is NOT
   * atomic — between the two calls the branch does not exist, and a failure
   * after the delete leaves it missing rather than stale. The interface
   * already declares this method unguarded, so the caller re-reads the head
   * before calling either way.
   */
  async forceBranchHead(branch: string, sha: string): Promise<void> {
    await this.deleteBranch(branch);
    await this.createBranchAt(branch, sha);
  }

  /**
   * Bitbucket has no merge endpoint on the repository — merging means opening
   * a pull request and merging it, so this leaves one behind where GitHub
   * leaves nothing. An open pull request for the same pair is reused.
   */
  async mergeBranches(
    base: string,
    head: string,
    message: string,
  ): Promise<string | null> {
    const ahead = await this.commitsIn(head, base);
    if (ahead.length === 0) return null;
    const title = message.split("\n")[0] || message;
    const pr =
      (await this.findOpenChangeRequest(base, head)) ??
      (await this.createChangeRequest({ base, head, title }));
    return this.mergePullRequest(pr.number, base, message);
  }

  async createChangeRequest(params: {
    base: string;
    head: string;
    title: string;
  }): Promise<ChangeRequestInfo> {
    const json = await this.json<BitbucketPullRequestRow>(
      `${this.repoBase}/pullrequests`,
      {
        method: "POST",
        body: {
          title: params.title,
          source: { branch: { name: params.head } },
          destination: { branch: { name: params.base } },
        },
      },
    );
    if (!json) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket repository ${this.repo.path} not found`,
      });
    }
    return mapPullRequest(json);
  }

  async findOpenChangeRequest(
    base: string,
    head: string,
  ): Promise<ChangeRequestInfo | null> {
    const query = new URLSearchParams({
      state: "OPEN",
      q: `source.branch.name = ${bbqString(head)} AND destination.branch.name = ${bbqString(base)}`,
      pagelen: "1",
    });
    const page = await this.json<BitbucketPage<BitbucketPullRequestRow>>(
      `${this.repoBase}/pullrequests?${query}`,
    );
    const first = page?.values?.[0];
    return first ? mapPullRequest(first) : null;
  }

  /** Two commit listings — `head` minus `base` for ahead, the reverse for behind. */
  async compare(
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }> {
    const [ahead, behind] = await Promise.all([
      this.commitsIn(head, base),
      this.commitsIn(base, head),
    ]);
    return { aheadBy: ahead.length, behindBy: behind.length };
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
    const [ahead, behind, mergeBaseSha] = await Promise.all([
      this.commitsIn(head, base),
      this.commitsIn(base, head),
      this.mergeBaseSha(base, head),
    ]);
    if (ahead.length === 0) {
      return {
        aheadBy: 0,
        behindBy: behind.length,
        mergeBaseSha,
        files: [],
        commitMessages: [],
      };
    }
    // The newest commit `head` has that `base` lacks IS head's tip.
    const headCommit = ahead[0]!.hash;
    const entries = await this.diffstat(head, base);
    return {
      aheadBy: ahead.length,
      behindBy: behind.length,
      mergeBaseSha,
      files: entries.flatMap((entry) => {
        const mapped = mapDiffstatEntry(entry, headCommit);
        return mapped ? [mapped] : [];
      }),
      commitMessages: ahead
        .map((commit) => (commit.message ?? "").split("\n")[0] ?? "")
        .filter((title) => title.length > 0),
    };
  }

  private async createBranchAt(branch: string, sha: string): Promise<void> {
    const res = await this.call(`${this.repoBase}/refs/branches`, {
      method: "POST",
      body: { name: branch, target: { hash: sha } },
    });
    if (res === null) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 404,
        message: `Bitbucket could not branch ${branch} from ${sha}: repository or ref not found`,
      });
    }
    await res.body?.cancel().catch(() => {});
  }

  private async deleteBranch(branch: string): Promise<void> {
    const res = await this.call(
      `${this.repoBase}/refs/branches/${encodeRef(branch)}`,
      { method: "DELETE" },
    );
    await res?.body?.cancel().catch(() => {});
  }

  /**
   * Bitbucket merges asynchronously on a large repository (202) and refuses
   * with 400/409 while it is still computing mergeability right after the
   * pull request was created, so this retries a bounded number of times; a
   * genuine conflict exhausts the attempts and surfaces Bitbucket's message.
   */
  private async mergePullRequest(
    id: number,
    base: string,
    message: string,
  ): Promise<string> {
    const attempt = async (): Promise<string> => {
      const res = await bitbucketFetch(
        `${BITBUCKET_API_BASE}${this.repoBase}/pullrequests/${id}/merge`,
        await this.token(),
        {
          method: "POST",
          body: {
            type: "pullrequest",
            message,
            merge_strategy: "merge_commit",
            close_source_branch: false,
          },
        },
      );
      if (res.status === 202) {
        await res.body?.cancel().catch(() => {});
        throw new GitProviderError({
          provider: "bitbucket",
          status: 202,
          message: `Bitbucket is still merging pull request #${id}`,
        });
      }
      if (!res.ok) throw await bitbucketFailure(res);
      const json = (await res.json()) as BitbucketPullRequestRow;
      if (json.state !== "MERGED") {
        throw new GitProviderError({
          provider: "bitbucket",
          status: 409,
          message: `Bitbucket left pull request #${id} in state ${json.state ?? "unknown"}`,
        });
      }
      if (json.merge_commit?.hash) return json.merge_commit.hash;
      const merged = await this.getBranch(base);
      if (!merged) {
        throw new GitProviderError({
          provider: "bitbucket",
          status: 502,
          message: `Bitbucket merged #${id} without reporting a commit sha`,
        });
      }
      return merged.sha;
    };
    try {
      return await retry(attempt, {
        maxAttempts: 4,
        minTimeout: 500,
        maxTimeout: 4_000,
        jitter: 0.5,
        isRetriable: (err) =>
          err instanceof GitProviderError &&
          (err.status === 202 || err.status === 409),
      });
    } catch (err) {
      if (err instanceof RetryError && err.cause instanceof GitProviderError) {
        throw err.cause;
      }
      throw err;
    }
  }

  /** Whether `path` is a file at `ref` — one metadata read, no content. */
  private async existsAt(ref: string, path: string): Promise<boolean> {
    const json = await this.json<{ type?: string | null }>(
      `${this.repoBase}/src/${encodeRef(ref)}/${encodeSrcPath(path)}?format=meta`,
    );
    return json?.type === "commit_file";
  }

  /** The last commit that touched `path`, as of `commit`; null when Bitbucket cannot say. */
  private async lastCommitTouching(
    commit: string,
    path: string,
  ): Promise<string | null> {
    const page = await this.json<
      BitbucketPage<{ commit?: { hash?: string | null } | null }>
    >(
      `${this.repoBase}/filehistory/${encodeRef(commit)}/${encodeSrcPath(path)}` +
        "?pagelen=1&fields=values.commit.hash",
    ).catch(() => null);
    return page?.values?.[0]?.commit?.hash ?? null;
  }

  /**
   * Direct children of `path` at `treeish`, following Bitbucket's pagination.
   * A missing directory (or a missing ref) answers 404, which is the empty
   * listing — callers treat "no `.deco/` yet" as normal.
   */
  private async listTree(treeish: string, path: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    const dir = path ? `${encodeSrcPath(path)}/` : "";
    let page = 1;
    for (let visited = 0; visited < MAX_PAGES; visited++) {
      const listing = await this.json<BitbucketPage<BitbucketSrcEntry>>(
        `${this.repoBase}/src/${encodeRef(treeish)}/${dir}?pagelen=${PAGE_SIZE}&page=${page}`,
      );
      if (listing === null) return out;
      if (!Array.isArray(listing.values)) {
        throw new GitProviderError({
          provider: "bitbucket",
          status: 502,
          message: "Bitbucket /src returned no values array",
        });
      }
      for (const row of listing.values) {
        const entry = mapSrcEntry(row, treeish);
        if (entry) out.push(entry);
      }
      const next = nextPageNumber(listing);
      if (next === null || next <= page) break;
      page = next;
    }
    return out;
  }

  /**
   * Commits reachable from `from` but not from `exclude` — Bitbucket's answer
   * to "how far ahead", newest first. Bounded: past `MAX_PAGES` the count is a
   * lower bound, which is honest for a comparison nobody will read to the end.
   */
  private async commitsIn(
    from: string,
    exclude: string,
  ): Promise<Array<{ hash: string; message?: string | null }>> {
    const out: Array<{ hash: string; message?: string | null }> = [];
    let page = 1;
    for (let visited = 0; visited < MAX_PAGES; visited++) {
      const listing = await this.json<
        BitbucketPage<{ hash?: string | null; message?: string | null }>
      >(
        `${this.repoBase}/commits/${encodeRef(from)}?exclude=${encodeRef(exclude)}` +
          `&pagelen=${PAGE_SIZE}&page=${page}&fields=values.hash,values.message,next`,
      );
      if (listing === null) {
        throw new GitProviderError({
          provider: "bitbucket",
          status: 404,
          message: `Bitbucket cannot compare ${exclude}...${from} in ${this.repo.path}`,
        });
      }
      for (const row of listing.values ?? []) {
        if (typeof row.hash === "string") {
          out.push({ hash: row.hash, message: row.message });
        }
      }
      const next = nextPageNumber(listing);
      if (next === null || next <= page) break;
      page = next;
    }
    return out;
  }

  /**
   * Files `source` changed against the merge base with `destination`.
   * Bitbucket's spec is `source..destination` — the pull-request order, the
   * REVERSE of git's — and `topic=true` asks for the three-dot form.
   */
  private async diffstat(
    source: string,
    destination: string,
  ): Promise<BitbucketDiffstatEntry[]> {
    const out: BitbucketDiffstatEntry[] = [];
    const spec = `${encodeRef(source)}..${encodeRef(destination)}`;
    let page = 1;
    for (let visited = 0; visited < MAX_PAGES; visited++) {
      const listing = await this.json<BitbucketPage<BitbucketDiffstatEntry>>(
        `${this.repoBase}/diffstat/${spec}?topic=true&pagelen=${PAGE_SIZE}&page=${page}`,
      );
      if (listing === null) return out;
      out.push(...(listing.values ?? []));
      const next = nextPageNumber(listing);
      if (next === null || next <= page) break;
      page = next;
    }
    return out;
  }

  /** Empty string when the refs share no history — Bitbucket answers 404 there. */
  private async mergeBaseSha(base: string, head: string): Promise<string> {
    const json = await this.json<{ hash?: string | null }>(
      `${this.repoBase}/merge-base/${encodeRef(head)}..${encodeRef(base)}`,
    );
    return json?.hash ?? "";
  }

  private async token(): Promise<string> {
    return (await this.provider.tokenForRepo(this.repo)).token;
  }

  private async json<T>(
    pathAndQuery: string,
    init?: CallInit,
  ): Promise<T | null> {
    const res = await this.call(pathAndQuery, init);
    if (res === null) return null;
    return (await res.json()) as T;
  }

  /**
   * One authenticated REST call. 404 resolves to null so "absent" needs no
   * try/catch; every other non-2xx becomes a `GitProviderError`, carrying a
   * wait hint when Bitbucket rate-limited us.
   */
  private async call(
    pathAndQuery: string,
    init: CallInit = {},
  ): Promise<Response | null> {
    const res = await bitbucketFetch(
      `${BITBUCKET_API_BASE}${pathAndQuery}`,
      await this.token(),
      init,
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await bitbucketFailure(res);
    return res;
  }
}

/** Branch names and revisions are one path segment: slashes encode too. */
function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}
