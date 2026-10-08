/**
 * The Releases screen: a timeline of main's commits, newest first. A commit
 * may have a companion release (sites/<site>/revisions/<sha>.json, found with
 * one listing of the site's revisions/ prefix per page, never per commit):
 * only those can be made current. "Current" is exactly the commit latest.json
 * names, read, never inferred. A commit without a companion (a developer
 * push, or a Publish whose release write failed) is just a merge.
 */

import { type RepoInsightsClient, requireBranchHead } from "@/git-providers";
import {
  deliveryKeys,
  getJson,
  isCommitSha,
  listRevisionShas,
} from "./delivery-store";
import {
  type HostedRepo,
  type LatestPointer,
  readLatest,
  writeLatest,
} from "./publish";
import { NotV8Site, schemaHashAt } from "./release-objects";

export interface ReleaseCommit {
  sha: string;
  date: string;
  message: string;
  author: string | null;
  /** Has a companion release: it can be made current. */
  hasRelease: boolean;
}

export interface ReleasesPage {
  /** What latest.json names; null when there is no latest.json. */
  current: LatestPointer | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

/** The commit has no companion release: there is nothing to make current. */
export class NotPublishedError extends Error {
  constructor() {
    super("This commit has no release");
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
  const [current, withRelease, page] = await Promise.all([
    readLatest(repo.store, repo.site),
    listRevisionShas(repo.store, repo.site),
    insights.listCommits({
      ref: repo.mainBranch,
      since: SINCE_EPOCH,
      cursor,
      limit: PAGE_SIZE,
    }),
  ]);
  return {
    current,
    commits: page.items.map((commit) => ({
      sha: commit.sha,
      date: commit.date,
      message: commit.message,
      author: commit.author.name ?? commit.author.login,
      hasRelease: withRelease.has(commit.sha),
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * "Make current": point latest.json at a commit's companion release and purge
 * it. It succeeds or throws (`LatestUpdateError` on a failed write or purge,
 * nothing restored); the screen then shows what latest.json says.
 */
export async function makeCurrent(
  repo: HostedRepo,
  sha: string,
  options: { confirm: boolean },
): Promise<LatestPointer> {
  if (!isCommitSha(sha)) throw new NotPublishedError();
  // OPEN: O-S7 — the companion is read for its schemaHash (no R2 metadata
  // field); a missing one means there is nothing to make current.
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
