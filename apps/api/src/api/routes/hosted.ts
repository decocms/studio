/**
 * The hosted Deco CMS screens of a Blocks v8 project (session, org flag):
 *
 *   GET    /api/:org/hosted/:virtualMcpId/releases?cursor=   Releases screen
 *   POST   /api/:org/hosted/:virtualMcpId/releases/current   Make current { sha, confirm? }
 *   POST   /api/:org/hosted/:virtualMcpId/resync             Resync { confirm? }
 *   GET    /api/:org/hosted/:virtualMcpId/site-tokens        list
 *   POST   /api/:org/hosted/:virtualMcpId/site-tokens        issue (shown once)
 *   DELETE /api/:org/hosted/:virtualMcpId/site-tokens/:kid   revoke
 *
 * Publish lives with the draft it publishes (`decofile.ts`). These are
 * Studio-internal routes; nothing outside Studio calls them.
 */

// OPEN: O-S4 — Releases, Make current and Resync have no existing route to
// reuse, so they are these Studio-internal routes (with site tokens beside them).

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { orgHasFeature } from "@/core/plan-feature-gate";
import {
  contentClientForProjectRepo,
  insightsClientForProjectRepo,
  repoErrorStatus,
  type RepoContentClient,
} from "@/git-providers";
import { deliveryStore } from "@/hosted/delivery-store";
import { denylist } from "@/hosted/denylist";
import { type HostedRepo, RolledBackError, resync } from "@/hosted/publish";
import { NotV8Site } from "@/hosted/release-objects";
import {
  listReleases,
  makeCurrent,
  NotPublishedError,
  SchemaMismatchError,
} from "@/hosted/releases";
import { projectSite } from "@/hosted/scope";
import {
  createSiteTokens,
  importSigningKey,
  SiteTokenNotFoundError,
  TooManySiteTokensError,
} from "@/hosted/site-token";
import { getSettings } from "@/settings";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import type { Env } from "../hono-env";

interface HostedProject {
  organizationId: string;
  virtualMcpId: string;
  site: string;
  packagePath: string | null;
  repository: RepositoryBinding;
}

type HostedEnv = Env & {
  Variables: Env["Variables"] & { hostedProject: HostedProject };
};

const resolveHostedProject = createMiddleware<HostedEnv>(async (c, next) => {
  const ctx = c.var.studioContext;
  const organization = ctx.organization;
  if (!organization) {
    return c.json({ error: "Organization scope required" }, 500);
  }
  if (!ctx.auth?.user?.id) return c.json({ error: "Unauthorized" }, 401);
  if (!(await orgHasFeature(ctx, organization.id, "cms"))) {
    return c.json(
      {
        error: "This organization's plan does not include the CMS",
        code: "feature_not_in_plan",
      },
      403,
    );
  }
  const settings = await ctx.storage.organizationSettings
    .get(organization.id)
    .catch(() => null);
  if (!orgFlagEnabled(settings?.flags, "site_editor_content_protocol")) {
    return c.json({ error: "Not found" }, 404);
  }
  const virtualMcpId = c.req.param("virtualMcpId") ?? "";
  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }
  const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;
  const site = projectSite(metadata);
  const repository = parseRepositoryBinding(
    metadata,
    virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
  );
  if (!site || !repository) {
    return c.json({ error: "Project has no site or repository" }, 404);
  }
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  c.set("hostedProject", {
    organizationId: organization.id,
    virtualMcpId,
    site,
    packagePath: runtime?.path?.replace(/^\/+|\/+$/g, "") || null,
    repository,
  });
  return next();
});

const NOT_CONFIGURED = { error: "hosted delivery not configured" } as const;

async function hostedRepo(c: Context<HostedEnv>): Promise<HostedRepo | null> {
  const store = deliveryStore();
  if (!store) return null;
  const project = c.get("hostedProject");
  const client: RepoContentClient = await contentClientForProjectRepo(
    c.var.studioContext,
    project.organizationId,
    project.repository,
  );
  return {
    client,
    packagePath: project.packagePath,
    mainBranch: await client.getDefaultBranch(),
    store,
    site: project.site,
  };
}

function siteTokens(c: Context<HostedEnv>) {
  const signingKey = getSettings().siteTokenSigningKey;
  const deny = denylist();
  if (!signingKey || !deny) return null;
  return createSiteTokens({
    kv: c.var.studioContext.storage.kv,
    signingKey: () => importSigningKey(signingKey),
    denylist: deny,
  });
}

function hostedError(c: Context<HostedEnv>, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotV8Site) return c.json({ error: message }, 409);
  const status = repoErrorStatus(err);
  if (status !== null) {
    return c.json({ error: message }, status === 404 ? 404 : 502);
  }
  console.error("hosted: request failed", { error: message });
  return c.json({ error: message }, 500);
}

export function createHostedRoutes() {
  const app = new Hono<HostedEnv>();
  app.use("/:virtualMcpId/*", resolveHostedProject);

  app.get("/:virtualMcpId/releases", async (c) => {
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      const project = c.get("hostedProject");
      const insights = await insightsClientForProjectRepo(
        c.var.studioContext,
        project.organizationId,
        project.repository,
      );
      return c.json(
        await listReleases(repo, insights, c.req.query("cursor") ?? null),
        200,
        { "Cache-Control": "no-store" },
      );
    } catch (err) {
      return hostedError(c, err);
    }
  });

  app.post("/:virtualMcpId/releases/current", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sha?: unknown;
      confirm?: unknown;
    };
    if (typeof body.sha !== "string") {
      return c.json({ error: "sha is required" }, 400);
    }
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      const current = await makeCurrent(repo, body.sha, {
        confirm: body.confirm === true,
      });
      return c.json({ current });
    } catch (err) {
      if (err instanceof NotPublishedError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof SchemaMismatchError) {
        return c.json(
          { error: "schema-mismatch", target: err.target, head: err.head },
          409,
        );
      }
      return hostedError(c, err);
    }
  });

  app.post("/:virtualMcpId/resync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: unknown;
    };
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      return c.json(await resync(repo, { confirm: body.confirm === true }));
    } catch (err) {
      if (err instanceof RolledBackError) {
        return c.json({ error: "rolled-back" }, 409);
      }
      return hostedError(c, err);
    }
  });

  app.get("/:virtualMcpId/site-tokens", async (c) => {
    const project = c.get("hostedProject");
    const tokens = siteTokens(c);
    if (!tokens) return c.json({ error: "site tokens not configured" }, 503);
    return c.json({
      site: project.site,
      tokens: await tokens.list(project.organizationId, project.site),
    });
  });

  app.post("/:virtualMcpId/site-tokens", async (c) => {
    const project = c.get("hostedProject");
    const tokens = siteTokens(c);
    if (!tokens) return c.json({ error: "site tokens not configured" }, 503);
    try {
      return c.json(await tokens.issue(project.organizationId, project.site));
    } catch (err) {
      if (err instanceof TooManySiteTokensError) {
        return c.json({ error: "too-many-tokens" }, 409);
      }
      throw err;
    }
  });

  app.delete("/:virtualMcpId/site-tokens/:kid", async (c) => {
    const project = c.get("hostedProject");
    const tokens = siteTokens(c);
    if (!tokens) return c.json({ error: "site tokens not configured" }, 503);
    try {
      const record = await tokens.revoke(
        project.organizationId,
        project.site,
        c.req.param("kid"),
      );
      return c.json({ record });
    } catch (err) {
      if (err instanceof SiteTokenNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  return app;
}
