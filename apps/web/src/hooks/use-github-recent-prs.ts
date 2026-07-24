/**
 * Fetches a few recent pull requests for the org's GitHub connection, for the
 * home Coding tile. Chains the proven-wired github-mcp-server tools: resolve the
 * installation (GITHUB_LIST_USER_ORGS) → list its repos (search_repositories) →
 * pull requests of the most-recently-updated repos (list_pull_requests). There
 * is no org-wide "all my PRs" tool wired, so we fan out over the top few busiest
 * repos and group the results per repo.
 */

import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import { fetchGithubInstallations } from "@/lib/github-installations";
import { extractPullRequestList } from "@/components/thread/github/github-pr-api";
import { KEYS } from "@/lib/query-keys";

export interface RecentPr {
  number: number;
  title: string;
  merged: boolean;
  state: "open" | "closed";
  htmlUrl: string;
}

export interface RepoPrs {
  repo: string;
  prs: RecentPr[];
}

interface RepoSummary {
  full_name: string;
  updated_at: string;
}

// ponytail: fan out one list_pull_requests per repo; no org-wide "my PRs" tool exists.
const MAX_REPOS = 3;
const PRS_PER_REPO = 5;

export function useGithubRecentPrs(connectionId: string) {
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
    queryKey: KEYS.homeGithubRecentPrs(org.id, connectionId),
    queryFn: async (): Promise<{ repos: RepoPrs[] }> => {
      const { installations } = await fetchGithubInstallations(
        (req) => self.callTool(req),
        connectionId,
      );
      const inst = installations[0];
      if (!inst) return { repos: [] };

      const qualifier = inst.type === "User" ? "user" : "org";
      const reposRes = await github.callTool({
        name: "search_repositories",
        arguments: {
          query: `${qualifier}:${inst.login}`,
          page: 1,
          perPage: 30,
        },
      });
      const reposText = (reposRes as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      const repos: RepoSummary[] = reposText
        ? ((JSON.parse(reposText).items ?? []) as RepoSummary[])
        : [];
      const top = [...repos]
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .filter((r) => r.full_name)
        .slice(0, MAX_REPOS);
      if (top.length === 0) return { repos: [] };

      const grouped = await Promise.all(
        top.map(async (r): Promise<RepoPrs> => {
          const [owner, repo] = r.full_name.split("/");
          const prsRes = await github.callTool({
            name: "list_pull_requests",
            arguments: { owner, repo, state: "all", perPage: PRS_PER_REPO },
          });
          const prs = extractPullRequestList(prsRes)
            .map((p) => ({
              number: (p.number as number) ?? 0,
              title: (p.title as string) ?? "",
              merged: (p.merged_at as string | null) != null,
              state:
                p.state === "closed" ? ("closed" as const) : ("open" as const),
              htmlUrl: (p.html_url as string) ?? "",
            }))
            .filter((p) => p.number > 0);
          return { repo: r.full_name, prs };
        }),
      );

      return { repos: grouped.filter((g) => g.prs.length > 0) };
    },
    staleTime: 60_000,
    retry: false,
  });
}
