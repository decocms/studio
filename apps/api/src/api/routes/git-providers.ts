/**
 * Git provider OAuth — Studio-owned connect flows.
 *
 * Two route groups:
 *
 * - Org-scoped starters, mounted under `/api/:org/git-providers/...` behind
 *   `resolveOrgFromPath` + session auth. They mint a single-use state bound to
 *   (org, user) and redirect the browser to the provider's authorize page.
 * - Instance-level callbacks under `/api/_git/...` — the provider redirects
 *   here with `code` + `state`; the state is what tells us which org and user
 *   started the flow. The session cookie rides along on the top-level redirect,
 *   and the callback insists the session user is the state's user.
 *
 * GitHub: user OAuth proves which repositories the user may delegate. The
 * user explicitly selects a workspace grant, including when they own the org.
 * The encrypted ten-minute user grant is deleted after selection; saved
 * accounts mint repository-restricted tokens using the App private key.
 *
 * GitLab and Bitbucket: standard OAuth with a refreshable grant stored on the
 * account.
 *
 * Every starter answers 503 when the deployment has no credentials for that
 * provider — the feature is dormant until configured.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ContextFactory } from "@/core/context-factory";
import type { StudioContext } from "@/core/studio-context";
import { getPublicUrl } from "@/core/server-constants";
import {
  getGithubAppAuth,
  MAX_TOKEN_REPOSITORIES,
} from "@/git-providers/github/app-auth";
import {
  GithubAccountChangedError,
  githubAccountVersion,
} from "@/storage/github-connect-flows";
import { readGithubAppConfig } from "@/git-providers/github/env";
import { readGitlabOAuthConfig } from "@/git-providers/gitlab/env";
import {
  exchangeGithubCode,
  githubAuthorizeUrl,
} from "@/git-providers/github/oauth";
import { gitlabCurrentUser } from "@/git-providers/gitlab/client";
import { readBitbucketOAuthConfig } from "@/git-providers/bitbucket/env";
import { bitbucketPrincipalForToken } from "@/git-providers/bitbucket/client";
import {
  bitbucketAuthorizeUrl,
  exchangeBitbucketCode,
} from "@/git-providers/bitbucket/oauth";
import {
  exchangeGitlabCode,
  gitlabAuthorizeUrl,
} from "@/git-providers/gitlab/oauth";
import type { GitProviderKind } from "@decocms/shared/git-providers";
import type { GitProviderOAuthState } from "@/storage/git-provider-oauth-states";
import type { Env } from "../hono-env";

/** Only a same-origin path is an acceptable post-flow destination. */
export function sanitizeReturnTo(raw: string | undefined | null): string {
  if (!raw) return "/";
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    /[\r\n\t]/.test(raw)
  ) {
    return "/";
  }
  return raw;
}

function callbackUrl(provider: GitProviderKind): string {
  return `${getPublicUrl()}/api/_git/${provider}/callback`;
}

/** Where the browser lands after the flow, with an optional error code. */
function finish(returnTo: string, error?: string): string {
  const url = new URL(returnTo, getPublicUrl());
  url.searchParams.delete("git_error");
  if (error) url.searchParams.set("git_error", error);
  return url.toString();
}

async function mintState(
  ctx: StudioContext,
  state: { provider: GitProviderKind; host: string; returnTo: string },
): Promise<string> {
  const organizationId = ctx.organization?.id;
  const userId = ctx.auth.user?.id;
  if (!organizationId || !userId) {
    throw new Error("Session with an organization is required");
  }
  return ctx.storage.gitProviderOAuthStates.create({
    organizationId,
    userId,
    ...state,
  });
}

// ── Org-scoped starters ─────────────────────────────────────────────────────

