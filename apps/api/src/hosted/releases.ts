/**
 * The Releases screen: what latest.json serves, main's git history (every
 * commit is a merged release), and which commits have a revision on the CDN
 * (one listing of the site's prefix). The CDN status is derived, never
 * stored: latest.json against main's head. "Make current" rewrites
 * latest.json only; Resync makes main's head live again and asks for
 * confirmation by the screen's own rule.
 */

import {
  type RepoCommitPage,
  type RepoInsightsClient,
  requireBranchHead,
} from "@/git-providers";
import {
  deliveryKeys,
  getJson,
  isCommitSha,
  listRevisionShas,
} from "./delivery-store";
import {
  type CdnStatus,
  type HostedRepo,
  type LatestPointer,
  RolledBackError,
  readLatest,
  releaseCommit,
  writeLatest,
} from "./publish";
import { NotV8Site, schemaHashAt } from "./release-objects";

/**
 * live: latest.json serves main's head. failed: it doesn't (a CDN step that
 * failed, a push outside the CMS, or nothing published yet): Resync. rolled
 * back: someone made an older release current after main's head was made.
 */
export type ReleaseState = "live" | "failed" | "rolled-back";

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
// OPEN: O-S5 — listCommits needs `since`; the whole history, paged by cursor.
const SINCE_EPOCH = "1970-01-01T00:00:00Z";

/**
 * The CDN status, derived: Live when latest.json names main's head; Rolled
 * back when it names another commit and was written after main's head was
 * committed (a Make current); Failed otherwise, latest.json missing included.
 * `headDate` is null when it isn't known (main moved while reading). Git
 * dates have whole seconds, so both sides compare in seconds.
 */
export function releaseState(
  current: LatestPointer | null,
  head: string,
  headDate: string | null,
): ReleaseState {
  if (!current) return "failed";
  if (current.revision === head) return "live";
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  return headDate !== null && seconds(current.publishedAt) > seconds(headDate)
    ? "rolled-back"
    : "failed";
}

async function headSchemaHashOf(repo: HostedRepo, head: string) {
  try {
    return await schemaHashAt(repo.client, repo.packagePath, head);
  } catch (error) {
    if (error instanceof NotV8Site) return null;
    throw error;
  }
}

async function statusAndFirstPage(
  repo: HostedRepo,
  insights: RepoInsightsClient,
): Promise<{
  status: ReleaseStatus;
  firstPage: RepoCommitPage;
  published: Set<string>;
}> {
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const [current, published, firstPage] = await Promise.all([
    readLatest(repo.store, repo.site),
    listRevisionShas(repo.store, repo.site),
    insights.listCommits({
      ref: repo.mainBranch,
      since: SINCE_EPOCH,
      cursor: null,
      limit: PAGE_SIZE,
    }),
  ]);
  const newest = firstPage.items[0];
  const headDate = newest?.sha === head ? newest.date : null;
  return {
    status: { current, head, state: releaseState(current, head, headDate) },
    firstPage,
    published,
  };
}

/** The screen's header: what latest.json serves against main. */
export async function releaseStatus(
  repo: HostedRepo,
  insights: RepoInsightsClient,
): Promise<ReleaseStatus> {
  return (await statusAndFirstPage(repo, insights)).status;
}

export async function listReleases(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  cursor: string | null,
): Promise<ReleasesPage> {
  const { status, firstPage, published } = await statusAndFirstPage(
    repo,
    insights,
  );
  const [headSchemaHash, page] = await Promise.all([
    headSchemaHashOf(repo, status.head),
    cursor
      ? insights.listCommits({
          ref: repo.mainBranch,
          since: SINCE_EPOCH,
          cursor,
          limit: PAGE_SIZE,
        })
      : firstPage,
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
 * when it's missing, and purge it from the edge (one retry). A failed write or
 * purge throws `LatestUpdateError` and the status stays Failed; `cdn:
 * "failed"` means main moved meanwhile. While the screen says Rolled back, it
 * needs `confirm`.
 */
export async function resync(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  options: { confirm: boolean },
): Promise<{ sha: string; cdn: CdnStatus }> {
  if (!options.confirm) {
    const status = await releaseStatus(repo, insights);
    if (status.state === "rolled-back") throw new RolledBackError();
  }
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const live = await releaseCommit(repo, head);
  return { sha: head, cdn: live ? "live" : "failed" };
}

/**
 * "Make current": point latest.json at a published revision. A failed write or
 * purge throws `LatestUpdateError`; the user retries.
 */
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
  await writeLatest(repo, pointer);
  return pointer;
}
