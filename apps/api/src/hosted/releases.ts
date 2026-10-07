/**
 * The Releases screen: what latest.json serves, main's git history, and which
 * commits have a revision on the CDN (one listing of the site's prefix
 * intersected with the log). "Make current" rewrites latest.json only; the
 * history is git plus that listing, with no log of its own. Resync lives here
 * too, since it asks for confirmation by the screen's own rule.
 */

import {
  type RepoCommitPage,
  type RepoInsightsClient,
  requireBranchHead,
} from "@/git-providers";
import {
  CACHE_LATEST,
  deliveryKeys,
  getJson,
  isCommitSha,
  listRevisionShas,
} from "./delivery-store";
import {
  type HostedRepo,
  type LatestPointer,
  type PublishResult,
  RolledBackError,
  readLatest,
  releaseCommit,
} from "./publish";
import { NotV8Site, schemaHashAt } from "./release-objects";

export type ReleaseState = "live" | "rolled-back" | "pending";

export interface ReleaseCommit {
  sha: string;
  date: string;
  message: string;
  author: string | null;
  /** Has `revisions/<sha>.json`: it can be made current. */
  published: boolean;
}

export interface ReleaseStatus {
  current: LatestPointer | null;
  head: string;
  state: ReleaseState;
  /** Main's head has no revision object: commits the CMS didn't publish. */
  unpublishedCommits: boolean;
  /** latest.json's revision isn't in main's history (force-push/rewrite). */
  revisionOffMain: boolean;
  /** No CMS-published commit in the last {@link HISTORY_WINDOW} of main. */
  noRecentRelease: boolean;
}

export interface ReleasesPage extends ReleaseStatus {
  headSchemaHash: string | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

/** The commit was never published by the CMS: there is nothing to roll to. */
export class NotPublishedError extends Error {
  constructor() {
    super("Not published by the CMS");
    this.name = "NotPublishedError";
  }
}

/** The target's schema differs from main's and the user didn't confirm. */
export class SchemaMismatchError extends Error {
  constructor(
    readonly target: string,
    readonly head: string | null,
  ) {
    super("schema-mismatch");
    this.name = "SchemaMismatchError";
  }
}

const PAGE_SIZE = 50;
const MAX_PAGES = 5;
/** How many of main's commits the state search walks: 5 pages of 50. */
export const HISTORY_WINDOW = PAGE_SIZE * MAX_PAGES;
// OPEN: O-S5 — listCommits needs `since`; the whole history, paged by cursor.
const SINCE_EPOCH = "1970-01-01T00:00:00Z";

/** What a walk of main's history (newest first) found. */
export interface MainWalk {
  /** The newest commit with a revision object, or null in the window. */
  newestPublished: string | null;
  /**
   * Whether latest.json's revision is on main: null when the window ran out
   * before it was found (it may just be older).
   */
  currentOnMain: boolean | null;
  firstPage: RepoCommitPage;
}

/**
 * Walks main 50 commits per page, at most 5 pages, until it has found the
 * newest published commit and latest.json's revision.
 */
export async function walkMain(
  insights: RepoInsightsClient,
  mainBranch: string,
  published: ReadonlySet<string>,
  currentRevision: string | null,
): Promise<MainWalk> {
  let newestPublished: string | null = null;
  let currentFound = false;
  let firstPage: RepoCommitPage | null = null;
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await insights.listCommits({
      ref: mainBranch,
      since: SINCE_EPOCH,
      cursor,
      limit: PAGE_SIZE,
    });
    firstPage ??= page;
    for (const commit of page.items) {
      if (newestPublished === null && published.has(commit.sha)) {
        newestPublished = commit.sha;
      }
      if (commit.sha === currentRevision) currentFound = true;
    }
    const done =
      newestPublished !== null && (currentFound || currentRevision === null);
    if (done) break;
    if (!page.nextCursor) {
      return { newestPublished, currentOnMain: currentFound, firstPage };
    }
    cursor = page.nextCursor;
  }
  return {
    newestPublished,
    currentOnMain: currentFound ? true : null,
    firstPage: firstPage!,
  };
}

/**
 * Pending: nothing published yet. Rolled back: latest.json names a revision
 * older (in main's history) than the newest CMS-published one, or one no
 * longer on main. Live: otherwise — a head the CMS didn't publish (a
 * developer's push) keeps it Live, with `unpublishedCommits`.
 */
