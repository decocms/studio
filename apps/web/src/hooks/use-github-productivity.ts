/**
 * "Team productivity" — who shipped what in the org's GitHub repos over the
 * last four weeks. Aggregates `list_commits` per author across the few busiest
 * repos (same repo resolution as the other home GitHub tiles) into a per-person
 * commit count plus a week-over-week total, so the tile shows real throughput
 * instead of a placeholder.
 */

import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import { fetchTopGithubRepos, readToolList } from "@/lib/github-top-repos";
import { KEYS } from "@/lib/query-keys";

const MAX_REPOS = 3;
const COMMITS_PER_REPO = 100;
export const PRODUCTIVITY_WEEKS = 4;
const DAY_MS = 86_400_000;

export interface Contributor {
  login: string;
  avatarUrl?: string;
  commits: number;
}

export interface TeamProductivity {
  /** Commits in the window, most recent week last. */
  weeks: number[];
  totalCommits: number;
  /** Commits in the most recent 7 days vs the 7 before it, in percent. */
  deltaPercent: number | null;
  contributors: Contributor[];
  repos: number;
}

interface CommitLike {
  commit?: {
    author?: { date?: string; name?: string };
    committer?: { date?: string };
  };
  author?: { login?: string; avatar_url?: string } | null;
}

export function useGithubProductivity(connectionId: string) {
  const { org } = useProjectContext();
  const self = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const github = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.homeGithubProductivity(org.id, connectionId),
    queryFn: async (): Promise<TeamProductivity> => {
      const repos = await fetchTopGithubRepos(
        (req) => self.callTool(req),
        (req) => github.callTool(req),
        connectionId,
        MAX_REPOS,
      );
      const empty: TeamProductivity = {
        weeks: Array.from({ length: PRODUCTIVITY_WEEKS }, () => 0),
        totalCommits: 0,
        deltaPercent: null,
        contributors: [],
        repos: repos.length,
      };
      if (repos.length === 0) return empty;

      const since = new Date(Date.now() - PRODUCTIVITY_WEEKS * 7 * DAY_MS);
      const results = await Promise.all(
        repos.map((r) =>
          github
            .callTool({
              name: "list_commits",
              arguments: {
                owner: r.owner,
                repo: r.repo,
                since: since.toISOString(),
                perPage: COMMITS_PER_REPO,
              },
            })
            .then((res) => readToolList<CommitLike>(res))
            .catch((): CommitLike[] => []),
        ),
      );

      const weeks = Array.from({ length: PRODUCTIVITY_WEEKS }, () => 0);
      const byAuthor = new Map<string, Contributor>();
      const now = Date.now();
      let total = 0;

      for (const commit of results.flat()) {
        const raw =
          commit.commit?.author?.date ?? commit.commit?.committer?.date ?? "";
        const at = new Date(raw).getTime();
        if (Number.isNaN(at)) continue;
        const daysAgo = Math.floor((now - at) / DAY_MS);
        if (daysAgo < 0 || daysAgo >= PRODUCTIVITY_WEEKS * 7) continue;

        const weekIdx = PRODUCTIVITY_WEEKS - 1 - Math.floor(daysAgo / 7);
        weeks[weekIdx] = (weeks[weekIdx] ?? 0) + 1;
        total += 1;

        const login =
          commit.author?.login ?? commit.commit?.author?.name ?? "unknown";
        const existing = byAuthor.get(login);
        if (existing) existing.commits += 1;
        else
          byAuthor.set(login, {
            login,
            avatarUrl: commit.author?.avatar_url,
            commits: 1,
          });
      }

      const lastWeek = weeks[PRODUCTIVITY_WEEKS - 1] ?? 0;
      const prevWeek = weeks[PRODUCTIVITY_WEEKS - 2] ?? 0;

      return {
        weeks,
        totalCommits: total,
        deltaPercent:
          prevWeek > 0
            ? Math.round(((lastWeek - prevWeek) / prevWeek) * 100)
            : null,
        contributors: [...byAuthor.values()].sort(
          (a, b) => b.commits - a.commits,
        ),
        repos: repos.length,
      };
    },
    staleTime: 300_000,
    retry: false,
  });
}
