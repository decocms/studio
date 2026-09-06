/**
 * Deco Sites API Route
 *
 * Returns the list of deco.cx sites the authenticated user has access to,
 * and provides a server-side connection-creation endpoint so the deco.cx
 * API key is never forwarded to the browser.
 *
 * Required env vars:
 *   DECO_SUPABASE_URL          – Supabase project URL (e.g. https://xxx.supabase.co)
 *   DECO_SUPABASE_SERVICE_KEY  – Supabase service role key
 */

import { Hono } from "hono";
import { ForbiddenError, UnauthorizedError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";
import { getUserId, requireOrganization } from "../../core/studio-context";
import { tenantStorageDescriptor } from "../../file-storage/tenant-credentials";
import { isValidSiteSlug } from "@decocms/shared/site-slug";

type Variables = { studioContext: StudioContext };

interface SupabaseSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
  thumb_url: string | null;
  metadata: Record<string, unknown> | null;
}

import {
  getDecoSupabaseConfig as getSupabaseConfig,
  supabaseGet,
} from "../../deco-legacy/supabase";

async function resolveProfileId(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<string | null> {
  const profiles = await supabaseGet<{ user_id: string }>(
    supabaseUrl,
    serviceKey,
    `profiles?email=eq.${encodeURIComponent(email)}&select=user_id`,
  );
  return profiles[0]?.user_id ?? null;
}

async function resolveTeamIdForSite(
  supabaseUrl: string,
  serviceKey: string,
  siteName: string,
): Promise<number | null> {
  const sites = await supabaseGet<{ team: number | null }>(
    supabaseUrl,
    serviceKey,
    `sites?name=eq.${encodeURIComponent(siteName)}&select=team&limit=1`,
  );
  return sites[0]?.team ?? null;
}

// Auth middleware shared by both factories: require an authenticated user.
const requireAuth = async (
  c: import("hono").Context<{ Variables: Variables }>,
  next: () => Promise<void>,
) => {
  const ctx = c.get("studioContext");
  if (!ctx.auth.user?.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

const FILE_CONFIG_NAME_PREFIX = "deco-assets-";

/**
 * True when a config already IS the managed config for `slug` — the only case
 * where re-importing has nothing to do. A same-named config that isn't (the
 * legacy pre-tenancy import created `deco-assets-<site>` pointing at the old
 * assets bucket with vended credentials) must be upgraded in place: the
 * `(organization_id, lower(name))` unique index makes creating a second row
 * impossible, so skipping would strand the org on the legacy bucket forever.
 */
export function isManagedConfigFor(
  config: { credentialType: string; siteSlug: string | null },
  slug: string,
): boolean {
  return (
    config.credentialType === "managed" &&
    config.siteSlug?.toLowerCase() === slug
  );
}

/**
 * Claim the site slug for this org in studio's own tenancy table and create a
 * `managed` FILE_CONFIG for it. Studio mints prefix-scoped STS credentials
 * in-process at upload/list time (see file-storage/tenant-credentials.ts) — no
 * service-account key, no live call to admin to vend credentials. Idempotent:
 * re-importing the same site re-claims (same org) and, when the config already
 * points at the managed tenant bucket, changes nothing.
 * Best-effort: any failure is logged and swallowed by the caller.
 */
async function provisionManagedAssetsConfig(params: {
  ctx: StudioContext;
  orgId: string;
  userId: string;
  siteName: string;
}): Promise<void> {
  const { ctx, orgId, userId, siteName } = params;
  const slug = siteName.toLowerCase();
  if (!isValidSiteSlug(slug)) {
    console.error(
      `[deco-sites] site "${siteName}" is not a valid asset slug; skipping managed config`,
    );
    return;
  }

  // Claim ownership in studio's tenancy table (idempotent for this org).
  // claimSite throws if a different org already owns the slug — skip rather
  // than create a config that would fail the ownership gate at upload time.
  try {
    await ctx.storage.orgSites.claimSite({
      slug,
      organizationId: orgId,
      source: "deco-import",
      by: userId,
    });
  } catch (err) {
    console.error(
      `[deco-sites] could not claim site "${slug}" for org=${orgId}:`,
      err,
    );
    return;
  }

  const configName = `${FILE_CONFIG_NAME_PREFIX}${siteName}`;
  const existing = (await ctx.storage.orgFileConfigs.list(orgId)).find(
    (c) => c.name.toLowerCase() === configName.toLowerCase(),
  );
  if (existing && isManagedConfigFor(existing, slug)) {
    return;
  }

  const descriptor = tenantStorageDescriptor(slug);
  const storage = {
    bucket: descriptor.bucket,
    region: descriptor.region,
    endpoint: descriptor.endpoint,
    forcePathStyle: descriptor.forcePathStyle,
    prefix: descriptor.prefix,
    publicUrlBase: descriptor.publicUrlBase,
    // The legacy config carried an sts-session refreshUrl; managed mints
    // in-process, so clear it or the S3 client would still call out to admin.
    refreshUrl: null,
    siteSlug: slug,
    credentials: { type: "managed" as const },
  };

  if (existing) {
    await ctx.storage.orgFileConfigs.update({
      id: existing.id,
      organizationId: orgId,
      ...storage,
      updatedBy: userId,
    });
    console.log(
      `[deco-sites] legacy file-config "${configName}" upgraded to managed for org=${orgId}`,
    );
    return;
  }

  await ctx.storage.orgFileConfigs.create({
    organizationId: orgId,
    name: configName,
    description: `Managed deco-assets storage for site "${siteName}".`,
    ...storage,
    createdBy: userId,
  });
  console.log(
    `[deco-sites] managed file-config "${configName}" provisioned for org=${orgId}`,
  );
}

async function fetchFaviconAsDataUrl(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}/favicon.ico`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/x-icon";
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * User-scoped routes (NOT org-scoped). Stays mounted at /api/deco-sites
 * permanently — no deprecation log.
 */
export const createDecoSitesUserRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requireAuth);

  /**
   * GET /api/deco-sites/profile
   *
   * Lightweight check: returns whether the authenticated user has a deco.cx profile.
   * Used to conditionally show deco.cx onboarding UI without fetching all sites.
   */
  app.get("/profile", async (c) => {
    const ctx = c.get("studioContext");
    const email = ctx.auth.user?.email;
    if (!email) return c.json({ error: "Unauthorized" }, 401);

    const config = getSupabaseConfig();
    if (!config) return c.json({ isDecoUser: false });

    try {
      const profileId = await resolveProfileId(
        config.supabaseUrl,
        config.serviceKey,
        email,
      );
      return c.json({ isDecoUser: profileId !== null });
    } catch {
      return c.json({ isDecoUser: false });
    }
  });

  return app;
};

/**
 * Org-scoped routes. Currently mounted at /api/deco-sites with a
 * deprecation log; will move to /api/:org/deco-sites in Task 14.
 */
export const createDecoSitesOrgRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requireAuth);

  /**
   * GET /api/deco-sites
   *
   * Returns deco.cx sites belonging to the authenticated user.
   * The deco.cx API key is intentionally NOT returned — it remains server-side.
   */
  app.get("/", async (c) => {
    const ctx = c.get("studioContext");

    const email = ctx.auth.user?.email;
    if (!email) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const config = getSupabaseConfig();
    if (!config) {
      return c.json({ sites: [] });
    }
    const { supabaseUrl, serviceKey } = config;

    try {
      const profileId = await resolveProfileId(supabaseUrl, serviceKey, email);
      if (!profileId) {
        return c.json({ sites: [] });
      }

      const members = await supabaseGet<{ team_id: number }>(
        supabaseUrl,
        serviceKey,
        `members?user_id=eq.${encodeURIComponent(profileId)}&deleted_at=is.null&select=team_id`,
      );

      // Guard: only allow integer team IDs to prevent query injection.
      const teamIds = members
        .map((m) => m.team_id)
        .filter((id): id is number => Number.isInteger(id));

      if (teamIds.length === 0) {
        return c.json({ sites: [] });
      }

      const sites = await supabaseGet<SupabaseSite>(
        supabaseUrl,
        serviceKey,
        `sites?team=in.(${teamIds.join(",")})&select=name,domains,thumb_url,metadata&order=id`,
      );

      return c.json({ sites });
    } catch (err) {
      console.error("[deco-sites] GET error:", err);
      return c.json({ error: "Failed to fetch sites" }, 502);
    }
  });

  /** POST /api/deco-sites/prepare — claims the site's asset slug, provisions managed storage, and returns the favicon for the project icon (no deco.cx API key reaches the browser). */
  app.post("/prepare", async (c) => {
    const ctx = c.get("studioContext");
    const organization = requireOrganization(ctx);

    const email = ctx.auth.user?.email;
    const userId = getUserId(ctx);
    if (!email || !userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Same permission gate as COLLECTION_CONNECTIONS_CREATE.
    try {
      await ctx.access.check("COLLECTION_CONNECTIONS_CREATE");
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return c.json({ error: err.message }, 401);
      }
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    let body: { siteName: string; orgId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { siteName } = body;
    if (!siteName) {
      return c.json({ error: "siteName is required" }, 400);
    }

    if (body.orgId && body.orgId !== organization.id) {
      return c.json({ error: "orgId does not match organization in URL" }, 400);
    }

    const orgId = organization.id;

    // Validate siteName is a safe DNS subdomain label to prevent SSRF.
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(siteName)) {
      return c.json({ error: "Invalid siteName" }, 400);
    }

    const config = getSupabaseConfig();
    if (!config) {
      return c.json({ error: "Deco integration is not configured" }, 503);
    }
    const { supabaseUrl, serviceKey } = config;

    try {
      // Verify the user has a deco.cx account.
      const profileId = await resolveProfileId(supabaseUrl, serviceKey, email);
      if (!profileId) {
        return c.json({ error: "No deco.cx account found for this user" }, 404);
      }

      // Resolve which team owns this site.
      const teamId = await resolveTeamIdForSite(
        supabaseUrl,
        serviceKey,
        siteName,
      );
      if (!teamId) {
        return c.json({ error: "Site not found or has no team" }, 404);
      }

      // Verify the user is a member of the site's deco.cx team.
      const decoMembership = await supabaseGet<{ id: number }>(
        supabaseUrl,
        serviceKey,
        `members?user_id=eq.${encodeURIComponent(profileId)}&team_id=eq.${teamId}&deleted_at=is.null&select=id&limit=1`,
      );
      if (!decoMembership[0]) {
        return c.json(
          { error: "You are not a member of this site's team" },
          403,
        );
      }

      // Fetch the favicon server-side (avoids CORS) for use as the project icon.
      const faviconIcon = await fetchFaviconAsDataUrl(`${siteName}.deco.site`);

      // Best-effort: claim the slug + provision managed asset storage; swallow errors.
      await provisionManagedAssetsConfig({
        ctx,
        orgId,
        userId,
        siteName,
      }).catch((err) => {
        console.error(
          `[deco-sites] managed assets config provisioning failed for site=${siteName}:`,
          err,
        );
      });

      return c.json({ icon: faviconIcon });
    } catch (err) {
      console.error("[deco-sites] POST /prepare error:", err);
      return c.json({ error: "Failed to prepare import" }, 500);
    }
  });

  return app;
};
