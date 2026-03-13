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
import { fetchToolsFromMCP } from "../../tools/connection/fetch-tools";

type Variables = { meshContext: MeshContext };

const app = new Hono<{ Variables: Variables }>();

interface SupabaseSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
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
    // Log full details server-side only; never forward raw Supabase errors to clients.
    const text = await res.text().catch(() => res.statusText);
    console.error(`[deco-sites] Supabase error (${res.status}): ${text}`);
    throw new Error(`External service error (${res.status})`);
  }
  return res.json() as Promise<T[]>;
}

function getSupabaseConfig(): {
  supabaseUrl: string;
  serviceKey: string;
} | null {
  const supabaseUrl = process.env.DECO_SUPABASE_URL;
  const serviceKey = process.env.DECO_SUPABASE_SERVICE_KEY;
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

async function fetchDecoApiKey(
  supabaseUrl: string,
  serviceKey: string,
  profileId: string,
): Promise<string | null> {
  const apiKeys = await supabaseGet<{ id: string }>(
    supabaseUrl,
    serviceKey,
    `api_key?user_id=eq.${encodeURIComponent(profileId)}&select=id&limit=1`,
  );
  return apiKeys[0]?.id ?? null;
}

// Require an authenticated user on every handler in this router.
app.use("*", async (c, next) => {
  const ctx = c.get("meshContext");
  if (!ctx.auth.user?.id) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

/**
 * GET /api/deco-sites
 *
 * Returns deco.cx sites belonging to the authenticated user.
 * The deco.cx API key is intentionally NOT returned — it remains server-side.
 */
app.get("/", async (c) => {
  const ctx = c.get("meshContext");

  const email = ctx.auth.user?.email;
  if (!email) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const config = getSupabaseConfig();
  if (!config) {
    return c.json({ error: "Deco integration is not configured" }, 503);
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
      `sites?team=in.(${teamIds.join(",")})&select=name,domains&order=id`,
    );

    return c.json({ sites });
  } catch (err) {
    console.error("[deco-sites] GET error:", err);
    return c.json({ error: "Failed to fetch sites" }, 502);
  }
});

const ADMIN_MCP = "https://sites-admin-mcp.decocache.com/api/mcp";

/**
 * POST /api/deco-sites/connection
 *
 * Creates the deco.cx MCP connection server-side so the API key never reaches
 * the browser. The caller supplies a pre-generated connId so subsequent
 * project-linking tool calls can reference it without an extra round-trip.
 */
app.post("/connection", async (c) => {
  const ctx = c.get("meshContext");

  const email = ctx.auth.user?.email;
  const userId = getUserId(ctx);
  if (!email || !userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { siteName: string; connId: string; orgId: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { siteName, connId, orgId } = body;
  if (!siteName || !connId || !orgId) {
    return c.json({ error: "siteName, connId, and orgId are required" }, 400);
  }

  const config = getSupabaseConfig();
  if (!config) {
    return c.json({ error: "Deco integration is not configured" }, 503);
  }
  const { supabaseUrl, serviceKey } = config;

  try {
    const profileId = await resolveProfileId(supabaseUrl, serviceKey, email);
    if (!profileId) {
      return c.json({ error: "No deco.cx account found for this user" }, 404);
    }

    const apiKey = await fetchDecoApiKey(supabaseUrl, serviceKey, profileId);

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
      connection_token: apiKey ?? null,
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

    return c.json({ connId: connection.id });
  } catch (err) {
    console.error("[deco-sites] POST /connection error:", err);
    return c.json({ error: "Failed to create connection" }, 500);
  }
});

export default app;
