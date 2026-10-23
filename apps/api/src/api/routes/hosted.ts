/**
 * The hosted Deco CMS screens of a Blocks v8 project (session; main's schema
 * passes `isV8Schema`):
 *
 *   GET    /api/:org/hosted/:virtualMcpId/releases?cursor=   Releases screen
 *   GET    /api/:org/hosted/:virtualMcpId/releases/:sha/reapply
 *                                                            { schemaChanged }: whether that
 *                                                            version was made for another schema
 *   POST   /api/:org/hosted/:virtualMcpId/releases/:sha/reapply
 *                                                            Reapply version: a new version
 *                                                            with that one's content
 *   POST   /api/:org/hosted/:virtualMcpId/releases/retry     Publish's "Try again": main's head
 *                                                            released, its release written if
 *                                                            missing
 *   GET    /api/:org/hosted/:virtualMcpId/site-tokens        list
 *   POST   /api/:org/hosted/:virtualMcpId/site-tokens        issue (shown once)
 *
 * Publish lives with the draft it publishes (`decofile.ts`). These are
 * Studio-internal routes; nothing outside Studio calls them.
 */

// OPEN: O-S4 — Releases and Reapply version have no existing route to reuse, so
// they are these Studio-internal routes (with site tokens beside them).

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { orgHasFeature } from "@/core/plan-feature-gate";
import { resolveCallerProjectScope } from "@/core/project-scope";
import {
  contentClientForProjectRepo,
  insightsClientForProjectRepo,
  repoErrorStatus,
  type RepoContentClient,
} from "@/git-providers";
import { type DeliveryStore, deliveryStore } from "@/hosted/delivery-store";
import { type DeliveryPurge, deliveryPurge } from "@/hosted/delivery-purge";
import {
  type HostedRepo,
  LatestUpdateError,
  MainMovedError,
} from "@/hosted/publish";
import {
  type SiteDomainsReader,
  sitePreviewHosts,
} from "@/hosted/preview-hosts";
import { NotV8Site } from "@/hosted/release-objects";
import { listReleases, releaseMainHead } from "@/hosted/releases";
import {
  NotPublishedError,
  reapplySchemaChanged,
  reapplyVersion,
} from "@/hosted/reapply";
import { coAuthorFromStudioContext } from "@/lib/co-author-identity";
import {
  projectMainIsV8,
  projectPackagePath,
  syncBlocksMajorMarker,
} from "@/hosted/blocks-major";
import { mainIsV8, ownedProjectSite, SITE_NOT_OWNED } from "@/hosted/scope";
import { createSiteTokens, importSigningKey } from "@/hosted/site-token";
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
  /** For the Blocks v8 marker write-through (hosted/blocks-major.ts). */
  metadata: Record<string, unknown> | null;
}

/** Opens the project repository's content client (tests pass a fake). */
type RepoClientFor = typeof contentClientForProjectRepo;

type HostedEnv = Env & {
  Variables: Env["Variables"] & {
    hostedProject: HostedProject;
    repoClientFor: RepoClientFor;
    delivery: () => Delivery | null;
    siteDomains: SiteDomainsReader | undefined;
  };
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
  const virtualMcpId = c.req.param("virtualMcpId") ?? "";
  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }
  // A project-scoped role may only act on projects in its allowlist.
  if (!isProjectAllowed(await resolveCallerProjectScope(ctx), virtualMcpId)) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }
  const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;
  const repository = parseRepositoryBinding(
    metadata,
    virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
  );
  if (!repository) {
    return c.json({ error: "Project has no repository" }, 404);
  }
  // Only a Blocks v8 site has these screens: `isV8Schema` on main's schema
  // (`projectMainIsV8`, at most one head read per minute), never the marker
  // alone.
  try {
    const client = await c.var.repoClientFor(ctx, organization.id, repository);
    const isV8 = await projectMainIsV8({
      projects: ctx.storage.virtualMcps,
      project: { id: virtualMcpId, organizationId: organization.id, metadata },
      by: ctx.auth.user.id,
      client,
      mainBranch: await client.getDefaultBranch(),
    });
    if (!isV8) return c.json({ error: "Not found" }, 404);
  } catch (err) {
    return hostedError(c, err);
  }
  const site = await ownedProjectSite(
    ctx.storage.orgSites,
    virtualMcpId,
    organization.id,
  );
  if (!site) return c.json(SITE_NOT_OWNED, 409);
  c.set("hostedProject", {
    organizationId: organization.id,
    virtualMcpId,
    site,
    packagePath: projectPackagePath(metadata),
    repository,
    metadata,
  });
  return next();
});

const NOT_CONFIGURED = { error: "hosted delivery not configured" } as const;

interface Delivery {
  store: DeliveryStore;
  purge: DeliveryPurge;
}

function defaultDelivery(): Delivery | null {
  const store = deliveryStore();
  return store ? { store, purge: deliveryPurge() } : null;
}

