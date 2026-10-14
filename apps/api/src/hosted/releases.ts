/**
 * The Releases screen: a timeline of main's commits, newest first. A commit
 * may have a companion release (sites/<site>/revisions/<sha>.json, found with
 * one listing of the site's revisions/ prefix per page, never per commit):
 * only those versions can be reapplied (reapply.ts). `current` is exactly the
 * commit latest.json names, read, never inferred (the screen's "Latest"). A
 * commit without a companion (a developer push, or a Publish whose release
 * write failed) is just a merge.
 */

import { type RepoInsightsClient, requireBranchHead } from "@/git-providers";
import { listRevisionShas } from "./delivery-store";
import {
  ensureRevision,
  type HostedRepo,
  type LatestPointer,
  readLatest,
  writeLatest,
} from "./publish";
import { reappliedFrom } from "./reapply";

export interface ReleaseCommit {
  sha: string;
  date: string;
  message: string;
  author: string | null;
  /** Has a companion release: it can be reapplied. */
  hasRelease: boolean;
  /** This version reapplied the version of that commit. */
  reapplyOf: { sha: string } | null;
}

export interface ReleasesPage {
  /** What latest.json names; null when there is no latest.json. */
  current: LatestPointer | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

const PAGE_SIZE = 50;
// OPEN: O-S5 — listCommits needs `since`; the whole history, paged by cursor.
const SINCE_EPOCH = "1970-01-01T00:00:00Z";

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
  const commits = page.items.map((commit): ReleaseCommit => {
    const from = reappliedFrom(commit.body);
    return {
      sha: commit.sha,
      date: commit.date,
      message: commit.message,
      author: commit.author.name ?? commit.author.login,
      hasRelease: withRelease.has(commit.sha),
      reapplyOf: from ? { sha: from } : null,
    };
  });
  return {
    current,
    commits,
    nextCursor: page.nextCursor,
  };
}

/**
 * "Try again" after a Publish that committed but wasn't released (`release`
 * `created` or `none`): main's head gets its companion release when it is
 * missing, and is made current. The head holds every published change, the
 * failed Publish's included, so this never rolls back a newer Publish; and
 * its schema is main's own, so there is nothing to confirm.
 */
export async function releaseMainHead(
  repo: HostedRepo,
): Promise<LatestPointer> {
  const head = await requireBranchHead(repo.client, repo.mainBranch);
  const schemaHash = await ensureRevision(repo, head);
  const pointer: LatestPointer = {
    revision: head,
    schemaHash,
    publishedAt: new Date().toISOString(),
  };
  await writeLatest(repo, pointer);
  return pointer;
}
