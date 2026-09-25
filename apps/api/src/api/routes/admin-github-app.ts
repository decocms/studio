/**
 * One-click GitHub App setup for the deployment admin dashboard.
 *
 * Mounted inside `createAdminRoutes`, so every route here is already behind
 * the deployment-admin fence. The POST needs a signed-in admin (the shared
 * admin token only reaches GETs): the signed state names the user who must
 * finish the flow in `gitProviderCallbackRoutes`' manifest callback.
 */

import { Hono } from "hono";
import type { Env } from "@/api/hono-env";
import { getPublicUrl } from "@/core/server-constants";
import {
  buildGithubAppManifest,
  defaultGithubAppName,
  deleteStoredGithubAppConfig,
  githubAppConfigSource,
  githubAppRegistrationStatus,
  githubManifestFormAction,
  isValidGithubLogin,
  signManifestState,
} from "@/git-providers";
import { getSettings } from "@/settings";

export function createAdminGithubAppRoutes(): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/github-app", async (c) => {
    return c.json({
      ...(await githubAppRegistrationStatus()),
      defaultName: defaultGithubAppName(getPublicUrl()),
      publicUrl: getPublicUrl(),
    });
  });

  app.post("/github-app/manifest", async (c) => {
    const user = c.get("studioContext").auth.user;
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (githubAppConfigSource() === "env") {
      return c.json(
        {
          error:
            "This deployment's GitHub App is set by GITHUB_APP_* environment " +
            "variables, which take precedence. Remove them to register one here.",
        },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      organization?: unknown;
      name?: unknown;
      public?: unknown;
    };
    const organization =
      typeof body.organization === "string" ? body.organization.trim() : "";
    if (organization && !isValidGithubLogin(organization)) {
      return c.json({ error: "Invalid GitHub organization name" }, 400);
    }
    const name = typeof body.name === "string" ? body.name : undefined;
    const manifest = buildGithubAppManifest({
      publicUrl: getPublicUrl(),
      name,
      public: body.public === true,
    });
    const state = signManifestState(user.id, getSettings().encryptionKey);
    return c.json({
      action: githubManifestFormAction(state, organization || undefined),
      manifest: JSON.stringify(manifest),
    });
  });

  // Session-only like the POST: the shared admin token reaches GETs alone.
  app.delete("/github-app", async (c) => {
    await deleteStoredGithubAppConfig();
    return c.json({ ok: true });
  });

  return app;
}
