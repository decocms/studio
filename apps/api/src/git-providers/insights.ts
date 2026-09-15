/**
 * Reading a repository's *history and shape* — what an audit measures and what
 * an agent greps — as an intention rather than as one provider's object model.
 *
 * This is the fourth contract next to `types.ts`, `content.ts` and
 * `change-requests.ts`, and it is separate from all three on purpose. A content
 * client addresses one blob or one branch at a time and a change-request client
 * answers about ONE change request; this one answers about a WINDOW: every
 * change request merged since a date, every commit on a branch since a date,
 * the whole tree at a ref, every file matching a query. Different shape,
 * different cost, different callers — folding it into `GitProviderClient` would
 * make every implementation carry paging machinery three of its callers never
 * use.
 *
 * Two things the providers genuinely disagree about are stated in the
 * interface rather than smoothed over, because a consumer that averages over
 * an unknown is worse than one that knows it cannot answer:
 *
 * - **Code search** is not universal. GitLab's basic search is per instance and
 *   Bitbucket's is per workspace, so `searchCode` answers `supported: false` as
 *   a NORMAL result. A caller must degrade (walk the tree, read files), never
 *   treat it as an error.
 * - **Line stats** cost differently per provider — inline on GitHub, one extra
 *   request per change request on Bitbucket, and not cheaply available at all
 *   on GitLab. {@link RepoInsightsCapabilities.lineStats} says which, and
 *   `additions`/`deletions` are `null` rather than zero when nobody can say.
 *   Zero would read as "a change that touched nothing".
 */

import type { RepoRef } from "@decocms/shared/git-providers";

/** Default number of tree entries one listing returns, when the caller is quiet. */
export const DEFAULT_TREE_ENTRIES = 400;
/** Ceiling on a tree listing: past this, a caller wants the archive instead. */
export const MAX_TREE_ENTRIES = 2000;
/** Default byte budget for one file read. */
export const DEFAULT_FILE_BYTES = 60_000;
/** Ceiling on one file read — a prompt window, not a checkout. */
export const MAX_FILE_BYTES = 200_000;
/** Ceiling on code-search hits per call. */
export const MAX_SEARCH_HITS = 50;
/** Ceiling on change requests per page: the fan-out multiplier when commits or stats are asked for. */
export const MAX_CHANGE_REQUEST_PAGE = 50;
/** Ceiling on commits per page. */
export const MAX_COMMIT_PAGE = 100;

/**
 * One entry of a recursive tree listing. No object sha, unlike
 * {@link import("./content").TreeEntry} — a reader of this listing navigates by
 * path and asks {@link RepoInsightsClient.readFile} for content, and Bitbucket's
 * recursive listing does not report one anyway.
 */
export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface RepoTreeListing {
  /** The ref actually read — the resolved default branch when the caller named none. */
  ref: string;
  entries: RepoTreeEntry[];
  /**
   * There is more tree than `entries` shows, because the cap was hit or the
   * provider itself truncated. A consumer must not read the listing as the
   * whole repository when this is true.
   */
  truncated: boolean;
}

export interface RepoFileContent {
  /** Null when the path does not exist at that ref — absence, not failure. */
  content: string | null;
  /** The file's full size when the provider reports it, else the bytes read. */
  size: number | null;
  /** `content` stops at the byte budget; the file continues past it. */
  truncated: boolean;
}

export interface CodeSearchHit {
  path: string;
  /** A matching excerpt, when the provider returns one with the hit. */
  fragment?: string;
}

export interface CodeSearchResult {
  /**
   * False when this provider, instance or workspace has no code search at all.
   * A normal answer, not an error: `hits` is empty and the caller falls back to
   * the tree.
   */
  supported: boolean;
  /** The provider gave up early; there are matches it did not report. */
  incomplete: boolean;
  hits: CodeSearchHit[];
}

/** Who wrote a change request, reduced to what an author histogram needs. */
export interface ChangeRequestAuthor {
  login: string;
  /**
   * A machine opened it. Load-bearing for every "how many people work here"
   * measure — a renovate bot filing 300 change requests is not a contributor.
   * Taken from the provider when it says (GitHub's `Bot` typename, GitLab's
   * `author.bot`), inferred from the login otherwise.
   */
  isBot: boolean;
}

/**
 * A change request as a HISTORY row: what it cost and how long it took, not
 * what a reviewer acts on. Deliberately not {@link import("./change-requests").ChangeRequest}
 * — that one carries CI, conflicts and a head sha, all of which cost extra
 * calls and none of which a window over a year of merges reads.
 */
export interface ChangeRequestHistoryItem {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  author: ChangeRequestAuthor;
  createdAt: string;
  updatedAt: string;
  /**
   * Null on a merged change request means the provider does not carry the
   * merge time on the object (Bitbucket). Every lead-time measure must report
   * itself blocked on that rather than substituting `updatedAt`, which is when
   * someone last commented.
   */
  mergedAt: string | null;
  closedAt: string | null;
  /** Branch it targets. */
  base: string;
  /** Branch it proposes. */
  head: string;
  /** Null when stats were not asked for, or when the provider cannot say cheaply. */
  additions: number | null;
  deletions: number | null;
  /**
   * Null when commits were not asked for. `count` is the provider's total,
   * which can exceed `items.length` when the change request is huge.
   */
  commits: {
    count: number | null;
    items: Array<{ sha: string; date: string }>;
  } | null;
}

export interface ChangeRequestHistoryPage {
  items: ChangeRequestHistoryItem[];
  /** Opaque and provider-owned; null when the window is exhausted. */
  nextCursor: string | null;
}

