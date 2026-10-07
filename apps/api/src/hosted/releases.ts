/**
 * The Releases screen: what latest.json serves, main's git history, and which
 * commits have a revision on the CDN (one listing of the site's prefix
 * intersected with the log). "Make current" rewrites latest.json only; the
 * history is git plus that listing, with no log of its own.
 */

import { type RepoInsightsClient, requireBranchHead } from "@/git-providers";
import {
  CACHE_LATEST,
  deliveryKeys,
  getJson,
  isCommitSha,
  listRevisionShas,
} from "./delivery-store";
import { type HostedRepo, type LatestPointer, readLatest } from "./publish";
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

export interface ReleasesPage {
  current: LatestPointer | null;
  head: string;
  headSchemaHash: string | null;
  state: ReleaseState;
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
 * Pending: nothing published yet. Rolled back: latest.json names a published
 * revision other than main's head. Live: otherwise.
 */
export function releaseState(
  current: LatestPointer | null,
  head: string,
  published: ReadonlySet<string>,
): ReleaseState {
  if (!current) return "pending";
  if (current.revision !== head && published.has(current.revision)) {
    return "rolled-back";
  }
  return "live";
}

async function headSchemaHashOf(repo: HostedRepo, head: string) {
  try {
    return await schemaHashAt(repo.client, repo.packagePath, head);
  } catch (error) {
    if (error instanceof NotV8Site) return null;
    throw error;
  }
}

export async function listReleases(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  cursor: string | null,
): Promise<ReleasesPage> {
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const [current, published, headSchemaHash, page] = await Promise.all([
    readLatest(repo.store, repo.site),
    listRevisionShas(repo.store, repo.site),
    headSchemaHashOf(repo, head),
    insights.listCommits({
      ref: repo.mainBranch,
      since: SINCE_EPOCH,
      cursor,
      limit: PAGE_SIZE,
    }),
  ]);
  return {
    current,
    head,
    headSchemaHash,
    state: releaseState(current, head, published),
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
    publishedAt: new Date().toISOString(),
  };
  await repo.store.putJson(
    deliveryKeys.latest(repo.site),
    pointer,
    CACHE_LATEST,
  );
  return pointer;
}
