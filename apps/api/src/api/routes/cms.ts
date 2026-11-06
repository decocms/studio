/**
 * The hosted CMS's Studio API, keyed by site (contract §4). The only writer
 * to the delivery and record buckets; Studio's editor, the `deco` CLI and
 * agents all call it. No route here reads a repository or calls GitHub.
 *
 *   GET    /api/cms/:site/drafts                      list (the drafts table)
 *   POST   /api/cms/:site/drafts                      create, idempotent { name }
 *   GET    /api/cms/:site/drafts/:name                resolve (slug, ETag, preview link)
 *   DELETE /api/cms/:site/drafts/:name                discard (files, index, then row)
 *   POST   /api/cms/:site/drafts/:name/rpc            content protocol + cms.index / cms.blocks
 *   POST   /api/cms/:site/drafts/:name/publish        publish { message? }
 *   GET    /api/cms/:site/releases?cursor=            Releases, 50 revisions a page
 *   POST   /api/cms/:site/releases/:revision/rollback rollback / roll-forward { message? }
 *   PUT    /api/cms/:site/schema                      `deco schema push`
 *   GET    /api/cms/:site/site-tokens                 list
 *   POST   /api/cms/:site/site-tokens                 issue (shown once)
 *
 * The path names no organization: `org_sites` (slug is its key) resolves
 * the site's. Every route runs, in order (§4.1): an authenticated caller
 * (401); the site and the caller's admission to its organization (404,
 * the same answer for an unknown site and for one the caller can't reach,
 * so existence doesn't leak); the caller's project scope over the site's
 * project (403 `project_not_allowed`, `isProjectAllowed`); the `cms` plan
 * gate on that organization (403, failing open); a blocked organization's
 * writes (403 `org_blocked`); then a configured delivery bucket (503). No
 * repository binding, no `blocksMajor` check. A draft name travels
 * `encodeURIComponent`-encoded (`/` as `%2F`).
 */

