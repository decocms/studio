/**
 * Pushes to the default branch of the repositories an org's agents work in,
 * as markers on the order charts: commits collapse into one marker per
 * 15-minute bucket of the store's local day. A read that fails drops that
 * repository's markers; the chart renders without them.
 */

import type {
  OrderMonitorPush,
  OrderMonitorPushes,
} from "@decocms/shared/order-monitor";
import {
  evictExpiredTtlCacheEntries,
  refreshTtlCacheEntry,
} from "@/core/ttl-lru-cache";
import { mapBounded } from "@decocms/shared/std";
import type { StudioContext } from "@/core/studio-context";
import { insightsClientForRepository } from "@/git-providers/clients";
import { MAX_COMMIT_PAGE, type RepoCommit } from "@/git-providers/insights";
import type { RepositoryRecord } from "@/storage/repositories";
import { localDayStart, localMinutes } from "./order-lake";

const DAY_MS = 24 * 60 * 60 * 1000;
/** `listCommits` has no upper bound, so a day long past needs the pages since it. */
// ponytail: commits more than MAX_PAGES × 100 pushes back are not reached; add an `until` to RepoInsightsClient if that matters.
const MAX_PAGES = 3;
/** A past day's commits don't change; today's do. */
const PAST_DAY_TTL_MS = 6 * 60 * 60 * 1000;
const TODAY_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 2_000;

const dayCache = new Map<string, { value: RepoCommit[]; at: number }>();

async function commitsOfDay(
  ctx: StudioContext,
  repository: RepositoryRecord,
  dayStart: Date,
): Promise<RepoCommit[]> {
  const dayEnd = dayStart.getTime() + DAY_MS;
  const key = `${repository.organizationId}:${repository.id}:${dayStart.toISOString()}`;
  const ttl = dayEnd < Date.now() ? PAST_DAY_TTL_MS : TODAY_TTL_MS;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  const client = await insightsClientForRepository(ctx, repository);
  const commits: RepoCommit[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listCommits({
      ref: repository.defaultBranch ?? undefined,
      since: dayStart.toISOString(),
      cursor,
      limit: MAX_COMMIT_PAGE,
    });
    commits.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  const value = commits.filter((c) => Date.parse(c.date) < dayEnd);
  refreshTtlCacheEntry(dayCache, key, value);
  evictExpiredTtlCacheEntries(dayCache, CACHE_MAX_SIZE, PAST_DAY_TTL_MS);
  return value;
}

/** Commits in the same 15-minute local bucket collapse into one marker. */
export function toMarkers(
  commits: RepoCommit[],
  timezone: string,
): OrderMonitorPush[] {
  const byBucket = new Map<number, RepoCommit[]>();
  for (const c of commits) {
    const bucket = Math.floor(localMinutes(new Date(c.date), timezone) / 15);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), c]);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, group]) => {
      const sorted = group.sort((a, b) => a.date.localeCompare(b.date));
      return {
        bucket,
        time: sorted[0]!.date,
        commits: sorted.map((c) => ({
          sha: c.sha,
          message: c.message,
          author:
            c.author.name ?? c.author.login ?? c.author.email ?? "unknown",
        })),
      };
    });
}

/** Pushes during the local day containing `at`, or within [since, until) when given. */
export async function listPushes(
  ctx: StudioContext,
  organizationId: string,
  repositoryIds: string[],
  at: Date,
  timezone: string,
  window?: { since: Date; until: Date },
): Promise<OrderMonitorPushes> {
  // A window across midnight reads both local days.
  const dayStarts = [
    ...new Set(
      (window
        ? [window.since, new Date(window.until.getTime() - 1)]
        : [at]
      ).map((t) => localDayStart(t, timezone).toISOString()),
    ),
  ].map((iso) => new Date(iso));
  const repos = await Promise.all(
    repositoryIds.map(async (id) => {
      const repository = await ctx.storage.repositories.get(id, organizationId);
      if (!repository) return null;
      try {
        let commits = (
          await Promise.all(
            dayStarts.map((d) => commitsOfDay(ctx, repository, d)),
          )
        ).flat();
        if (window) {
          commits = commits.filter((c) => {
            const t = Date.parse(c.date);
            return t >= window.since.getTime() && t < window.until.getTime();
          });
        }
        return {
          repositoryId: repository.id,
          name: repository.path,
          markers: toMarkers(commits, timezone),
        };
      } catch (err) {
        console.warn(
          `[order-monitor] commits of repository ${repository.id} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  return { repos: repos.filter((r) => r !== null) };
}

/** How far back the Monitor's Deploys tab reads, and how many repos it reads at once. */
const DEPLOY_WINDOW_MS = 14 * DAY_MS;
const DEPLOY_REPO_CONCURRENCY = 4;

export interface RepositoryPush {
  repositoryId: string;
  repositoryPath: string;
  push: OrderMonitorPush;
}

/**
 * The org's monitored repositories' pushes over the last two weeks, newest
 * first. A push is the commits of one 15-minute bucket, as on the order charts.
 */
// ponytail: a merge commit brings its branch's commits at their own dates, so they land as earlier pushes; read merged change requests instead if that misleads.
export async function listRecentPushes(
  ctx: StudioContext,
  organizationId: string,
): Promise<RepositoryPush[]> {
  const repositories = (
    await ctx.storage.repositories.listByOrg(organizationId)
  ).filter((r) => r.monitorDeploys);
  const since = new Date(Date.now() - DEPLOY_WINDOW_MS);
  const perRepo = await mapBounded(
    repositories,
    DEPLOY_REPO_CONCURRENCY,
    async (repository) => {
      try {
        const commits = await recentCommits(ctx, repository, since);
        return toMarkers(commits, "UTC").map((push) => ({
          repositoryId: repository.id,
          repositoryPath: repository.path,
          push,
        }));
      } catch (err) {
        console.warn(
          `[monitor] commits of repository ${repository.id} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    },
  );
  return perRepo.flat().sort((a, b) => b.push.time.localeCompare(a.push.time));
}

const recentCache = new Map<string, { value: RepoCommit[]; at: number }>();

async function recentCommits(
  ctx: StudioContext,
  repository: RepositoryRecord,
  since: Date,
): Promise<RepoCommit[]> {
  const key = `${repository.organizationId}:${repository.id}`;
  const hit = recentCache.get(key);
  if (hit && Date.now() - hit.at < TODAY_TTL_MS) return hit.value;
  const client = await insightsClientForRepository(ctx, repository);
  const commits: RepoCommit[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listCommits({
      ref: repository.defaultBranch ?? undefined,
      since: since.toISOString(),
      cursor,
      limit: MAX_COMMIT_PAGE,
    });
    commits.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  refreshTtlCacheEntry(recentCache, key, commits);
  evictExpiredTtlCacheEntries(recentCache, CACHE_MAX_SIZE, TODAY_TTL_MS);
  return commits;
}