export const createGitProviderRoutes = () => {
  const app = new Hono<Env>();

  /** Prove installation access via user OAuth, then let the user choose one. */
  app.get("/git-providers/github/connect", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user) return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    const config = readGithubAppConfig();
    if (!config) {
      return c.json({ error: "GitHub App is not configured" }, 503);
    }
    const state = await mintState(ctx, {
      provider: "github",
      host: "github.com",
      returnTo: sanitizeReturnTo(c.req.query("returnTo")),
    });
    return c.redirect(
      githubAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: callbackUrl("github"),
        state,
        selectAccount: true,
      }),
    );
  });

  /**
   * Send the user to install the App on a new GitHub account. GitHub passes
   * `state` back to the App's setup URL (`/api/_git/github/setup`), which
   * continues into the OAuth proof above.
   */
  app.get("/git-providers/github/install", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user) return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    const config = readGithubAppConfig();
    if (!config) {
      return c.json({ error: "GitHub App is not configured" }, 503);
    }
    const state = await mintState(ctx, {
      provider: "github",
      host: "github.com",
      returnTo: sanitizeReturnTo(c.req.query("returnTo")),
    });
    const url = new URL(
      `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
    );
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/git-providers/github/flows/:id", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user || !ctx.organization)
      return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    c.header("Cache-Control", "no-store");
    const owner = {
      organizationId: ctx.organization.id,
      userId: ctx.auth.user.id,
    };
    const flow = await ctx.storage.githubConnectFlows.get(
      c.req.param("id"),
      owner,
    );
    if (!flow) return c.json({ error: "flow_expired" }, 410);
    const appAuth = getGithubAppAuth();
    if (!appAuth) return c.json({ error: "not_configured" }, 503);
    try {
      const { installations } = await appAuth.listAuthorizedInstallations(
        await ctx.vault.decrypt(flow.encrypted_access_token),
      );
      // The ids themselves are Studio's business; the chooser only needs to
      // say whether the account comes whole or as a slice of its repositories.
      return c.json({
        installations: installations.map(
          ({ repositoryIds, ...installation }) => ({
            ...installation,
            repositoryCount: repositoryIds?.length ?? null,
          }),
        ),
        expiresAt: flow.expires_at,
      });
    } catch {
      return c.json({ error: "github_unavailable" }, 502);
    }
  });

  app.get("/git-providers/github/flows/:id/repositories", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user || !ctx.organization)
      return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    c.header("Cache-Control", "no-store");
    const input = z
      .object({
        installationId: z.coerce.number().int().positive().safe(),
        page: z.coerce.number().int().positive().safe().default(1),
        query: z.string().trim().max(256).optional(),
      })
      .safeParse(c.req.query());
    if (!input.success) return c.json({ error: "Invalid installation" }, 400);
    const owner = {
      organizationId: ctx.organization.id,
      userId: ctx.auth.user.id,
    };
    const flow = await ctx.storage.githubConnectFlows.get(
      c.req.param("id"),
      owner,
    );
    if (!flow) return c.json({ error: "flow_expired" }, 410);
    const appAuth = getGithubAppAuth();
    if (!appAuth) return c.json({ error: "not_configured" }, 503);
    try {
      const userToken = await ctx.vault.decrypt(flow.encrypted_access_token);
      const access = await appAuth.listAuthorizedInstallations(
        userToken,
        input.data.installationId,
      );
      const installation = access.installations.find(
        (item) => item.installationId === input.data.installationId,
      );
      if (!installation)
        return c.json({ error: "installation_forbidden" }, 403);
      const choices = await appAuth.listRepositoryChoices(
        userToken,
        installation,
        input.data.page,
        input.data.query,
      );
      const account = await ctx.storage.gitProviderAccounts.findByExternalId({
        organizationId: owner.organizationId,
        host: "github.com",
        externalAccountId: String(installation.installationId),
      });
      return c.json({
        ...choices,
        accountVersion: githubAccountVersion(account),
      });
    } catch {
      return c.json({ error: "github_unavailable" }, 502);
    }
  });

  app.post("/git-providers/github/flows/:id", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user || !ctx.organization)
      return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    c.header("Cache-Control", "no-store");
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      return c.json({ error: "Invalid content type" }, 415);
    const input = z
      .object({
        installationId: z.number().int().positive().safe(),
        repositoryIds: z
          .array(z.number().int().positive().safe())
          .min(1)
          .max(MAX_TOKEN_REPOSITORIES)
          .refine((ids) => new Set(ids).size === ids.length),
        accountVersion: z.string().max(200).nullable(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Invalid installation" }, 400);
    const owner = {
      organizationId: ctx.organization.id,
      userId: ctx.auth.user.id,
    };
    const flow = await ctx.storage.githubConnectFlows.get(
      c.req.param("id"),
      owner,
    );
    if (!flow) return c.json({ error: "flow_expired" }, 410);
    const appAuth = getGithubAppAuth();
    if (!appAuth) return c.json({ error: "not_configured" }, 503);
    let access;
    try {
      access = await appAuth.listAuthorizedInstallations(
        await ctx.vault.decrypt(flow.encrypted_access_token),
        input.data.installationId,
      );
    } catch {
      return c.json({ error: "github_unavailable" }, 502);
    }
    const installation = access.installations.find(
      (item) => item.installationId === input.data.installationId,
    );
    if (!installation) return c.json({ error: "installation_forbidden" }, 403);
    try {
      const permitted = await appAuth.canAuthorizeRepositories(
        await ctx.vault.decrypt(flow.encrypted_access_token),
        installation,
        input.data.repositoryIds,
      );
      if (!permitted) return c.json({ error: "repositories_forbidden" }, 403);
    } catch {
      return c.json({ error: "github_unavailable" }, 502);
    }
    try {
      const account = await ctx.storage.githubConnectFlows.connect(
        c.req.param("id"),
        owner,
        {
          organizationId: owner.organizationId,
          type: "github",
          host: "github.com",
          authKind: "github_app",
          externalAccountId: String(installation.installationId),
          login: installation.login,
          avatarUrl: installation.avatarUrl,
          installationId: installation.installationId,
          installationAuthorizedBy: access.userId,
          installationRepositoryIds: input.data.repositoryIds,
        },
        input.data.accountVersion,
      );
      if (!account) return c.json({ error: "flow_expired" }, 410);
      return c.json({ account: { id: account.id, login: account.login } });
    } catch (error) {
      if (error instanceof GithubAccountChangedError)
        return c.json({ error: "account_changed" }, 409);
      throw error;
    }
  });

  app.delete("/git-providers/github/flows/:id", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user || !ctx.organization)
      return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    await ctx.storage.githubConnectFlows.cancel(c.req.param("id"), {
      organizationId: ctx.organization.id,
      userId: ctx.auth.user.id,
    });
    return c.body(null, 204);
  });

  app.get("/git-providers/github/accounts/:id/manage", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user || !ctx.organization)
      return c.json({ error: "Unauthorized" }, 401);
    await ctx.access.check("GIT_ACCOUNT_CONNECT_TOKEN");
    const account = await ctx.storage.gitProviderAccounts.get(
      c.req.param("id"),
      ctx.organization.id,
    );
    if (!account || account.type !== "github" || !account.installationId)
      return c.json({ error: "Account not found" }, 404);
    const appAuth = getGithubAppAuth();
    if (!appAuth) return c.json({ error: "not_configured" }, 503);
    const installation = await appAuth.getInstallation(account.installationId);
    if (!installation) return c.json({ error: "Installation not found" }, 404);
    const path =
      installation.accountType === "Organization"
        ? `/organizations/${encodeURIComponent(installation.login)}/settings/installations/${installation.installationId}`
        : `/settings/installations/${installation.installationId}`;
    return c.redirect(`https://github.com${path}`);
  });

  app.get("/git-providers/gitlab/connect", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user) return c.json({ error: "Unauthorized" }, 401);
    const config = readGitlabOAuthConfig();
    const host = (c.req.query("host") ?? config?.host ?? "gitlab.com")
      .trim()
      .toLowerCase();
    if (!config || config.host !== host) {
      return c.json(
        {
          error: `No GitLab OAuth application is configured for ${host}. Connect with an access token instead.`,
        },
        503,
      );
    }
    const state = await mintState(ctx, {
      provider: "gitlab",
      host,
      returnTo: sanitizeReturnTo(c.req.query("returnTo")),
    });
    return c.redirect(
      gitlabAuthorizeUrl({
        host,
        clientId: config.clientId,
        redirectUri: callbackUrl("gitlab"),
        state,
      }),
    );
  });

  /** Bitbucket Cloud: one host, so the query carries no `host`. */
  app.get("/git-providers/bitbucket/connect", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user) return c.json({ error: "Unauthorized" }, 401);
    const config = readBitbucketOAuthConfig();
    if (!config) {
      return c.json(
        {
          error:
            "No Bitbucket OAuth consumer is configured. Connect with an access token instead.",
        },
        503,
      );
    }
    const state = await mintState(ctx, {
      provider: "bitbucket",
      host: config.host,
      returnTo: sanitizeReturnTo(c.req.query("returnTo")),
    });
    return c.redirect(
      bitbucketAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: callbackUrl("bitbucket"),
        state,
      }),
    );
  });

  return app;
};

