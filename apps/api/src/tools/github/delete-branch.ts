import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";
import { resolveGithubConnection } from "./graphql";

/** e2e seam: set GITHUB_API_BASE_URL to a local stub (mirrors github-git-data). */
function githubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
}

const GITHUB_TIMEOUT_MS = 15_000;

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "studio-github",
  };
}

/** Encode a branch ref segment-by-segment so `feat/x` stays a path, not `%2F`. */
function encodeRef(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/**
 * Delete a repository branch (git ref). App-only, connection-scoped. Refuses to
 * delete the repository's default branch — that is production ("Produção"), the
 * live version people branch off, never a discardable draft. A missing ref is
 * treated as already-deleted so the tool is idempotent.
 */
export const GITHUB_DELETE_BRANCH = defineTool({
  name: "GITHUB_DELETE_BRANCH",
  description:
    "Delete a branch (git ref) from a repository. Refuses to delete the repository's default (production) branch.",
  annotations: {
    title: "Delete GitHub Branch",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    connectionId: z.string().describe("ID of the mcp-github connection to use"),
    owner: z.string().describe("Repository owner (user or org login)"),
    repo: z.string().describe("Repository name"),
    branch: z
      .string()
      .describe("Branch name to delete (no `refs/heads/` prefix)"),
  }),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const branch = input.branch.trim();
    if (!branch) {
      throw new Error("Branch name is required");
    }

    const connection = await resolveGithubConnection(ctx, input.connectionId);
    const token = await githubConnectionAccessToken(ctx, connection);
    if (!token) {
      throw new Error(RECONNECT_ERROR);
    }

    const repoLabel = `${input.owner}/${input.repo}`;
    const base = githubApiBaseUrl();

    // Never delete the live/default branch — read it fresh, don't trust input.
    const repoRes = await fetch(`${base}/repos/${input.owner}/${input.repo}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!repoRes.ok) {
      throw new Error(`Couldn't read ${repoLabel} (${repoRes.status})`);
    }
    const repoJson = (await repoRes.json()) as { default_branch?: string };
    if (repoJson.default_branch === branch) {
      throw new Error(
        `Refusing to delete the production branch "${branch}" of ${repoLabel}`,
      );
    }

    const delRes = await fetch(
      `${base}/repos/${input.owner}/${input.repo}/git/refs/heads/${encodeRef(branch)}`,
      {
        method: "DELETE",
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
    // 204 = deleted; 422/404 = ref already gone — idempotent success.
    if (
      delRes.status !== 204 &&
      delRes.status !== 422 &&
      delRes.status !== 404
    ) {
      const text = await delRes.text().catch(() => "");
      throw new Error(
        `Failed to delete branch "${branch}": ${delRes.status} ${text.slice(0, 200)}`,
      );
    }

    return { deleted: true };
  },
});
