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
import type { MeshContext } from "../../core/mesh-context";
import { getUserId } from "../../core/mesh-context";
import { generatePrefixedId } from "../../shared/utils/generate-id";
import { fetchToolsFromMCP } from "../../tools/connection/fetch-tools";

type Variables = { meshContext: MeshContext };

interface SupabaseSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
  thumb_url: string | null;
}

async function supabaseGet<T>(
  supabaseUrl: string,
  serviceKey: string,
  path: string,
): Promise<T[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`[deco-sites] Supabase error (${res.status}): ${text}`);
    throw new Error(`External service error (${res.status})`);
  }
  return res.json() as Promise<T[]>;
}

async function supabasePost<T>(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(`[deco-sites] Supabase POST error (${res.status}): ${text}`);
    throw new Error(`External service error (${res.status})`);
  }
  const rows = (await res.json()) as T[];
  if (!rows[0]) {
    throw new Error("Supabase POST returned no rows");
  }
  return rows[0];
}

import { getSettings } from "../../settings";

function getSupabaseConfig(): {
  supabaseUrl: string;
  serviceKey: string;
} | null {
  const settings = getSettings();
  const supabaseUrl = settings.decoSupabaseUrl;
  const serviceKey = settings.decoSupabaseServiceKey;
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

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

async function getOrCreateDecoApiKey(
  supabaseUrl: string,
  serviceKey: string,
  profileId: string,
): Promise<string> {
  const existing = await supabaseGet<{ id: string }>(
    supabaseUrl,
    serviceKey,
    `api_key?user_id=eq.${encodeURIComponent(profileId)}&select=id&limit=1`,
  );
  if (existing[0]?.id) {
    return existing[0].id;
  }

  const created = await supabasePost<{ id: string }>(
    supabaseUrl,
    serviceKey,
    "api_key",
    { user_id: profileId },
  );
  return created.id;
}

const SERVICE_ACCOUNT_EMAIL_PREFIX = "deco-team-";
const SERVICE_ACCOUNT_EMAIL_DOMAIN = "deco.cx";

function serviceAccountEmail(teamId: number): string {
  return `${SERVICE_ACCOUNT_EMAIL_PREFIX}${teamId}@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`;
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

/**
 * Creates a Supabase Auth user via the Admin API.
 * Returns the new user's `id` (UUID).
 */
async function createSupabaseAuthUser(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      email_confirm: true,
      app_metadata: { mesh_service_account: true },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(
      `[deco-sites] Auth admin create user error (${res.status}): ${text}`,
    );
    throw new Error(`Failed to create auth user (${res.status})`);
  }
  const user = (await res.json()) as { id: string };
  return user.id;
}

/**
 * Get or create a service account for the given deco.cx team.
 *
 * A service account is a Supabase auth user + profile + team member (owner role)
 * with its own API key. One service account is shared across all sites in the
 * same team.
 */
async function getOrCreateTeamServiceAccount(
  supabaseUrl: string,
  serviceKey: string,
  teamId: number,
): Promise<string> {
  const email = serviceAccountEmail(teamId);

  const existingProfile = await supabaseGet<{ user_id: string }>(
    supabaseUrl,
    serviceKey,
    `profiles?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`,
  );

  if (existingProfile[0]?.user_id) {
    const authUserId = existingProfile[0].user_id;

    // Ensure the member row exists for this team (may be missing if a previous
    // run created the profile but failed before reaching step 3).
    const existingMember = await supabaseGet<{ id: number }>(
      supabaseUrl,
      serviceKey,
      `members?user_id=eq.${encodeURIComponent(authUserId)}&team_id=eq.${teamId}&select=id&limit=1`,
    );

    if (!existingMember[0]?.id) {
      const member = await supabasePost<{ id: number }>(
        supabaseUrl,
        serviceKey,
        "members",
        { user_id: authUserId, team_id: teamId, admin: true },
      );
      await supabasePost<{ id: number }>(
        supabaseUrl,
        serviceKey,
        "member_roles",
        {
          member_id: member.id,
          role_id: 1,
        },
      );
    }

    return getOrCreateDecoApiKey(supabaseUrl, serviceKey, authUserId);
  }

  // 1. Create Supabase Auth user
  const authUserId = await createSupabaseAuthUser(
    supabaseUrl,
    serviceKey,
    email,
  );

  // 2. Create profile (skip if a DB trigger already created one)
  const autoProfile = await supabaseGet<{ user_id: string }>(
    supabaseUrl,
    serviceKey,
    `profiles?user_id=eq.${encodeURIComponent(authUserId)}&select=user_id&limit=1`,
  );
  if (!autoProfile[0]) {
    await supabasePost<{ id: number }>(supabaseUrl, serviceKey, "profiles", {
      user_id: authUserId,
      email,
      name: `Mesh Service Account (team ${teamId})`,
    });
  }

  // 3. Create team membership (admin: true)
  const member = await supabasePost<{ id: number }>(
    supabaseUrl,
    serviceKey,
    "members",
    {
      user_id: authUserId,
      team_id: teamId,
      admin: true,
    },
  );

  // 4. Assign owner role (role_id = 1)
  await supabasePost<{ id: number }>(supabaseUrl, serviceKey, "member_roles", {
    member_id: member.id,
    role_id: 1,
  });

  // 5. Create and return API key
  return getOrCreateDecoApiKey(supabaseUrl, serviceKey, authUserId);
}

// Auth middleware shared by both factories: require an authenticated user.
const requireAuth = async (
  c: import("hono").Context<{ Variables: Variables }>,
  next: () => Promise<void>,
) => {
  const ctx = c.get("meshContext");
  if (!ctx.auth.user?.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

const ADMIN_MCP = "https://sites-admin-mcp.deco.site/api/mcp";
const ADMIN_API = "https://admin.deco.cx";

/**
 * Bucket layout that deco-sites/admin's provisionTenantS3Credentials
 * sets up: a single `deco-assets` bucket on GCS (path-style S3 interop),
 * one managed folder per site under `<siteName>/`, served through the
 * `decoims.com` image CDN. Mirrors what the legacy admin's media widget
 * already reads from — see `clients/gcsTenantCredentials.ts` in admin.
 */
const DECO_ASSETS_BUCKET = "deco-assets";
const DECO_ASSETS_ENDPOINT = "https://storage.googleapis.com";
const DECOIMS_CDN = "https://decoims.com";
const FILE_CONFIG_NAME_PREFIX = "deco-assets-";

interface TenantS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Calls `POST admin.deco.cx/api/<site>/s3-credentials` as the team's
 * service account. The endpoint provisions (idempotently) a GCP service
 * account, IAM-binds it to the site's managed folder, and mints a fresh
 * HMAC key — see deco-sites/admin#3223 / #3235 for the auth contract.
 * Returns null on any failure so callers can fall back to best-effort
 * behaviour (the deco-sites import itself shouldn't fail just because
 * storage couldn't be provisioned).
 */
export async function provisionDecoAssetsCredentials(
  siteName: string,
  serviceAccountApiKey: string,
): Promise<TenantS3Credentials | null> {
  try {
    const res = await fetch(
      `${ADMIN_API}/api/${encodeURIComponent(siteName)}/s3-credentials`,
      {
        method: "POST",
        headers: { "x-api-key": serviceAccountApiKey },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[deco-sites] s3-credentials failed (${res.status}) for site=${siteName}: ${body.slice(0, 200)}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      accessKeyId?: string;
      secretAccessKey?: string;
    };
    if (!data.accessKeyId || !data.secretAccessKey) {
      console.error(
        `[deco-sites] s3-credentials returned malformed response for site=${siteName}`,
      );
      return null;
    }
    return {
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
    };
  } catch (err) {
    console.error(
      `[deco-sites] s3-credentials request errored for site=${siteName}:`,
      err,
    );
    return null;
  }
}

/**
 * Create a FILE_CONFIG row pointing at the per-site managed folder
 * inside `gs://deco-assets`, served through `https://decoims.com`. If a
 * config with the same name already exists in this org (re-import of
 * the same site), no-op — credentials there may have been rotated by
 * the user. Caller treats this as best-effort.
 */
export async function provisionDecoAssetsFileConfig(params: {
  ctx: MeshContext;
  orgId: string;
  userId: string;
  siteName: string;
  serviceAccountApiKey: string;
}): Promise<void> {
  const { ctx, orgId, userId, siteName, serviceAccountApiKey } = params;
  const configName = `${FILE_CONFIG_NAME_PREFIX}${siteName}`;

  const existing = await ctx.storage.orgFileConfigs.list(orgId);
  if (existing.some((c) => c.name.toLowerCase() === configName.toLowerCase())) {
    console.log(
      `[deco-sites] file-config "${configName}" already exists for org=${orgId}, skipping`,
    );
    return;
  }

  const creds = await provisionDecoAssetsCredentials(
    siteName,
    serviceAccountApiKey,
  );
  if (!creds) return;

  await ctx.storage.orgFileConfigs.create({
    organizationId: orgId,
    name: configName,
    description: `deco-assets storage for site "${siteName}". Provisioned during deco.cx import.`,
    bucket: DECO_ASSETS_BUCKET,
    region: "auto",
    endpoint: DECO_ASSETS_ENDPOINT,
    forcePathStyle: true,
    prefix: `${siteName}/`,
    publicUrlBase: DECOIMS_CDN,
    credentials: creds,
    createdBy: userId,
  });
  console.log(
    `[deco-sites] file-config "${configName}" provisioned for org=${orgId}`,
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
    const ctx = c.get("meshContext");
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
    const ctx = c.get("meshContext");

    // FIXME(dev-only): local-auth email doesn't match a deco.cx profile — revert before shipping
    const email = "pedrofrxncx@deco.cx";
    if (!ctx.auth.user?.id) {
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
        `sites?team=in.(${teamIds.join(",")})&select=name,domains,thumb_url&order=id`,
      );

      return c.json({ sites });
    } catch (err) {
      console.error("[deco-sites] GET error:", err);
      return c.json({ error: "Failed to fetch sites" }, 502);
    }
  });

  /**
   * POST /api/deco-sites/connection
   *
   * Creates the deco.cx MCP connection server-side so the API key never reaches
   * the browser. The caller supplies a pre-generated connId so subsequent
   * project-linking tool calls can reference it without an extra round-trip.
   */
  app.post("/connection", async (c) => {
    const ctx = c.get("meshContext");

    // FIXME(dev-only): local-auth email doesn't match a deco.cx profile — revert before shipping
    const email = "pedrofrxncx@deco.cx";
    const userId = getUserId(ctx);
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: { siteName: string; orgId: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { siteName, orgId } = body;
    if (!siteName || !orgId) {
      return c.json({ error: "siteName and orgId are required" }, 400);
    }

    const connId = generatePrefixedId("conn");

    // Validate siteName is a safe DNS subdomain label to prevent SSRF.
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(siteName)) {
      return c.json({ error: "Invalid siteName" }, 400);
    }

    const membership = await ctx.db
      .selectFrom("member")
      .select("member.id")
      .where("member.userId", "=", userId)
      .where("member.organizationId", "=", orgId)
      .executeTakeFirst();

    if (!membership) {
      return c.json({ error: "Forbidden" }, 403);
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

      // Verify the user is a member of the site's team.
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

      const apiKey = await getOrCreateTeamServiceAccount(
        supabaseUrl,
        serviceKey,
        teamId,
      );

      // Fetch tools and scopes from the MCP server before storing, mirroring
      // what COLLECTION_CONNECTIONS_CREATE does so the tools list isn't empty.
      const fetchResult = await fetchToolsFromMCP({
        id: `pending-${connId}`,
        title: `deco.cx — ${siteName}`,
        connection_type: "HTTP",
        connection_url: ADMIN_MCP,
        connection_token: apiKey,
      }).catch(() => null);
      const tools = fetchResult?.tools?.length ? fetchResult.tools : null;
      const configuration_scopes = fetchResult?.scopes?.length
        ? fetchResult.scopes
        : null;

      // Fetch the favicon server-side to avoid CORS issues.
      // Returned to the caller so it can be set as the project icon.
      const faviconIcon = await fetchFaviconAsDataUrl(`${siteName}.deco.site`);

      // Store the connection with the API key encrypted by the vault.
      // The key is never serialised into any response body.
      const connection = await ctx.storage.connections.create({
        id: connId,
        organization_id: orgId,
        created_by: userId,
        title: `deco.cx — ${siteName}`,
        description: `Admin MCP for deco.cx site: ${siteName}`,
        connection_type: "HTTP",
        connection_url: ADMIN_MCP,
        connection_token: apiKey,
        connection_headers: null,
        oauth_config: null,
        configuration_state: {
          SITE_NAME: siteName,
        },
        metadata: { source: "deco.cx-import" },
        icon: null,
        app_name: "deco.cx",
        app_id: null,
        tools,
        configuration_scopes,
      });

      // Best-effort: provision a FILE_CONFIG pointing at the site's
      // deco-assets folder so the sections-editor file picker can list
      // and upload images right after import. Any failure here is
      // logged and swallowed — the deco.cx connection itself is
      // already created and useful on its own.
      await provisionDecoAssetsFileConfig({
        ctx,
        orgId,
        userId,
        siteName,
        serviceAccountApiKey: apiKey,
      }).catch((err) => {
        console.error(
          `[deco-sites] file-config provisioning failed for site=${siteName}:`,
          err,
        );
      });

      return c.json({ connId: connection.id, icon: faviconIcon });
    } catch (err) {
      console.error("[deco-sites] POST /connection error:", err);
      return c.json({ error: "Failed to create connection" }, 500);
    }
  });

  return app;
};