// ── Instance-level callbacks ────────────────────────────────────────────────

type ConsumedState =
  | { ok: true; state: GitProviderOAuthState; returnTo: string }
  | { ok: false; error: string; returnTo: string };

async function consumeState(
  ctx: StudioContext,
  provider: GitProviderKind,
  stateToken: string | undefined,
): Promise<ConsumedState> {
  if (!stateToken) return { ok: false, error: "missing_state", returnTo: "/" };
  const state = await ctx.storage.gitProviderOAuthStates.consume(stateToken);
  if (!state || state.provider !== provider) {
    return { ok: false, error: "invalid_state", returnTo: "/" };
  }
  // Re-sanitized on read: a redirect target is checked on both sides of storage.
  const returnTo = sanitizeReturnTo(state.returnTo);
  // The flow must be completed by the browser session that started it.
  if (ctx.auth.user?.id !== state.userId) {
    return { ok: false, error: "session_mismatch", returnTo };
  }
  return { ok: true, state, returnTo };
}

export const gitProviderCallbackRoutes = new Hono();

gitProviderCallbackRoutes.get("/github/callback", async (c) => {
  const ctx = await ContextFactory.create(c.req.raw);
  const consumed = await consumeState(ctx, "github", c.req.query("state"));
  if (!consumed.ok) {
    return c.redirect(finish(consumed.returnTo, consumed.error));
  }
  const { returnTo, state } = consumed;
  const config = readGithubAppConfig();
  const appAuth = getGithubAppAuth();
  const code = c.req.query("code");
  if (!config || !appAuth)
    return c.redirect(finish(returnTo, "not_configured"));
  if (!code) {
    return c.redirect(finish(returnTo, c.req.query("error") ?? "denied"));
  }
  try {
    const grant = await exchangeGithubCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: callbackUrl("github"),
    });
    const owner = {
      organizationId: state.organizationId,
      userId: state.userId,
    };
    const destination = new URL(returnTo, getPublicUrl());
    const previous = destination.searchParams.get("git_flow");
    const encryptedToken = await ctx.vault.encrypt(grant.accessToken);
    const flowId =
      previous &&
      (await ctx.storage.githubConnectFlows.refresh(
        previous,
        owner,
        encryptedToken,
      ))
        ? previous
        : await ctx.storage.githubConnectFlows.create(owner, encryptedToken);
    destination.searchParams.delete("git_error");
    destination.searchParams.set("git_flow", flowId);
    return c.redirect(destination.toString());
  } catch (error) {
    console.error("[git-providers] github callback failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(finish(returnTo, "exchange_failed"));
  }
});

