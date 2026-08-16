/**
 * OneDollarStats (Plausible-compatible) — the legacy platform's pageview
 * source. Pageviews are NOT in the analytics warehouse, so the Infra Billing
 * page needs this second read. Indexed by public hostname, one query per host.
 *
 * Env: ONEDOLLAR_BACKEND_API_KEY. Unset (or any failure) = null, and the UI
 * renders "—" for pageviews instead of a wrong zero.
 */

import { getSettings } from "../settings";

const API = "https://deco.lilstts.com";

interface PlausibleResponse {
  results?: { dimensions: string[]; metrics: number[] }[];
}

/**
 * Daily pageviews summed across `hostnames`, as date ("YYYY-MM-DD") → count.
 * Null when unconfigured or when every host query failed — the caller must
 * distinguish "no data source" from "zero pageviews".
 */
export async function dailyPageviews(
  hostnames: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, number> | null> {
  const apiKey = getSettings().oneDollarStatsApiKey;
  if (!apiKey || hostnames.length === 0) return null;

  const results = await Promise.allSettled(
    hostnames.map(async (hostname) => {
      const res = await fetch(`${API}/plausible`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        body: JSON.stringify({
          site_id: hostname,
          date_range: [startDate, endDate],
          metrics: ["pageviews"],
          dimensions: ["time:day"],
          pagination: { limit: 10000, offset: 0 },
        }),
      });
      if (!res.ok) {
        throw new Error(`OneDollarStats ${res.status}`);
      }
      return ((await res.json()) as PlausibleResponse).results ?? [];
    }),
  );

  if (results.every((r) => r.status === "rejected")) {
    console.warn("[deco-legacy] every OneDollarStats host query failed");
    return null;
  }

  const byDate = new Map<string, number>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value) {
      // Normalize "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DD".
      const date = row.dimensions[0]?.split(" ")[0];
      if (!date) continue;
      byDate.set(date, (byDate.get(date) ?? 0) + (row.metrics[0] ?? 0));
    }
  }
  return byDate;
}

/**
 * OneDollarStats indexes custom domains by their `www.` hostname while the
 * warehouse stores the bare domain; `.deco.site` subdomains are used as-is.
 */
export function toOneDollarHostname(host: string): string {
  return host.endsWith(".deco.site") ? host : `www.${host}`;
}
