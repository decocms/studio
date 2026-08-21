import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  canRefresh,
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
  refreshAndStore,
} from "@/oauth/token-refresh";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import { DownstreamTokenStorage } from "../../storage/downstream-token";

const GITHUB_API = "https://api.github.com";
/** Matches the Git Data client's per-attempt timeout in `decofile/github-git-data.ts`. */
const GITHUB_TIMEOUT_MS = 15_000;

interface InstallationsPage {
  installations: Array<{
    id: number;
    account: { login: string; avatar_url: string; type: string };
  }>;
  total_count: number;
}

/**
 * A 2xx response body isn't guaranteed to be JSON (a proxy/outage page can
 * still answer 200) — `res.json()` throwing a raw `SyntaxError` on that would
 * surface as an opaque "Unexpected token" instead of naming what failed.
 * Mirrors `parseGraphqlBody` in `graphql.ts`.
 */
export function parseInstallationsBody(text: string): InstallationsPage {
  try {
    return JSON.parse(text) as InstallationsPage;
  } catch (cause) {
    throw new Error(
      `GitHub /user/installations returned invalid JSON: ${text.slice(0, 300)}`,
      { cause },
    );
  }
}

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
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    // Connection-ownership guard: confirm the named connection belongs to the
    // caller's org before reading its token. Mirrors the guard in
    // POST /connections/:id/oauth-token. Without this, any member could read
    // another org's GitHub token by passing its connectionId.
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }
    const connection = await ctx.storage.connections.findById(
      input.connectionId,
      organizationId,
    );
    if (!connection) {
      throw new Error("Connection not found");
    }
    if (getRepoScope(connection)) {
      throw new Error(
        "Repo-scoped connections cannot list installations — use an org-level mcp-github connection",
      );
    }

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
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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

      const data = parseInstallationsBody(await res.text());

      for (const inst of data.installations) {
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

    return { installations };
  },
});
