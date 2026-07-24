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
  GHS_TOKEN_LIFETIME_MS,
  PROACTIVE_REFRESH_BUFFER_MS,
  RECONNECT_ERROR,
} from "@/oauth/token-refresh";
import {
  getRepoScope,
  isChecksPermissionRejected,
  permissionsWithoutChecks,
  type RepoScopeRecipe,
} from "@decocms/shared/github-repo-scope";
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
  if (!recipe.sourceConnectionId) {
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
    type MintResult = {
      isError?: boolean;
      structuredContent?: { token?: string; expiresAt?: string };
      content?: Array<{ type?: string; text?: string }>;
    };
    const mintWith = (permissions: Record<string, string>) =>
      client.callTool({
        name: "MINT_REPO_TOKEN",
        arguments: {
          installationId: recipe.installationId,
          owner: recipe.owner,
          repo: recipe.repo,
          permissions,
        },
      }) as Promise<MintResult>;

    // Self-heal legacy connections on their ~1h re-mint: always request
    // checks:read (even if the stored recipe predates it) so the token gains
    // check-run access without a re-install. Fall back to the checks-less recipe
    // when checks isn't available yet (github-mcp allowlist skew, or the
    // installation hasn't granted Checks → 422).
    const desiredPermissions = { ...recipe.permissions, checks: "read" };
    let res = await mintWith(desiredPermissions);
    if (
      res.isError &&
      isChecksPermissionRejected(
        res.content?.find((c) => c.type === "text")?.text,
      )
    ) {
      res = await mintWith(permissionsWithoutChecks(recipe.permissions));
    }

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

/**
 * Resolve the expiry date to persist for a freshly minted ghs_ token.
 *
 * Rules:
 * - Use the server-provided expiry only when it is strictly after `mintStartedAt`
 *   (guards against clock-skewed or already-past values from the upstream).
 * - Otherwise fall back to `mintStartedAt + GHS_TOKEN_LIFETIME_MS` so the token
 *   is never stored with a null or past expiry (which would loop or "never expire").
 *
 * Exported for unit testing; not part of the module's public API.
 */
export function resolveGhsExpiry(
  mintedExpiresAt: Date | null,
  mintStartedAt: number,
): Date {
  const providedExpiry = mintedExpiresAt?.getTime() ?? 0;
  return providedExpiry > mintStartedAt
    ? mintedExpiresAt!
    : new Date(mintStartedAt + GHS_TOKEN_LIFETIME_MS);
}

async function mintAndStore(
  ctx: StudioContext,
  connectionId: string,
  recipe: RepoScopeRecipe,
  tokenStorage: DownstreamTokenStorage,
): Promise<string> {
  // Anchor the clock before the async RPC so latency doesn't inflate the stored expiry.
  const mintStartedAt = Date.now();
  const minted = await mintRepoToken(ctx, recipe);
  const expiresAt = resolveGhsExpiry(minted.expiresAt, mintStartedAt);
  await tokenStorage.upsert({
    connectionId,
    accessToken: minted.accessToken,
    refreshToken: null,
    scope: null,
    expiresAt,
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
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  const recipe = getRepoScope(connection);
  if (!recipe) {
    throw new Error("Connection is not repo-scoped");
  }
  if (!recipe.sourceConnectionId) {
    throw new Error(RECONNECT_ERROR);
  }

  const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
  const cached = await tokenStorage.get(connection.id);
  if (
    !opts?.forceRefresh &&
    cached &&
    !tokenStorage.isExpired(cached, PROACTIVE_REFRESH_BUFFER_MS)
  ) {
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
