/**
 * The hosted CMS's Studio API, keyed by site (contract §4). The only writer
 * to the delivery and record buckets; Studio's editor, the `deco` CLI and
 * agents all call it. No route here reads a repository or calls GitHub.
 *
 *   GET    /api/:org/cms/:site/drafts                      list (the drafts table)
 *   POST   /api/:org/cms/:site/drafts                      create, idempotent { name }
 *   GET    /api/:org/cms/:site/drafts/:name                resolve (slug, ETag, preview link)
 *   DELETE /api/:org/cms/:site/drafts/:name                discard (row and object)
 *   POST   /api/:org/cms/:site/drafts/:name/rpc            content protocol (save, editor reads, undo)
 *   POST   /api/:org/cms/:site/drafts/:name/publish        publish { message? }
 *   GET    /api/:org/cms/:site/releases?cursor=            Releases, 50 revisions a page
 *   POST   /api/:org/cms/:site/releases/:revision/rollback rollback / roll-forward { message? }
 *   PUT    /api/:org/cms/:site/schema                      `deco schema push`
 *   GET    /api/:org/cms/:site/site-tokens                 list
 *   POST   /api/:org/cms/:site/site-tokens                 issue (shown once)
 *
 * Every route runs exactly today's checks, in order (§4.1): an
 * authenticated caller (401), the `cms` plan gate (403, failing open), then
 * `org_sites` resolves the site within the path's org (404); then a
 * configured delivery bucket (503). No repository binding, no
 * `isProjectAllowed`, no `blocksMajor` check. A draft name travels
 * `encodeURIComponent`-encoded (`/` as `%2F`).
 */

import { createContentHandler } from "@decocms/blocks/protocol/server";
import { StorageUnavailableError } from "@decocms/blocks/protocol";
import { isV8Schema, BLOCKS_V8_MAJOR } from "@decocms/shared/blocks-major";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { orgHasFeature } from "@/core/plan-feature-gate";
import { syncBlocksMajorMarker } from "@/hosted/blocks-major-marker";
import {
  type CmsDrafts,
  createCmsDrafts,
  draftResource,
  isValidDraftName,
} from "@/hosted/cms-drafts";
import {
  NeverLiveError,
  ProductionMovedError,
  publishCmsDraft,
  RevisionNotFoundError,
  RevisionTooLargeError,
  rollbackToRevision,
} from "@/hosted/cms-publish";
import { InvalidCursorError, listCmsReleases } from "@/hosted/cms-releases";
import { createCmsStorage, withConflictBlocks } from "@/hosted/cms-storage";
import { type DeliveryPurge, deliveryPurge } from "@/hosted/delivery-purge";
import {
  bareEtag,
  type DeliveryStore,
  DeliveryUnavailableError,
  deliveryStore,
} from "@/hosted/delivery-store";
import {
  type SiteDomainsReader,
  sitePreviewHosts,
} from "@/hosted/preview-hosts";
import { type RecordStore, recordStore } from "@/hosted/record-store";
import { isRevisionId } from "@/hosted/revision-id";
import { refuseUnguardedSave, saveRequestBody } from "@/hosted/save-guards";
import { createSiteTokens, importSigningKey } from "@/hosted/site-token";
import { viaOf } from "@/hosted/via";
import { getSettings } from "@/settings";
import type { DraftStoragePort } from "@/storage/ports";
import type { CmsVia } from "@/storage/types";
import type { Env } from "../hono-env";

interface CmsSite {
  organizationId: string;
  site: string;
  /** The project `org_sites` links to the site, if any. */
  project: { id: string; metadata: Record<string, unknown> | null } | null;
  userId: string;
  via: CmsVia;
}

interface Buckets {
  store: DeliveryStore;
  purge: DeliveryPurge;
  records: RecordStore | null;
}

type CmsEnv = Env & {
  Variables: Env["Variables"] & {
    cmsSite: CmsSite;
    buckets: Buckets;
    drafts: CmsDrafts;
  };
};

