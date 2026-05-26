/**
 * GitHub adapter, backed by the Decobot GitHub App.
 *
 * Responsibilities:
 *  - Build the App install URL (for the "Connect GitHub" flow).
 *  - Mint short-lived installation tokens from the App's RS256 private key,
 *    caching them via `InstallationTokenCache`.
 *  - Fetch installation metadata after a successful install callback.
 *  - Look up a Studio user's linked GitHub access token from Better Auth's
 *    `account` table (refreshing if expired).
 *  - Provide the "link your GitHub" URL for the Better Auth social link flow.
 */

import { sql } from "kysely";
import { getSettings } from "@/settings";
import type { MeshContext } from "@/core/mesh-context";
import type { GitProviderAdapter, GitProviderInfo } from "../../types";
import { buildAppJwt } from "./app-jwt";
import { InstallationTokenCache } from "./installation-token-cache";

interface DecobotConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  appSlug: string;
}

/** Returns config when *all five* Decobot env vars are set, else `null`. */
export function getDecobotConfig(): DecobotConfig | null {
  const s = getSettings();
  if (
    !s.decobotAppId ||
    !s.decobotPrivateKey ||
    !s.decobotClientId ||
    !s.decobotClientSecret ||
    !s.decobotAppSlug
  ) {
    return null;
  }
  return {
    appId: s.decobotAppId,
    privateKey: s.decobotPrivateKey,
    clientId: s.decobotClientId,
    clientSecret: s.decobotClientSecret,
    appSlug: s.decobotAppSlug,
  };
}

const GITHUB_INFO: Omit<GitProviderInfo, "available"> = {
  id: "github",
  name: "GitHub",
  description:
    "Native GitHub integration via the Decobot GitHub App. Agents call GitHub as the user that triggered them; unattended runs call as the bot.",
  logo: "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
};

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
}

interface InstallationResponse {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  repository_selection: "all" | "selected";
}

interface AccountRow {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | string | null;
  accountId: string | null; // GitHub user id (stringified)
}

/**
 * Decobot adapter instance. The token cache is held on the singleton so that
 * a token minted by one tool call is reused by the next — even across
 * separate MeshContexts within the same process.
 */
class GitHubAdapter implements GitProviderAdapter {
  private tokenCache = new InstallationTokenCache();

  get info(): GitProviderInfo {
    return { ...GITHUB_INFO, available: getDecobotConfig() !== null };
  }

