/**
 * Read/write access to the legacy deco.cx Supabase project.
 *
 * This whole `deco-legacy/` folder is the seam to the pre-Studio deco.cx
 * platform (sites, teams, plans, invoices, CDN usage). Nothing here is part of
 * Studio's own data model — it exists so an org that still owns deco.cx sites
 * can see its infra usage and bills inside Studio. Everything is env-gated and
 * fails closed (unconfigured deployment = feature absent, never a 500).
 *
 * Required env vars:
 *   DECO_SUPABASE_URL          – Supabase project URL
 *   DECO_SUPABASE_SERVICE_KEY  – Supabase service role key
 */

import { getSettings } from "../settings";

export interface DecoSupabaseConfig {
  supabaseUrl: string;
  serviceKey: string;
}

/** Null when the deployment has no legacy Supabase credentials. */
export function getDecoSupabaseConfig(): DecoSupabaseConfig | null {
  const settings = getSettings();
  const supabaseUrl = settings.decoSupabaseUrl;
  const serviceKey = settings.decoSupabaseServiceKey;
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

export async function supabaseGet<T>(
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
    console.error(`[deco-legacy] Supabase error (${res.status}): ${text}`);
    throw new Error(`External service error (${res.status})`);
  }
  return res.json() as Promise<T[]>;
}

export async function supabasePost<T>(
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
    console.error(`[deco-legacy] Supabase POST error (${res.status}): ${text}`);
    throw new Error(`External service error (${res.status})`);
  }
  const rows = (await res.json()) as T[];
  if (!rows[0]) {
    throw new Error("Supabase POST returned no rows");
  }
  return rows[0];
}
