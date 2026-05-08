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

export const GITHUB_LIST_USER_ORGS = defineTool({
  name: "GITHUB_LIST_USER_ORGS",
  description:
    "List GitHub App installations (orgs/accounts) accessible to the authenticated user.",
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

    // Proactive refresh: if the cached token is (about to be) expired and we
    // have refresh credentials, swap it for a fresh one before hitting GitHub.
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

    const installations: Array<{
      installationId: number;
      login: string;
      avatarUrl: string;
      type: string;
    }> = [];

    let appSlug: string | undefined;
    let page = 1;
    const perPage = 100;

    const fetchPage = async (token: string) =>
      fetch(
        `${GITHUB_API}/user/installations?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

    while (true) {
      let res = await fetchPage(accessToken);

      // Reactive refresh: GitHub rejected the token (revoked, rotated, or
      // expired before our clock said so). Try one refresh + retry before
      // giving up. Applies to any page — a token can be invalidated
      // between pages of a long installations listing.
      // Deletion of the cached row is delegated to `refreshAndStore`, which
      // only deletes on a definitive `400 invalid_grant`. Transient OAuth
      // failures leave the row intact so a later request can recover.
      if (res.status === 401) {
        const current = await tokenStorage.get(input.connectionId);
        if (!current || !canRefresh(current)) {
          throw new Error(RECONNECT_ERROR);
        }
        const refreshed = await refreshAndStore(current, tokenStorage);
        if (!refreshed) {
          throw new Error(RECONNECT_ERROR);
        }
        accessToken = refreshed;
        res = await fetchPage(accessToken);
        if (res.status === 401) {
          throw new Error(RECONNECT_ERROR);
        }
      }

      if (!res.ok) {
        throw new Error(`GitHub /user/installations failed: ${res.status}`);
      }

      const data = (await res.json()) as {
        installations: Array<{
          id: number;
          account: { login: string; avatar_url: string; type: string };
          app_slug?: string;
          app?: { slug?: string };
        }>;
        total_count: number;
      };

      for (const inst of data.installations) {
        if (!appSlug) {
          appSlug = inst.app_slug ?? inst.app?.slug;
        }
        installations.push({
          installationId: inst.id,
          login: inst.account.login,
          avatarUrl: inst.account.avatar_url,
          type: inst.account.type,
        });
      }

      if (data.installations.length < perPage) break;
      page++;
    }

    return { installations, ...(appSlug ? { appSlug } : {}) };
  },
});
