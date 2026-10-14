/**
 * The Releases screen: a timeline of main's commits, newest first. A commit
 * may have a companion release (sites/<site>/revisions/<sha>.json, found with
 * one listing of the site's revisions/ prefix per page, never per commit):
 * only those can be republished (republish.ts). `current` is exactly the
 * commit latest.json names, read, never inferred; `serving` is what the site
 * itself reports serving (serving.ts), when it reports anything. A commit
 * without a companion (a developer push, or a Publish whose release write
 * failed) is just a merge.
 */

import { type RepoInsightsClient, requireBranchHead } from "@/git-providers";
import { deliveryKeys, getJson, listRevisionShas } from "./delivery-store";
import {
  ensureRevision,
  type HostedRepo,
  type LatestPointer,
  readLatest,
  writeLatest,
} from "./publish";
import { republishedFrom } from "./republish";
import {
  contentRevisionOf,
  SERVING_WINDOW_MINUTES,
  type ServedLabelsReader,
} from "./serving";

export interface ReleaseCommit {
  sha: string;
  date: string;
  message: string;
  author: string | null;
  /** Has a companion release: it can be republished. */
  hasRelease: boolean;
  /** This release republished the release of that commit. */
  republishOf: { sha: string } | null;
}

/**
 * What the site serves. `site`: its telemetry reported releases in the last
 * minutes; `revision` is the newest commit among them (null when none
 * matches a release Studio knows). `none`: no report (telemetry off or
 * elsewhere, no traffic, or no reader): the screen falls back to `current`.
 */
export type Serving =
  | { source: "site"; revision: string | null; lastSeen: string }
  | { source: "none" };

export interface ReleasesPage {
  /** What latest.json names; null when there is no latest.json. */
  current: LatestPointer | null;
  /** On the first page only (null on the next ones). */
  serving: Serving | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

const PAGE_SIZE = 50;
// OPEN: O-S5 — listCommits needs `since`; the whole history, paged by cursor.
const SINCE_EPOCH = "1970-01-01T00:00:00Z";
/** Release objects read per request to match bundled snapshot labels. */
const MAX_CONTENT_READS = 10;

/**
 * The commit sha a bundled snapshot's content revision belongs to: the
 * newest release on the page with that content (a republish and its
 * original share it), or null.
 */
async function matchContentRevision(
  repo: HostedRepo,
  label: string,
  releases: string[],
  budget: { reads: number },
): Promise<string | null> {
  for (const sha of releases) {
    const revision = await contentRevisionOf(sha, async () => {
      if (budget.reads <= 0) return null;
      budget.reads--;
      const object = await getJson(
        repo.store,
        deliveryKeys.revision(repo.site, sha),
      );
      const blocks = (object?.value as { blocks?: unknown } | undefined)
        ?.blocks;
      return typeof blocks === "object" && blocks !== null
        ? (blocks as Record<string, unknown>)
        : null;
    });
    if (revision === label) return sha;
  }
  return null;
}

async function readServing(
  repo: HostedRepo,
  reader: ServedLabelsReader | null,
  commits: ReleaseCommit[],
): Promise<Serving> {
  if (!reader) return { source: "none" };
  const labels = await reader(repo.site, SERVING_WINDOW_MINUTES).catch(
    (error) => {
      console.error("hosted releases: serving read failed", {
        site: repo.site,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );
  if (!labels || labels.length === 0) return { source: "none" };
  const releases = commits.filter((c) => c.hasRelease).map((c) => c.sha);
  const budget = { reads: MAX_CONTENT_READS };
  const served: string[] = [];
  for (const { label } of labels) {
    const sha =
      label.length === 40
        ? label
        : await matchContentRevision(repo, label, releases, budget);
    if (sha) served.push(sha);
  }
  // The site moves forward (each Publish and Republish is a newer commit):
  // of what it reported, the newest commit on the timeline is what it shows
  // now; isolates still on an older one catch up within a minute.
  const order = new Map(commits.map((c, i) => [c.sha, i]));
  const onPage = served
    .filter((sha) => order.has(sha))
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return {
    source: "site",
    revision: onPage[0] ?? served[0] ?? null,
    lastSeen: labels[0]?.lastSeen ?? "",
  };
}

export async function listReleases(
  repo: HostedRepo,
  insights: RepoInsightsClient,
  cursor: string | null,
  servedLabels: ServedLabelsReader | null = null,
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
    const from = republishedFrom(commit.body);
    return {
      sha: commit.sha,
      date: commit.date,
      message: commit.message,
      author: commit.author.name ?? commit.author.login,
      hasRelease: withRelease.has(commit.sha),
      republishOf: from ? { sha: from } : null,
    };
  });
  return {
    current,
    serving:
      cursor === null ? await readServing(repo, servedLabels, commits) : null,
    commits,
    nextCursor: page.nextCursor,
  };
}

/**
 * "Try again" after a Publish that committed but didn't go live (`release`
 * `created` or `none`): main's head gets its companion release when it is
 * missing, and is made current. The head holds every published change, the
 * failed Publish's included, so this never rolls back a newer Publish; and
 * its schema is main's own, so there is nothing to confirm.
 */
export async function makeHeadCurrent(
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