import { createHash } from "node:crypto";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { StorageUnavailableError } from "@decocms/blocks/protocol";
import { isV8Schema, BLOCKS_V8_MAJOR } from "@decocms/shared/blocks-major";
import { resolvePreviewServerUrl } from "@decocms/shared/deco-site-production-url";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import { isOrgBlocked } from "@/core/org-notice-gate";
import { resolveCallerProjectScope } from "@/core/project-scope";
import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { orgHasFeature } from "@/core/plan-feature-gate";
import {
  bindOrganization,
  memberRole,
  scopedToAnotherOrganization,
} from "../middleware/resolve-org-from-path";
import { syncBlocksMajorMarker } from "@/hosted/blocks-major-marker";
import {
  type CmsDrafts,
  createCmsDrafts,
  type DraftState,
  draftResource,
  draftToken,
  isValidDraftName,
} from "@/hosted/cms-drafts";
import {
  NotPublishedError,
  ProductionMovedError,
  publishCmsDraft,
  RevisionNotFoundError,
  RevisionTooLargeError,
  rollbackToRevision,
} from "@/hosted/cms-publish";
import { MalformedObjectError, readLatest } from "@/hosted/cms-release";
import { InvalidCursorError, listCmsReleases } from "@/hosted/cms-releases";
import { applyNamesOf, dispatchCmsRpc } from "@/hosted/cms-rpc";
import { createCmsStorage } from "@/hosted/cms-storage";
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
  /**
   * Admits the caller to the site's organization and binds the context to
   * it; `false` when the caller can't reach it (tests pass a fake).
   */
  admit?: (c: Context<CmsEnv>, organizationId: string) => Promise<boolean>;
  /** Whether the organization is blocked (tests pass an answer). */
  isBlocked?: (c: Context<CmsEnv>, organizationId: string) => Promise<boolean>;
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
  if (err instanceof NotPublishedError) {
    return fail(
      c,
      409,
      "not_published",
      "The site has no published release yet; publish a draft first",
    );
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
  if (err instanceof MalformedObjectError) {
    console.error("cms: malformed delivery object", { error: err.message });
    return fail(c, 500, "malformed", err.message);
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

/**
 * The caller's admission to an organization, as `/api/:org` admits it
 * (`resolveOrgFromPath`): not archived, no API key or token bound to another
 * organization, and a member (or a task-board admin). Binds the context to
 * it, as that middleware does.
 */
async function admitToOrganization(
  c: Context<CmsEnv>,
  organizationId: string,
): Promise<boolean> {
  const ctx = c.var.studioContext;
  const userId = ctx.auth?.user?.id;
  if (!ctx.db || !userId) return false;
  const org = await ctx.db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (!org || isOrgArchived(org)) return false;
  if (scopedToAnotherOrganization(ctx, org.id)) return false;
  const role = await memberRole(c, ctx.db, userId, org.id);
  if (role === undefined) return false;
  bindOrganization(ctx, org, role);
  return true;
}

/**
 * §4.1, in order: 401; 404 `site_not_found` (unknown, or not the caller's to
 * reach); 403 `project_not_allowed` (outside the caller's project scope);
 * 403 `feature_not_in_plan`; 403 `org_blocked` (writes); 503.
 */
function gates(options: CmsRoutesOptions) {
  return createMiddleware<CmsEnv>(async (c, next) => {
    const ctx = c.var.studioContext;
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const slug = c.req.param("site") ?? "";
    const row = await ctx.storage.orgSites.getBySlug(slug);
    // A tombstone (its org deleted) has no organization: not found either.
    const organizationId = row?.organizationId ?? null;
    const admitted =
      organizationId !== null &&
      (await (options.admit ?? admitToOrganization)(c, organizationId));
    if (!row || organizationId === null || !admitted) {
      return fail(c, 404, "site_not_found", "Site not found");
    }
    // A caller scoped to some of the org's projects (a custom role's
    // `projects` list) reaches only those projects' sites, as the org's
    // project tools enforce (`isProjectAllowed`).
    if (row.projectId) {
      const scope = await resolveCallerProjectScope(ctx);
      if (!isProjectAllowed(scope, row.projectId)) {
        return fail(
          c,
          403,
          "project_not_allowed",
          "This site's project is outside your access",
        );
      }
    }
    const hasCms = options.hasCms
      ? await options.hasCms(c, organizationId)
      : await orgHasFeature(ctx, organizationId, "cms");
    if (!hasCms) {
      return fail(
        c,
        403,
        "feature_not_in_plan",
        "This organization's plan does not include the CMS",
      );
    }
    // A blocked organization loses its writes, as under /api/:org (enforceOrgBlock).
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const blocked =
      write &&
      (options.isBlocked
        ? await options.isBlocked(c, organizationId)
        : ctx.db
          ? await isOrgBlocked(ctx.db, organizationId)
          : false);
    if (blocked) {
      return fail(
        c,
        403,
        "org_blocked",
        "This organization is blocked. Resolve the outstanding notice to restore access.",
      );
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
      if (found && found.organization_id === organizationId) {
        project = {
          id: found.id,
          metadata: (found.metadata as Record<string, unknown> | null) ?? null,
        };
      }
    }
    c.set("cmsSite", {
      organizationId,
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

/** The request without `Accept-Encoding`: the route reads the handler's answers. */
function uncompressed(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("accept-encoding");
  return new Request(request, { headers });
}

/** A draft's pointer version: the `draftToken` over the live revision. */
async function tokenOf(c: Context<CmsEnv>, state: DraftState) {
  const live = await readLatest(c.get("buckets").store, c.get("cmsSite").site);
  return draftToken(live?.latest.revision ?? null, state);
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
      const { row, created, state } = await c
        .get("drafts")
        .ensure(site.site, body.name, { userId: site.userId, via: site.via });
      const token = await tokenOf(c, state);
      return c.json(
        {
          ...draftResource(row, state.index.etag, token, previewOrigin(site)),
          created,
        },
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
      const token = await tokenOf(c, found.state);
      return c.json(
        draftResource(
          found.row,
          found.state.index.etag,
          token,
          previewOrigin(site),
        ),
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
    const body = await saveRequestBody(c.req.raw);
    const unguarded = refuseUnguardedSave(body, "draft");
    if (unguarded) return unguarded;
    const { store, records } = c.get("buckets");
    const storage = createCmsStorage({
      store,
      records,
      site: site.site,
      slug: row.slug,
      userId: site.userId,
      via: site.via,
      applyNames: applyNamesOf(body),
    });
    const origin = previewOrigin(site);
    const onError = (error: unknown) =>
      console.error("cms content protocol: internal error", {
        site: site.site,
        error: error instanceof Error ? error.message : String(error),
      });
    const handler = createContentHandler(storage, {
      server: { name: "studio-cms", version: "1" },
      // All or nothing per file write: a lost race answers Unavailable.
      maxCommitAttempts: 1,
      bodyCacheBytes: 0,
      preview: origin ? { url: origin } : null,
      onError,
    });
    const request = uncompressed(c.req.raw);
    // Not JSON, or over the size limit: the handler answers it whole.
    if (body === undefined) return handler(request);
    return dispatchCmsRpc(storage, handler, request, body, onError);
  });

  app.post("/:site/drafts/:name/publish", async (c) => {
    const name = draftNameParam(c);
    const site = c.get("cmsSite");
    if (!name) return fail(c, 404, "draft_not_found", "Draft not found");
    try {
      const row = await c.get("drafts").row(site.site, name);
      if (!row) return fail(c, 404, "draft_not_found", "Draft not found");
      const result = await publishCmsDraft(
        await publishDeps(c, options),
        { name, slug: row.slug },
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
        // The marker, and the record of this push that it counts only with.
        await syncBlocksMajorMarker(
          c.var.studioContext.storage.virtualMcps,
          {
            id: site.project.id,
            organizationId: site.organizationId,
            metadata: site.project.metadata,
          },
          {
            isV8,
            site: site.site,
            sha256: createHash("sha256").update(text).digest("hex"),
          },
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
    if (!tokens) {
      return fail(
        c,
        503,
        "hosted_delivery_unconfigured",
        "site tokens not configured",
      );
    }
    return c.json({
      site: site.site,
      tokens: await tokens.list(site.organizationId, site.site),
    });
  });

  app.post("/:site/site-tokens", async (c) => {
    const site = c.get("cmsSite");
    const tokens = siteTokens(c);
    if (!tokens) {
      return fail(
        c,
        503,
        "hosted_delivery_unconfigured",
        "site tokens not configured",
      );
    }
    try {
      return c.json(await tokens.issue(site.organizationId, site.site));
    } catch (err) {
      return cmsError(c, err);
    }
  });

  return app;
}