async function hostedRepo(c: Context<HostedEnv>): Promise<HostedRepo | null> {
  const delivery = c.var.delivery();
  if (!delivery) return null;
  const project = c.get("hostedProject");
  const client: RepoContentClient = await c.var.repoClientFor(
    c.var.studioContext,
    project.organizationId,
    project.repository,
  );
  return {
    client,
    packagePath: project.packagePath,
    mainBranch: await client.getDefaultBranch(),
    store: delivery.store,
    purge: delivery.purge,
    site: project.site,
    previewHosts: await sitePreviewHosts({
      site: project.site,
      metadata: project.metadata,
      domains: c.var.siteDomains,
    }),
  };
}

function siteTokens(c: Context<HostedEnv>) {
  const signingKey = getSettings().siteTokenSigningKey;
  if (!signingKey) return null;
  return createSiteTokens({
    kv: c.var.studioContext.storage.kv,
    signingKey: () => importSigningKey(signingKey),
  });
}

function hostedError(c: Context<HostedEnv>, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof NotV8Site) return c.json({ error: message }, 409);
  // Writing or purging latest.json failed: a code the UI localizes; the
  // user retries.
  if (err instanceof LatestUpdateError) {
    console.error("hosted: latest.json update failed", { error: message });
    return c.json({ error: "latest-update-failed" }, 502);
  }
  const status = repoErrorStatus(err);
  if (status !== null) {
    return c.json({ error: message }, status === 404 ? 404 : 502);
  }
  console.error("hosted: request failed", { error: message });
  return c.json({ error: message }, 500);
}

export function createHostedRoutes(
  options: {
    repoClientFor?: RepoClientFor;
    /** The delivery bucket and edge purge (tests pass in-memory ones). */
    delivery?: () => Delivery | null;
    /** The project repository's history (tests pass a fake). */
    insightsFor?: typeof insightsClientForProjectRepo;
    /** The site's deco.cx domains, for its preview hosts (tests pass a fake). */
    siteDomains?: SiteDomainsReader;
  } = {},
) {
  const app = new Hono<HostedEnv>();
  const repoClientFor = options.repoClientFor ?? contentClientForProjectRepo;
  const insightsFor = options.insightsFor ?? insightsClientForProjectRepo;
  const delivery = options.delivery ?? defaultDelivery;
  app.use("*", async (c, next) => {
    c.set("repoClientFor", repoClientFor);
    c.set("delivery", delivery);
    c.set("siteDomains", options.siteDomains);
    await next();
  });
  app.use("/:virtualMcpId/*", resolveHostedProject);

  app.get("/:virtualMcpId/releases", async (c) => {
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      const project = c.get("hostedProject");
      const insights = await insightsFor(
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

  // Publish's "Try again" when its changes were committed but weren't
  // released (no companion release, or latest.json not written): main's head.
  app.post("/:virtualMcpId/releases/retry", async (c) => {
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      return c.json({ current: await releaseMainHead(repo) });
    } catch (err) {
      return hostedError(c, err);
    }
  });

  // Before Reapply version: whether that version was made for another schema
  // (the dialog then says how to go back). Information only.
  app.get("/:virtualMcpId/releases/:sha/reapply", async (c) => {
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      return c.json({
        schemaChanged: await reapplySchemaChanged(repo, c.req.param("sha")),
      });
    } catch (err) {
      if (err instanceof NotPublishedError) {
        return c.json({ error: err.message }, 404);
      }
      return hostedError(c, err);
    }
  });

  // Reapply version: a new version (a commit on main) with that version's
  // content, then Publish's release path. Answers like Publish, plus
  // `schemaChanged`; a schema change never refuses it.
  app.post("/:virtualMcpId/releases/:sha/reapply", async (c) => {
    try {
      const repo = await hostedRepo(c);
      if (!repo) return c.json(NOT_CONFIGURED, 503);
      const result = await reapplyVersion(repo, c.req.param("sha"), {
        coAuthor: coAuthorFromStudioContext(c.var.studioContext),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof NotPublishedError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof MainMovedError) {
        return c.json({ error: "main-moved" }, 409);
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
      // Site tokens are for Blocks v8 sites only.
      const client = await c.var.repoClientFor(
        c.var.studioContext,
        project.organizationId,
        project.repository,
      );
      const isV8 = await mainIsV8(
        client,
        project.packagePath,
        await client.getDefaultBranch(),
      );
      await syncBlocksMajorMarker(
        c.var.studioContext.storage.virtualMcps,
        {
          id: project.virtualMcpId,
          organizationId: project.organizationId,
          metadata: project.metadata,
        },
        isV8,
        c.var.studioContext.auth?.user?.id ?? "system",
      );
      if (!isV8) return c.json({ error: "not a Blocks v8 site" }, 409);
      return c.json(await tokens.issue(project.organizationId, project.site));
    } catch (err) {
      return hostedError(c, err);
    }
  });

  return app;
}
