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
 * GitHub: user-to-server OAuth is used ONLY to prove which App installations
 * the user can see (`GET /user/installations`); one account row is upserted per
 * installation and the user token is then discarded. Everything afterwards is
 * minted from the App private key.
 *
 * GitLab: standard OAuth with a refreshable grant stored on the account.
 *
 * Every starter answers 503 when the deployment has no credentials for that
 * provider — the feature is dormant until configured.
 */

import { Hono } from "hono";
import { ContextFactory } from "@/core/context-factory";
import type { StudioContext } from "@/core/studio-context";
import { getPublicUrl } from "@/core/server-constants";
import { getGithubAppAuth } from "@/git-providers/github/app-auth";
import { readGithubAppConfig } from "@/git-providers/github/env";
import { readGitlabOAuthConfig } from "@/git-providers/gitlab/env";
import {
  exchangeGithubCode,
  githubAuthorizeUrl,
} from "@/git-providers/github/oauth";
import { gitlabCurrentUser } from "@/git-providers/gitlab/client";
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
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  return raw;
}

function callbackUrl(provider: "github" | "gitlab"): string {
  return `${getPublicUrl()}/api/_git/${provider}/callback`;
}

/** Where the browser lands after the flow, with an optional error code. */
function finish(returnTo: string, error?: string): string {
  const url = new URL(returnTo, getPublicUrl());
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

  /** Prove installation access via user OAuth, then record each installation. */
  app.get("/git-providers/github/connect", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth.user) return c.json({ error: "Unauthorized" }, 401);
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
    const installations = await appAuth.listUserInstallations(
      grant.accessToken,
    );
    for (const installation of installations) {
      await ctx.storage.gitProviderAccounts.upsert({
        organizationId: state.organizationId,
        type: "github",
        host: "github.com",
        authKind: "github_app",
        externalAccountId: String(installation.installationId),
        login: installation.login,
        avatarUrl: installation.avatarUrl,
        installationId: installation.installationId,
        createdBy: state.userId,
      });
    }
    return c.redirect(
      finish(
        returnTo,
        installations.length === 0 ? "no_installations" : undefined,
      ),
    );
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
 * we bounce straight into the OAuth proof, which records whatever
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
