import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  canRefresh,
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
  refreshAndStore,
} from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "../../storage/downstream-token";

const GITHUB_API = "https://api.github.com";
const MCP_GITHUB_APP_SLUG = "mcp-github";

export const GITHUB_LIST_USER_ORGS = defineTool({
  name: "GITHUB_LIST_USER_ORGS",
  description:
    "Return the GitHub App installation summary (account login + avatar) for the connected mcp-github installation. Output shape is preserved for backwards compatibility with the repo-picker UI.",
  annotations: {
    title: "List GitHub User Orgs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    connectionId: z.string().describe("ID of the mcp-github connection to use"),
  }),
  outputSchema: z.object({
    installations: z.array(
      z.object({
        installationId: z.number(),
        login: z.string(),
        avatarUrl: z.string(),
        type: z.string(),
      }),
    ),
    appSlug: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
    let token = await tokenStorage.get(input.connectionId);
    if (!token) {
      throw new Error(
        "No GitHub token found. Ensure the mcp-github connection is authenticated.",
      );
    }

    let accessToken = token.accessToken;

    if (
      canRefresh(token) &&
      tokenStorage.isExpired(token, PROACTIVE_REFRESH_BUFFER_MS)
    ) {
      const refreshed = await refreshAndStore(token, tokenStorage);
      if (!refreshed) {
        throw new Error(RECONNECT_ERROR);
      }
      accessToken = refreshed;
      token = (await tokenStorage.get(input.connectionId)) ?? token;
    }

    const fetchRepos = async (token: string) =>
      fetch(`${GITHUB_API}/installation/repositories?per_page=1`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

    let res = await fetchRepos(accessToken);

    if (res.status === 401) {
      // Reactive refresh: GitHub rejected the token (revoked, rotated, or
      // expired before our clock said so). Try one refresh + retry before
      // giving up.
      // Deletion of the cached row is delegated to `refreshAndStore`, which
      // only deletes on a definitive `400 invalid_grant`. Transient OAuth
      // failures leave the row intact so a later request can recover.
      const current = await tokenStorage.get(input.connectionId);
      if (!current || !canRefresh(current)) {
        throw new Error(RECONNECT_ERROR);
      }
      const refreshed = await refreshAndStore(current, tokenStorage);
      if (!refreshed) {
        throw new Error(RECONNECT_ERROR);
      }
      accessToken = refreshed;
      res = await fetchRepos(accessToken);
      if (res.status === 401) {
        throw new Error(RECONNECT_ERROR);
      }
    }

    if (!res.ok) {
      throw new Error(
        `GitHub /installation/repositories failed: ${res.status}`,
      );
    }

    const data = (await res.json()) as {
      repositories: Array<{
        owner: { login: string; avatar_url: string; type: string };
      }>;
      total_count: number;
    };

    const owner = data.repositories[0]?.owner;

    const installations = owner
      ? [
          {
            installationId: 0,
            login: owner.login,
            avatarUrl: owner.avatar_url,
            type: owner.type,
          },
        ]
      : [];

    return { installations, appSlug: MCP_GITHUB_APP_SLUG };
  },
});
