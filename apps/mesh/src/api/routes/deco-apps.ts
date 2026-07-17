/**
 * Deco App Store catalog — lists installable site apps from the deco.cx
 * Supabase `apps` table (same source as admin's loaders/apps/list.ts).
 */

import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import { getSettings } from "../../settings";

type Variables = { studioContext: StudioContext };

export interface SupabaseAppRow {
  name: string;
  title: string;
  description: string;
  logo: string;
  category: string | null;
  vendors: { alias: string; url: string } | null;
}

export interface DecoAppCatalogItem {
  name: string;
  title: string;
  description: string;
  logo: string;
  category: string | null;
  vendor: { alias: string; url: string };
}

const SUPABASE_FETCH_TIMEOUT_MS = 10_000;

export function mapSupabaseAppRows(
  rows: SupabaseAppRow[],
): DecoAppCatalogItem[] {
  return rows
    .filter((row) => row.vendors?.alias)
    .map((row) => ({
      name: row.name,
      title: row.title,
      description: row.description,
      logo: row.logo,
      category: row.category,
      vendor: {
        alias: row.vendors!.alias,
        url: row.vendors!.url,
      },
    }));
}

async function supabaseGetApps(
  supabaseUrl: string,
  serviceKey: string,
): Promise<SupabaseAppRow[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/apps?select=name,title,description,logo,category,vendors(alias,url)`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    console.error(
      `[deco-apps] Supabase error (${res.status}): ${text.slice(0, 200)}`,
    );
    throw new Error(`External service error (${res.status})`);
  }
  return (await res.json()) as SupabaseAppRow[];
}

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

export const createDecoAppsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requireAuth);

  app.get("/", async (c) => {
    const settings = getSettings();
    const supabaseUrl = settings.decoSupabaseUrl;
    const serviceKey = settings.decoSupabaseServiceKey;

    if (!supabaseUrl || !serviceKey) {
      return c.json({ apps: [] });
    }

    try {
      const rows = await supabaseGetApps(supabaseUrl, serviceKey);
      return c.json({ apps: mapSupabaseAppRows(rows) });
    } catch (err) {
      console.error("[deco-apps] GET error:", err);
      return c.json({ error: "Failed to fetch apps" }, 502);
    }
  });

  return app;
};
