/**
 * Shared repo resolution for the home GitHub tiles. Every GitHub-backed tile
 * needs the same prelude: resolve the connection's installation
 * (GITHUB_LIST_USER_ORGS) → list its repos (search_repositories) → keep the
 * few most recently updated ones. There is no org-wide "everything" tool on
 * github-mcp-server, so the tiles fan out over these repos.
 */

import { fetchGithubInstallations } from "@/lib/github-installations";

export interface McpCallTool {
  (req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export interface TopRepo {
  fullName: string;
  owner: string;
  repo: string;
}

interface RepoSummary {
  full_name?: string;
  updated_at?: string;
}

/** Reads the first text content block of an MCP result as JSON. */
export function readToolJson<T>(result: unknown): T | undefined {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]
    ?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** github-mcp-server list tools return either a bare array or `{ items }`. */
export function readToolList<T>(result: unknown): T[] {
  const parsed = readToolJson<T[] | { items?: T[] }>(result);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  return parsed.items ?? [];
}

export async function fetchTopGithubRepos(
  selfCallTool: McpCallTool,
  githubCallTool: McpCallTool,
  connectionId: string,
  max: number,
): Promise<TopRepo[]> {
  const { installations } = await fetchGithubInstallations(
    selfCallTool,
    connectionId,
  );
  const inst = installations[0];
  if (!inst) return [];

  const qualifier = inst.type === "User" ? "user" : "org";
  const reposRes = await githubCallTool({
    name: "search_repositories",
    arguments: { query: `${qualifier}:${inst.login}`, page: 1, perPage: 30 },
  });
  const repos = readToolList<RepoSummary>(reposRes);

  return [...repos]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .flatMap((r) => {
      const [owner, repo] = (r.full_name ?? "").split("/");
      if (!owner || !repo) return [];
      return [{ fullName: `${owner}/${repo}`, owner, repo }];
    })
    .slice(0, max);
}
