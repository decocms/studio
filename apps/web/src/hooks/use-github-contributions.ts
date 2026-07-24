import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import { fetchGithubInstallations } from "@/lib/github-installations";
import { KEYS } from "@/lib/query-keys";

export const CONTRIB_WEEKS = 26;
const CONTRIB_DAYS = 7;

export type ContribGrid = number[][];

interface RepoSummary {
  full_name: string;
  updated_at: string;
}

interface GitHubCommit {
  commit?: {
    committer?: { date?: string };
    author?: { date?: string };
  };
}

export function useGithubContributions(connectionId: string) {
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
    queryKey: KEYS.homeGithubContributions(org.id, connectionId),
    queryFn: async (): Promise<ContribGrid> => {
      const { installations } = await fetchGithubInstallations(
        (req) => self.callTool(req),
        connectionId,
      );
      const inst = installations[0];
      if (!inst) return emptyGrid();

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
      if (!top?.full_name) return emptyGrid();

      const [owner, repo] = top.full_name.split("/");
      const since = new Date(Date.now() - CONTRIB_WEEKS * 7 * 86400000);

      const commitsRes = await github.callTool({
        name: "list_commits",
        arguments: {
          owner,
          repo,
          since: since.toISOString(),
          perPage: 100,
        },
      });
      const commitsText = (commitsRes as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      const commits: GitHubCommit[] = commitsText
        ? (JSON.parse(commitsText) as GitHubCommit[])
        : [];

      const grid = emptyGrid();
      const now = Date.now();

      for (const c of commits) {
        const raw = c.commit?.committer?.date ?? c.commit?.author?.date ?? "";
        const date = new Date(raw);
        if (isNaN(date.getTime())) continue;
        const daysAgo = Math.floor((now - date.getTime()) / 86400000);
        if (daysAgo < 0 || daysAgo >= CONTRIB_WEEKS * 7) continue;
        const weekIdx = CONTRIB_WEEKS - 1 - Math.floor(daysAgo / 7);
        const dayIdx = date.getDay();
        const week = grid[weekIdx];
        if (week) week[dayIdx] = (week[dayIdx] ?? 0) + 1;
      }

      return grid;
    },
    staleTime: 300_000,
    retry: false,
  });
}

function emptyGrid(): ContribGrid {
  return Array.from({ length: CONTRIB_WEEKS }, () =>
    Array.from({ length: CONTRIB_DAYS }, () => 0),
  );
}
