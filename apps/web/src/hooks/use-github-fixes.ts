/**
 * "Fixes to do" — the open work items in the org's GitHub code that someone
 * still has to fix: open issues (bug/fix-flavoured ones first) plus open pull
 * requests that are still waiting for review. Built on the same proven-wired
 * github-mcp-server tools the other home tiles use (search_repositories →
 * list_issues / list_pull_requests) across the few busiest repos.
 */

import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient, useProjectContext } from "@/sdk";
import {
  fetchTopGithubRepos,
  readToolList,
  type TopRepo,
} from "@/lib/github-top-repos";
import { KEYS } from "@/lib/query-keys";

const MAX_REPOS = 3;
const PER_REPO = 10;
/** Cap what the tile renders; the counts above stay honest totals. */
export const MAX_FIXES_SHOWN = 8;

export type FixKind = "bug" | "issue" | "review";

export interface GithubFix {
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  kind: FixKind;
  /** ISO timestamp of the last update, for "3d ago". */
  updatedAt: string;
}

export interface GithubFixes {
  fixes: GithubFix[];
  bugs: number;
  issues: number;
  reviews: number;
}

interface IssueLike {
  number?: number;
  title?: string;
  html_url?: string;
  updated_at?: string;
  draft?: boolean;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
}

const BUG_LABEL = /bug|fix|defect|regression|broken|error|crash/i;

function labelNames(issue: IssueLike): string[] {
  return (issue.labels ?? []).map((l) =>
    typeof l === "string" ? l : (l.name ?? ""),
  );
}

function isBug(issue: IssueLike): boolean {
  return (
    labelNames(issue).some((n) => BUG_LABEL.test(n)) ||
    BUG_LABEL.test(issue.title ?? "")
  );
}

/** Bugs first, then plain issues, then reviews; newest-updated within a kind. */
const KIND_RANK: Record<FixKind, number> = { bug: 0, issue: 1, review: 2 };

export function useGithubFixes(connectionId: string) {
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
    queryKey: KEYS.homeGithubFixes(org.id, connectionId),
    queryFn: async (): Promise<GithubFixes> => {
      const repos = await fetchTopGithubRepos(
        (req) => self.callTool(req),
        (req) => github.callTool(req),
        connectionId,
        MAX_REPOS,
      );
      if (repos.length === 0) {
        return { fixes: [], bugs: 0, issues: 0, reviews: 0 };
      }

      const perRepo = await Promise.all(
        repos.map((r) =>
          fixesForRepo(r, (req) => github.callTool(req)).catch(
            (): GithubFix[] => [],
          ),
        ),
      );
      const fixes = perRepo.flat().sort((a, b) => {
        const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
        if (byKind !== 0) return byKind;
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      });

      return {
        fixes,
        bugs: fixes.filter((f) => f.kind === "bug").length,
        issues: fixes.filter((f) => f.kind === "issue").length,
        reviews: fixes.filter((f) => f.kind === "review").length,
      };
    },
    staleTime: 60_000,
    retry: false,
  });
}

async function fixesForRepo(
  { owner, repo, fullName }: TopRepo,
  callTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
): Promise<GithubFix[]> {
  const [issuesRes, prsRes] = await Promise.all([
    callTool({
      name: "list_issues",
      arguments: { owner, repo, state: "open", perPage: PER_REPO },
    }).catch(() => undefined),
    callTool({
      name: "list_pull_requests",
      arguments: { owner, repo, state: "open", perPage: PER_REPO },
    }).catch(() => undefined),
  ]);

  const issues = readToolList<IssueLike>(issuesRes)
    // GitHub's issues endpoint includes PRs; those are counted as reviews below.
    .filter((i) => !i.pull_request && (i.number ?? 0) > 0)
    .map<GithubFix>((i) => ({
      repo: fullName,
      number: i.number ?? 0,
      title: i.title ?? "",
      htmlUrl: i.html_url ?? "",
      kind: isBug(i) ? "bug" : "issue",
      updatedAt: i.updated_at ?? "",
    }));

  const reviews = readToolList<IssueLike>(prsRes)
    .filter((p) => (p.number ?? 0) > 0 && !p.draft)
    .map<GithubFix>((p) => ({
      repo: fullName,
      number: p.number ?? 0,
      title: p.title ?? "",
      htmlUrl: p.html_url ?? "",
      kind: "review",
      updatedAt: p.updated_at ?? "",
    }));

  return [...issues, ...reviews];
}