export function releaseState(
  current: LatestPointer | null,
  head: string,
  published: ReadonlySet<string>,
  walk: Pick<MainWalk, "newestPublished" | "currentOnMain">,
): Omit<ReleaseStatus, "current" | "head"> {
  const unpublishedCommits = current !== null && !published.has(head);
  const revisionOffMain = current !== null && walk.currentOnMain === false;
  const noRecentRelease = walk.newestPublished === null;
  if (!current) {
    return {
      state: "pending",
      unpublishedCommits,
      revisionOffMain,
      noRecentRelease,
    };
  }
  const rolledBack =
    revisionOffMain ||
    (walk.newestPublished !== null &&
      walk.newestPublished !== current.revision);
  return {
    // OPEN: a revision past the window (currentOnMain null) with a newer
    // published commit is Rolled back without "(revision no longer on main)".
    state: rolledBack ? "rolled-back" : "live",
    unpublishedCommits,
    revisionOffMain,
    noRecentRelease,
  };
}

async function headSchemaHashOf(repo: HostedRepo, head: string) {
  try {
    return await schemaHashAt(repo.client, repo.packagePath, head);
  } catch (error) {
    if (error instanceof NotV8Site) return null;
    throw error;
  }
}

async function statusAndWalk(repo: HostedRepo, insights: RepoInsightsClient) {
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const [current, published] = await Promise.all([
    readLatest(repo.store, repo.site),
    listRevisionShas(repo.store, repo.site),
  ]);
  const walk = await walkMain(
    insights,
    repo.mainBranch,
    published,
    current?.revision ?? null,
  );
  const status: ReleaseStatus = {
    current,
    head,
    ...releaseState(current, head, published, walk),
  };
  return { status, walk, published };
}

/** The screen's header: what latest.json serves against main. */
export async function releaseStatus(
  repo: HostedRepo,
  insights: RepoInsightsClient,
): Promise<ReleaseStatus> {
  return (await statusAndWalk(repo, insights)).status;
}

export async function listReleases(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  cursor: string | null,
): Promise<ReleasesPage> {
  const { status, walk, published } = await statusAndWalk(repo, insights);
  const [headSchemaHash, page] = await Promise.all([
    headSchemaHashOf(repo, status.head),
    cursor
      ? insights.listCommits({
          ref: repo.mainBranch,
          since: SINCE_EPOCH,
          cursor,
          limit: PAGE_SIZE,
        })
      : walk.firstPage,
  ]);
  return {
    ...status,
    headSchemaHash,
    commits: page.items.map((commit) => ({
      sha: commit.sha,
      date: commit.date,
      message: commit.message,
      author: commit.author.name ?? commit.author.login,
      published: published.has(commit.sha),
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * Resync: point latest.json at main's head, writing its revision object first
 * when it's missing. While the screen says Rolled back, it needs `confirm`.
 */
export async function resync(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  options: { confirm: boolean },
): Promise<PublishResult> {
  if (!options.confirm) {
    const status = await releaseStatus(repo, insights);
    if (status.state === "rolled-back") throw new RolledBackError();
  }
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const live = await releaseCommit(repo, head);
  return { result: live ? "published" : "pending", sha: head };
}

/** "Make current": point latest.json at a published revision. */
export async function makeCurrent(
  repo: HostedRepo,
  sha: string,
  options: { confirm: boolean },
): Promise<LatestPointer> {
  if (!isCommitSha(sha)) throw new NotPublishedError();
  // OPEN: O-S7 — the revision object is read for its schemaHash (no R2
  // metadata field); a missing one is "not published by the CMS".
  const object = await getJson(
    repo.store,
    deliveryKeys.revision(repo.site, sha),
  );
  const schemaHash = (object?.value as { schemaHash?: unknown } | undefined)
    ?.schemaHash;
  if (typeof schemaHash !== "string") throw new NotPublishedError();
  if (!options.confirm) {
    const head = await requireBranchHead(repo.client, repo.mainBranch);
    const headSchemaHash = await headSchemaHashOf(repo, head);
    if (schemaHash !== headSchemaHash) {
      throw new SchemaMismatchError(schemaHash, headSchemaHash);
    }
  }
  const pointer: LatestPointer = {
    revision: sha,
    schemaHash,
    // Every latest.json write is stamped now: the SDK prefers the CDN only
    // when publishedAt is later than its bundle's build time.
    publishedAt: new Date().toISOString(),
  };
  await repo.store.putJson(
    deliveryKeys.latest(repo.site),
    pointer,
    CACHE_LATEST,
  );
  return pointer;
}