export interface RepoCommitAuthor {
  name: string | null;
  /**
   * The git author email, which is what distinguishes two humans sharing a
   * display name and what identifies a no-reply address. Null when the
   * provider does not expose it.
   */
  email: string | null;
  /** The provider account the commit is attributed to, when it maps to one. */
  login: string | null;
}

export interface RepoCommit {
  sha: string;
  date: string;
  /** The subject line, not the full body — every consumer matches on the first line. */
  message: string;
  author: RepoCommitAuthor;
}

export interface RepoCommitPage {
  items: RepoCommit[];
  nextCursor: string | null;
}

/** What this provider can actually answer, so a caller need not probe to find out. */
export interface RepoInsightsCapabilities {
  codeSearch: boolean;
  /**
   * - `inline` — additions/deletions ride along with the change request.
   * - `per_request` — one extra call per change request buys them.
   * - `none` — not available at a cost this interface is willing to pay.
   */
  lineStats: "inline" | "per_request" | "none";
}

export interface ListTreeParams {
  /** Branch, tag or sha; the default branch when omitted. */
  ref?: string;
  maxEntries?: number;
}

export interface ReadFileParams {
  path: string;
  ref?: string;
  maxBytes?: number;
}

export interface SearchCodeParams {
  query: string;
  limit?: number;
}

export interface ListChangeRequestsParams {
  state: "merged" | "open" | "all";
  /** Only change requests touched at or after this instant. */
  updatedAfter?: string;
  cursor?: string | null;
  limit?: number;
  /** Buys the per-change-request commit list, at a cost that varies by provider. */
  includeCommits?: boolean;
  /** Buys `additions`/`deletions` — see {@link RepoInsightsCapabilities.lineStats}. */
  includeStats?: boolean;
}

export interface ListCommitsParams {
  /** Branch or sha; the default branch when omitted. */
  ref?: string;
  /** Required: an unbounded history walk is never what a caller wants here. */
  since: string;
  cursor?: string | null;
  limit?: number;
}

export interface RepoInsightsClient {
  readonly repo: RepoRef;

  capabilities(): RepoInsightsCapabilities;

  /**
   * Every path under `ref`, capped. The cap is the point: a storefront
   * monorepo's tree is megabytes, and every consumer of this is deciding which
   * handful of files to read next.
   */
  listTree(params?: ListTreeParams): Promise<RepoTreeListing>;

  /** One file's text at a ref, capped at `maxBytes`. */
  readFile(params: ReadFileParams): Promise<RepoFileContent>;

  /** Paths matching `query`, when this provider has code search at all. */
  searchCode(params: SearchCodeParams): Promise<CodeSearchResult>;

  /**
   * Change requests in `state`, newest activity first, one page at a time.
   * Ordered by when they were last UPDATED rather than merged, because that is
   * the only ordering all three providers can filter a window on; a caller
   * reading merges pages until `updatedAt` falls out of its window.
   */
  listChangeRequests(
    params: ListChangeRequestsParams,
  ): Promise<ChangeRequestHistoryPage>;

  /** Commits on `ref` since an instant, newest first, one page at a time. */
  listCommits(params: ListCommitsParams): Promise<RepoCommitPage>;
}

/**
 * Logins that are a machine, for the providers that do not flag it themselves.
 * GitHub App actors end in `[bot]`; the rest is the convention every CI vendor
 * follows for the service account it pushes as.
 */
const BOT_LOGIN_RE = /\[bot\]$|[-_.]bot$|^bot[-_.]|^(dependabot|renovate)$/i;

/** Whether a login looks like a machine. Pure — the inference, stated once. */
export function loginLooksLikeBot(login: string): boolean {
  return BOT_LOGIN_RE.test(login.trim());
}

/**
 * Clamp a caller's request to this interface's ceiling, falling back to the
 * default when it asked for nothing. A zero or negative ask is the default, not
 * an empty page — a caller that wants nothing does not call.
 */
export function cappedLimit(
  requested: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return Math.min(fallback, ceiling);
  }
  return Math.min(Math.floor(requested), ceiling);
}

/**
 * Read at most `maxBytes` of a response body, without buffering the rest.
 *
 * A repository can hold a 200 MB fixture, and `await res.text()` on it would
 * put that in memory before any cap could apply. Reading the stream and
 * stopping is what makes the cap a real budget rather than a post-hoc slice.
 *
 * `size` prefers the provider's `Content-Length`, which is the file's true size
 * even when we stopped short of it. A multi-byte character straddling the cap
 * decodes to U+FFFD, which a truncated read can afford.
 */
export async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<{ content: string; size: number | null; truncated: boolean }> {
  const header = res.headers.get("content-length");
  const declared = header === null ? Number.NaN : Number(header);
  const size = Number.isFinite(declared) && declared >= 0 ? declared : null;

  const body = res.body;
  if (!body) {
    return { content: "", size: size ?? 0, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - read;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        read += remaining;
        truncated = value.byteLength > remaining;
        break;
      }
      chunks.push(value);
      read += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const content = new TextDecoder().decode(concatChunks(chunks, read));
  return {
    content,
    size: size ?? read,
    truncated: truncated || (size !== null && size > read),
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A page number as an opaque cursor, for the two providers that page by number.
 * Invalid input is page 1 rather than a throw: a cursor is the caller echoing
 * back something we minted, and a garbled one should restart the listing rather
 * than fail an audit that was mid-walk.
 */
export function pageFromCursor(cursor: string | null | undefined): number {
  const page = Number(cursor);
  return Number.isInteger(page) && page > 1 ? page : 1;
}