  buildInstallUrl(params: { state: string; baseUrl: string }): string {
    const cfg = this.requireConfig();
    // GitHub doesn't echo a `state` query param through the install redirect
    // in every flow (it does for newer apps but it's not guaranteed). To make
    // the callback robust we also stash `state` in `redirect_uri` query so
    // GitHub appends it verbatim to the callback. The callback page handles
    // both — querystring takes priority, falls back to GitHub's own `state`.
    const url = new URL(
      `https://github.com/apps/${cfg.appSlug}/installations/new`,
    );
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  buildUserLinkUrl(params: { baseUrl: string; redirectTo?: string }): string {
    // Better Auth's "link social" endpoint. Calling /api/auth/sign-in/social
    // with provider=github lets the same OAuth handshake double as account
    // linking when the session is already authenticated.
    const url = new URL("/api/auth/sign-in/social", params.baseUrl);
    url.searchParams.set("provider", "github");
    if (params.redirectTo) {
      url.searchParams.set("callbackURL", params.redirectTo);
    }
    return url.toString();
  }

  async fetchInstallation(installationId: string): Promise<{
    installationId: string;
    accountLogin: string;
    accountId: string;
    accountType: "Organization" | "User";
    repositorySelection: "all" | "selected";
  }> {
    const cfg = this.requireConfig();
    const appJwt = buildAppJwt({
      appId: cfg.appId,
      privateKeyPem: cfg.privateKey,
    });
    const res = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
      {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "DecoStudio-Decobot",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `GitHub /app/installations/${installationId} → ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    const data = (await res.json()) as InstallationResponse;
    return {
      installationId: String(data.id),
      accountLogin: data.account.login,
      accountId: String(data.account.id),
      accountType: data.account.type,
      repositorySelection: data.repository_selection,
    };
  }

  async getInstallationToken(installationId: string): Promise<string> {
    const cfg = this.requireConfig();
    return this.tokenCache.get(installationId, async () => {
      const appJwt = buildAppJwt({
        appId: cfg.appId,
        privateKeyPem: cfg.privateKey,
      });
      const res = await fetch(
        `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "DecoStudio-Decobot",
          },
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `GitHub /app/installations/${installationId}/access_tokens → ${res.status}: ${body.slice(0, 500)}`,
        );
      }
      const data = (await res.json()) as InstallationTokenResponse;
      return {
        token: data.token,
        expiresAtMs: new Date(data.expires_at).getTime(),
      };
    });
  }

  async getUserAccessToken(
    ctx: MeshContext,
    userId: string,
  ): Promise<{ token: string; login?: string } | undefined> {
    // Better Auth's `account` table lives outside our Kysely Database type
    // (Better Auth manages its own schema). We hit it with raw SQL — same
    // pattern as `apps/mesh/src/auth/sso.ts`.
    const row = await sql<AccountRow>`
      SELECT "accessToken", "refreshToken", "accessTokenExpiresAt", "accountId"
      FROM "account"
      WHERE "userId" = ${userId} AND "providerId" = 'github'
      ORDER BY "accessTokenExpiresAt" DESC NULLS LAST
      LIMIT 1
    `
      .execute(ctx.db)
      .then((r) => r.rows[0]);

    if (!row?.accessToken) return undefined;

    // Refresh if expired and we have a refresh token. GitHub Apps with
    // "Expire user authorization tokens" enabled return refresh tokens that
    // are valid for 6 months. If refresh fails we return undefined so the
    // caller can prompt the user to relink.
    const expiresAt =
      row.accessTokenExpiresAt instanceof Date
        ? row.accessTokenExpiresAt
        : row.accessTokenExpiresAt
          ? new Date(row.accessTokenExpiresAt)
          : null;

    const isExpired =
      expiresAt !== null && expiresAt.getTime() - 60_000 < Date.now();

    if (!isExpired) {
      return {
        token: row.accessToken,
        login: row.accountId ?? undefined,
      };
    }

    if (!row.refreshToken) {
      // Token expired and we have nothing to refresh with — treat as unlinked.
      return undefined;
    }

    const refreshed = await this.refreshUserToken(row.refreshToken);
    if (!refreshed) return undefined;

    // Persist the rotated tokens. Better Auth will see the new accessToken on
    // the next read. We update by userId+providerId — there should only be
    // one github account per user.
    const newExpiresAt = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000)
      : null;
    const newRefreshExpiresAt = refreshed.refreshTokenExpiresIn
      ? new Date(Date.now() + refreshed.refreshTokenExpiresIn * 1000)
      : null;
    await sql`
      UPDATE "account"
      SET "accessToken" = ${refreshed.accessToken},
          "refreshToken" = ${refreshed.refreshToken ?? row.refreshToken},
          "accessTokenExpiresAt" = ${newExpiresAt},
          "refreshTokenExpiresAt" = COALESCE(${newRefreshExpiresAt}, "refreshTokenExpiresAt"),
          "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "providerId" = 'github'
    `.execute(ctx.db);

    return {
      token: refreshed.accessToken,
      login: row.accountId ?? undefined,
    };
  }

  private async refreshUserToken(refreshToken: string): Promise<
    | {
        accessToken: string;
        refreshToken?: string;
        expiresIn?: number;
        refreshTokenExpiresIn?: number;
      }
    | undefined
  > {
    const cfg = this.requireConfig();
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      error?: string;
    };
    if (!data.access_token || data.error) return undefined;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      refreshTokenExpiresIn: data.refresh_token_expires_in,
    };
  }

  private requireConfig(): DecobotConfig {
    const cfg = getDecobotConfig();
    if (!cfg) {
      throw new Error(
        "GitHub Git Provider is not configured. Set DECOBOT_APP_ID, DECOBOT_PRIVATE_KEY, DECOBOT_CLIENT_ID, DECOBOT_CLIENT_SECRET, and DECOBOT_APP_SLUG.",
      );
    }
    return cfg;
  }

  /** App slug — exposed so the user-link flow knows the bot's display name. */
  getAppSlug(): string | null {
    const cfg = getDecobotConfig();
    return cfg?.appSlug ?? null;
  }
}

export const githubAdapter = new GitHubAdapter();