export interface CmsRoutesOptions {
  /** The buckets and edge purge (tests pass in-memory ones). */
  buckets?: () => Buckets | null;
  /** The drafts table (tests pass one in memory). */
  draftTable?: (c: Context<CmsEnv>) => DraftStoragePort;
  /** The site's deco.cx domains, for its preview hosts (tests pass a fake). */
  siteDomains?: SiteDomainsReader;
  /** The `cms` plan gate (tests pass an answer). */
  hasCms?: (c: Context<CmsEnv>, organizationId: string) => Promise<boolean>;
}

const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;

function defaultBuckets(): Buckets | null {
  const store = deliveryStore();
  return store
    ? { store, purge: deliveryPurge(), records: recordStore() }
    : null;
}

function fail(
  c: Context<CmsEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
  code: string,
  error: string,
) {
  return c.json({ error, code }, status);
}

/** The origin of the site's preview server, or null when it has none. */
function previewOrigin(site: CmsSite): string | null {
  const url = resolvePreviewServerUrl(
    site.project?.metadata as Parameters<typeof resolvePreviewServerUrl>[0],
  );
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function cmsError(c: Context<CmsEnv>, err: unknown) {
  if (err instanceof ProductionMovedError) {
    return fail(c, 409, "production_moved", "production moved, try again");
  }
  if (err instanceof NeverLiveError) {
    return fail(c, 409, "never_live", "This revision never went live");
  }
  if (err instanceof RevisionNotFoundError) {
    return fail(c, 404, "revision_not_found", "Revision not found");
  }
  if (err instanceof RevisionTooLargeError) {
    return fail(c, 413, "too_large", err.message);
  }
  if (err instanceof InvalidCursorError) {
    return fail(c, 400, "invalid_body", "Invalid cursor");
  }
  if (
    err instanceof DeliveryUnavailableError ||
    err instanceof StorageUnavailableError
  ) {
    console.warn("cms: delivery bucket unavailable", { error: err.message });
    return fail(
      c,
      503,
      "unavailable",
      "The CMS storage is unavailable; try again",
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("cms: request failed", { error: message });
  return c.json({ error: message }, 500);
}

/** §4.1, in order: 401, 403 `feature_not_in_plan`, 404 `site_not_found`, 503. */
function gates(options: CmsRoutesOptions) {
  return createMiddleware<CmsEnv>(async (c, next) => {
    const ctx = c.var.studioContext;
    const organization = ctx.organization;
    if (!organization)
      return c.json({ error: "Organization scope required" }, 500);
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const hasCms = options.hasCms
      ? await options.hasCms(c, organization.id)
      : await orgHasFeature(ctx, organization.id, "cms");
    if (!hasCms) {
      return fail(
        c,
        403,
        "feature_not_in_plan",
        "This organization's plan does not include the CMS",
      );
    }
    const slug = c.req.param("site") ?? "";
    const row = await ctx.storage.orgSites.getBySlug(slug);
    if (!row || row.organizationId !== organization.id) {
      return fail(c, 404, "site_not_found", "Site not found");
    }
    const buckets = (options.buckets ?? defaultBuckets)();
    if (!buckets) {
      return fail(
        c,
        503,
        "hosted_delivery_unconfigured",
        "hosted delivery not configured",
      );
    }
    let project: CmsSite["project"] = null;
    if (row.projectId) {
      const found = await ctx.storage.virtualMcps.findById(row.projectId);
      if (found && found.organization_id === organization.id) {
        project = {
          id: found.id,
          metadata: (found.metadata as Record<string, unknown> | null) ?? null,
        };
      }
    }
    c.set("cmsSite", {
      organizationId: organization.id,
      site: row.slug,
      project,
      userId,
      via: viaOf(ctx.auth),
    });
    c.set("buckets", buckets);
    c.set(
      "drafts",
      createCmsDrafts({
        table: options.draftTable
          ? options.draftTable(c)
          : ctx.storage.cmsDrafts,
        store: buckets.store,
      }),
    );
    return next();
  });
}

function draftNameParam(c: Context<CmsEnv>): string | null {
  const name = c.req.param("name");
  return isValidDraftName(name) ? name : null;
}

function publishDeps(c: Context<CmsEnv>, options: CmsRoutesOptions) {
  const site = c.get("cmsSite");
  const { store, purge } = c.get("buckets");
  return sitePreviewHosts({
    site: site.site,
    metadata: site.project?.metadata,
    domains: options.siteDomains,
  }).then((previewHosts) => ({
    store,
    purge,
    site: site.site,
    previewHosts,
    author: site.userId,
    via: site.via,
  }));
}

async function messageOf(c: Context<CmsEnv>): Promise<string> {
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
  return typeof body.message === "string" ? body.message : "";
}

function siteTokens(c: Context<CmsEnv>) {
  const signingKey = getSettings().siteTokenSigningKey;
  if (!signingKey) return null;
  return createSiteTokens({
    kv: c.var.studioContext.storage.kv,
    signingKey: () => importSigningKey(signingKey),
  });
}

/** The request without `Accept-Encoding`: the conflict rewrite reads the body. */
function uncompressed(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("accept-encoding");
  return new Request(request, { headers });
}

export function createCmsRoutes(options: CmsRoutesOptions = {}) {
  const app = new Hono<CmsEnv>();
  app.use("/:site", gates(options));
  app.use("/:site/*", gates(options));

  app.get("/:site/drafts", async (c) => {
    try {
      const drafts = await c.get("drafts").list(c.get("cmsSite").site);
      return c.json({ drafts }, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.post("/:site/drafts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    if (!isValidDraftName(body.name)) {
      return fail(c, 400, "invalid_draft_name", "Invalid draft name");
    }
    const site = c.get("cmsSite");
    try {
      const { row, created, etag } = await c
        .get("drafts")
        .ensure(site.site, body.name, { userId: site.userId, via: site.via });
      return c.json(
        { ...draftResource(row, etag, previewOrigin(site)), created },
        200,
        {
          "Cache-Control": "no-store",
        },
      );
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.get("/:site/drafts/:name", async (c) => {
    const name = draftNameParam(c);
    const site = c.get("cmsSite");
    if (!name) return fail(c, 404, "draft_not_found", "Draft not found");
    try {
      const found = await c.get("drafts").resolve(site.site, name);
      if (!found) return fail(c, 404, "draft_not_found", "Draft not found");
      return c.json(
        draftResource(found.row, found.read.etag, previewOrigin(site)),
        200,
        {
          "Cache-Control": "no-store",
        },
      );
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.delete("/:site/drafts/:name", async (c) => {
    const name = draftNameParam(c);
    if (!name) return fail(c, 404, "draft_not_found", "Draft not found");
    try {
      const discarded = await c
        .get("drafts")
        .discard(c.get("cmsSite").site, name);
      if (!discarded) return fail(c, 404, "draft_not_found", "Draft not found");
      return c.json({ discarded: true });
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.post("/:site/drafts/:name/rpc", async (c) => {
    const name = draftNameParam(c);
    const site = c.get("cmsSite");
    if (!name) return fail(c, 404, "draft_not_found", "Draft not found");
    let row: Awaited<ReturnType<DraftStoragePort["get"]>>;
    try {
      row = await c.get("drafts").row(site.site, name);
    } catch (err) {
      return cmsError(c, err);
    }
    if (!row) return fail(c, 404, "draft_not_found", "Draft not found");
    // Every block a save touches carries its precondition (the draft rule).
    const unguarded = refuseUnguardedSave(
      await saveRequestBody(c.req.raw),
      "draft",
    );
    if (unguarded) return unguarded;
    const { store, records } = c.get("buckets");
    const storage = createCmsStorage({
      store,
      records,
      site: site.site,
      slug: row.slug,
      userId: site.userId,
    });
    const origin = previewOrigin(site);
    const handler = createContentHandler(storage, {
      server: { name: "studio-cms", version: "1" },
      // All or nothing: a lost race answers Unavailable, never a retry.
      maxCommitAttempts: 1,
      bodyCacheBytes: 0,
      preview: origin ? { url: origin } : null,
      onError: (error) =>
        console.error("cms content protocol: internal error", {
          site: site.site,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    const response = await handler(uncompressed(c.req.raw));
    return withConflictBlocks(response, storage.applyReads);
  });

  app.post("/:site/drafts/:name/publish", async (c) => {
    const name = draftNameParam(c);
    const site = c.get("cmsSite");
    if (!name) return fail(c, 404, "draft_not_found", "Draft not found");
    try {
      const found = await c.get("drafts").resolve(site.site, name);
      if (!found) return fail(c, 404, "draft_not_found", "Draft not found");
      const result = await publishCmsDraft(
        await publishDeps(c, options),
        { name, slug: found.row.slug },
        await messageOf(c),
      );
      return c.json(result);
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.get("/:site/releases", async (c) => {
    try {
      const page = await listCmsReleases(
        c.get("buckets").store,
        c.get("cmsSite").site,
        c.req.query("cursor") ?? null,
      );
      return c.json(page, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.post("/:site/releases/:revision/rollback", async (c) => {
    const revision = c.req.param("revision");
    if (!isRevisionId(revision)) {
      return fail(c, 404, "revision_not_found", "Revision not found");
    }
    try {
      return c.json(
        await rollbackToRevision(
          await publishDeps(c, options),
          revision,
          await messageOf(c),
        ),
      );
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.put("/:site/schema", async (c) => {
    const site = c.get("cmsSite");
    const { records } = c.get("buckets");
    if (!records) {
      return fail(
        c,
        503,
        "hosted_delivery_unconfigured",
        "hosted record bucket not configured",
      );
    }
    const length = Number(c.req.header("content-length"));
    if (Number.isFinite(length) && length > MAX_SCHEMA_BYTES) {
      return fail(
        c,
        413,
        "too_large",
        `The schema is over ${MAX_SCHEMA_BYTES} bytes`,
      );
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_SCHEMA_BYTES) {
      return fail(
        c,
        413,
        "too_large",
        `The schema is over ${MAX_SCHEMA_BYTES} bytes`,
      );
    }
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch {
      return fail(c, 400, "invalid_body", "The schema isn't JSON");
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return fail(c, 400, "invalid_body", "The schema isn't a JSON object");
    }
    try {
      const { etag } = await records.putSchema(site.site, text);
      const isV8 = isV8Schema(schema);
      if (site.project) {
        await syncBlocksMajorMarker(
          c.var.studioContext.storage.virtualMcps,
          {
            id: site.project.id,
            organizationId: site.organizationId,
            metadata: site.project.metadata,
          },
          isV8,
          site.userId,
        );
      }
      return c.json({
        etag: bareEtag(etag),
        blocksMajor: isV8 ? BLOCKS_V8_MAJOR : null,
      });
    } catch (err) {
      return cmsError(c, err);
    }
  });

  app.get("/:site/site-tokens", async (c) => {
    const site = c.get("cmsSite");
    const tokens = siteTokens(c);
    if (!tokens) return c.json({ error: "site tokens not configured" }, 503);
    return c.json({
      site: site.site,
      tokens: await tokens.list(site.organizationId, site.site),
    });
  });

  app.post("/:site/site-tokens", async (c) => {
    const site = c.get("cmsSite");
    const tokens = siteTokens(c);
    if (!tokens) return c.json({ error: "site tokens not configured" }, 503);
    try {
      return c.json(await tokens.issue(site.organizationId, site.site));
    } catch (err) {
      return cmsError(c, err);
    }
  });

  return app;
}
