/**
 * Fetches a few recent pull requests for the org's GitHub connection, for the
 * home Coding tile. Chains the proven-wired github-mcp-server tools: resolve the
 * installation (GITHUB_LIST_USER_ORGS) → list its repos (search_repositories) →
 * pull requests of the most-recently-updated repo (list_pull_requests). There is
 * no org-wide "all my PRs" tool wired, so we scope to the busiest repo.
 */

import { useQuery } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { fetchGithubInstallations } from "@/web/lib/github-installations";
import { extractPullRequestList } from "@/web/components/thread/github/github-pr-api";
import { KEYS } from "@/web/lib/query-keys";

export interface RecentPr {
  number: number;
  title: string;
  merged: boolean;
  state: "open" | "closed";
  htmlUrl: string;
}

interface RepoSummary {
  full_name: string;
  updated_at: string;
}

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
    queryFn: async (): Promise<{ prs: RecentPr[]; repo: string | null }> => {
      const { installations } = await fetchGithubInstallations(
        (req) => self.callTool(req),
        connectionId,
      );
      const inst = installations[0];
      if (!inst) return { prs: [], repo: null };

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
      const top = [...repos].sort((a, b) =>
        (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
      )[0];
      if (!top?.full_name) return { prs: [], repo: null };

      const [owner, repo] = top.full_name.split("/");
      const prsRes = await github.callTool({
        name: "list_pull_requests",
        arguments: { owner, repo, state: "all", perPage: 5 },
      });
      const prs = extractPullRequestList(prsRes)
        .map((p) => ({
          number: (p.number as number) ?? 0,
          title: (p.title as string) ?? "",
          merged: (p.merged_at as string | null) != null,
          state: p.state === "closed" ? ("closed" as const) : ("open" as const),
          htmlUrl: (p.html_url as string) ?? "",
        }))
        .filter((p) => p.number > 0);

      return { prs, repo: top.full_name };
    },
    staleTime: 60_000,
    retry: false,
  });
}