/**
 * GitHub App "Setup URL": reached after the user installs/updates the App.
 * The installation id in the query is unauthenticated, so it is NOT trusted —
 * we bounce straight into the OAuth proof, which lists only
 * installations the user can actually see.
 */
gitProviderCallbackRoutes.get("/github/setup", async (c) => {
  const ctx = await ContextFactory.create(c.req.raw);
  const consumed = await consumeState(ctx, "github", c.req.query("state"));
  if (!consumed.ok) {
    return c.redirect(finish(consumed.returnTo, consumed.error));
  }
  const { returnTo, state } = consumed;
  const config = readGithubAppConfig();
  if (!config) return c.redirect(finish(returnTo, "not_configured"));
  const next = await ctx.storage.gitProviderOAuthStates.create(state);
  return c.redirect(
    githubAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: callbackUrl("github"),
      state: next,
    }),
  );
});

gitProviderCallbackRoutes.get("/gitlab/callback", async (c) => {
  const ctx = await ContextFactory.create(c.req.raw);
  const consumed = await consumeState(ctx, "gitlab", c.req.query("state"));
  if (!consumed.ok) {
    return c.redirect(finish(consumed.returnTo, consumed.error));
  }
  const { returnTo, state } = consumed;
  const { host } = state;
  const config = readGitlabOAuthConfig();
  const code = c.req.query("code");
  if (!config || config.host !== host) {
    return c.redirect(finish(returnTo, "not_configured"));
  }
  if (!code) {
    return c.redirect(finish(returnTo, c.req.query("error") ?? "denied"));
  }
  try {
    const grant = await exchangeGitlabCode({
      host,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: callbackUrl("gitlab"),
    });
    const principal = await gitlabCurrentUser(host, grant.accessToken);
    const account = await ctx.storage.gitProviderAccounts.upsert({
      organizationId: state.organizationId,
      type: "gitlab",
      host,
      authKind: "oauth",
      externalAccountId: principal.externalAccountId,
      login: principal.login,
      avatarUrl: principal.avatarUrl,
      createdBy: state.userId,
    });
    await ctx.storage.gitProviderAccountCredentials.upsert({
      connectionId: account.id,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      scope: grant.scope,
      expiresAt:
        grant.expiresIn !== null
          ? new Date(Date.now() + grant.expiresIn * 1000)
          : null,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenEndpoint: grant.tokenEndpoint,
    });
    return c.redirect(finish(returnTo));
  } catch (error) {
    console.error("[git-providers] gitlab callback failed", {
      host,
      message: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(finish(returnTo, "exchange_failed"));
  }
});

gitProviderCallbackRoutes.get("/bitbucket/callback", async (c) => {
  const ctx = await ContextFactory.create(c.req.raw);
  const consumed = await consumeState(ctx, "bitbucket", c.req.query("state"));
  if (!consumed.ok) {
    return c.redirect(finish(consumed.returnTo, consumed.error));
  }
  const { returnTo, state } = consumed;
  const { host } = state;
  const config = readBitbucketOAuthConfig();
  const code = c.req.query("code");
  if (!config || config.host !== host) {
    return c.redirect(finish(returnTo, "not_configured"));
  }
  if (!code) {
    return c.redirect(finish(returnTo, c.req.query("error") ?? "denied"));
  }
  try {
    const grant = await exchangeBitbucketCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: callbackUrl("bitbucket"),
    });
    const principal = await bitbucketPrincipalForToken(host, grant.accessToken);
    const account = await ctx.storage.gitProviderAccounts.upsert({
      organizationId: state.organizationId,
      type: "bitbucket",
      host,
      authKind: "oauth",
      externalAccountId: principal.externalAccountId,
      login: principal.login,
      avatarUrl: principal.avatarUrl,
      createdBy: state.userId,
    });
    await ctx.storage.gitProviderAccountCredentials.upsert({
      connectionId: account.id,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      scope: grant.scope,
      expiresAt:
        grant.expiresIn !== null
          ? new Date(Date.now() + grant.expiresIn * 1000)
          : null,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenEndpoint: grant.tokenEndpoint,
    });
    return c.redirect(finish(returnTo));
  } catch (error) {
    console.error("[git-providers] bitbucket callback failed", {
      host,
      message: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(finish(returnTo, "exchange_failed"));
  }
});
