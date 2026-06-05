/**
 * Repo-scoped GitHub token minting — storage-aware helpers.
 *
 * Minted GitHub App installation tokens are short-lived (~1h) and have NO
 * refresh token, so instead of refreshing we RE-MINT on demand by calling the
 * deco/mcp-github `MINT_REPO_TOKEN` tool through the ORG connection (the broad
 * user-to-server OAuth connection — a scoped ghs_ token cannot pass the mint
 * gate). The mint "recipe" (which org connection, installation, repo,
 * permissions) lives on the child connection's metadata; see github-repo-scope.
 *
 * Sibling to token-refresh.ts; reuses PROACTIVE_REFRESH_BUFFER_MS / RECONNECT_ERROR.
 */

import type { StudioContext } from "@/core/studio-context";
import {
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
} from "@/oauth/token-refresh";
import { getRepoScope, type RepoScopeRecipe } from "@/shared/github-repo-scope";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import type { ConnectionEntity } from "@/tools/connection/schema";

interface MintedToken {
  accessToken: string;
  expiresAt: Date | null;
}

/**
 * Mint a fresh repo-scoped token by calling MINT_REPO_TOKEN through the org
 * connection named in the recipe. Validates org ownership of the source
 * connection. Always closes the temporary client.
 *
 * NOTE: clientFromConnection is dynamically imported to avoid a static import
 * cycle (headers.ts → github-mint.ts → client.ts → outbound → headers.ts).
 *
 * Module-internal: the only public entry point is ensureRepoScopedToken.
 */
async function mintRepoToken(
  ctx: StudioContext,
  recipe: RepoScopeRecipe,
): Promise<MintedToken> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    // No org scope → refuse to mint rather than fall back to an unscoped lookup.
    throw new Error(RECONNECT_ERROR);
  }
  const orgConn = await ctx.storage.connections.findById(
    recipe.sourceConnectionId,
    organizationId,
  );
  if (!orgConn) {
    // Source connection gone or not in this org → cannot mint.
    throw new Error(RECONNECT_ERROR);
  }

  const { clientFromConnection } = await import("@/mcp-clients/client");
  // superUser: runs in background contexts (token expiry mid-run, SANDBOX_START)
  // where ctx.auth.user may be absent; the org connection's broad OAuth token is
  // injected as the bearer either way (the gate needs the user-to-server token).
  const client = await clientFromConnection(orgConn, ctx, true);
  try {
    const res = (await client.callTool({
      name: "MINT_REPO_TOKEN",
      arguments: {
        installationId: recipe.installationId,
        owner: recipe.owner,
        repo: recipe.repo,
        permissions: recipe.permissions,
      },
    })) as {
      isError?: boolean;
      structuredContent?: { token?: string; expiresAt?: string };
    };

    const token = res.structuredContent?.token;
    if (res.isError || !token) {
      throw new Error(RECONNECT_ERROR);
    }
    const expiresAtRaw = res.structuredContent?.expiresAt;
    return {
      accessToken: token,
      expiresAt: expiresAtRaw ? new Date(expiresAtRaw) : null,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// Single-flight: collapse concurrent mints for the same connection so a burst of
// tool calls near expiry triggers exactly one MINT_REPO_TOKEN call (which is
// rate-limit-expensive on the caller's GitHub budget).
const inflight = new Map<string, Promise<string>>();

async function mintAndStore(
  ctx: StudioContext,
  connectionId: string,
  recipe: RepoScopeRecipe,
  tokenStorage: DownstreamTokenStorage,
): Promise<string> {
  const minted = await mintRepoToken(ctx, recipe);
  await tokenStorage.upsert({
    connectionId,
    accessToken: minted.accessToken,
    refreshToken: null,
    scope: null,
    expiresAt: minted.expiresAt,
    clientId: null,
    clientSecret: null,
    tokenEndpoint: null,
  });
  return minted.accessToken;
}

/**
 * Return a valid repo-scoped access token for a per-agent child connection,
 * minting (and caching in downstream_tokens) only when the cached token is
 * missing or within the proactive-refresh buffer. Throws if `connection` is not
 * repo-scoped or minting fails.
 */
export async function ensureRepoScopedToken(
  ctx: StudioContext,
  connection: ConnectionEntity,
): Promise<string> {
  const recipe = getRepoScope(connection);
  if (!recipe) {
    throw new Error("Connection is not repo-scoped");
  }

  const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
  const cached = await tokenStorage.get(connection.id);
  if (cached && !tokenStorage.isExpired(cached, PROACTIVE_REFRESH_BUFFER_MS)) {
    return cached.accessToken;
  }

  const existing = inflight.get(connection.id);
  if (existing) return existing;

  const p = mintAndStore(ctx, connection.id, recipe, tokenStorage).finally(
    () => {
      inflight.delete(connection.id);
    },
  );
  inflight.set(connection.id, p);
  return p;
}
