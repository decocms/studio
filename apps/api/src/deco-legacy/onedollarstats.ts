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
const REQUEST_TIMEOUT_MS = 10_000;
/** Hosts queried at once. Each is a separate POST to a third party. */
const CONCURRENCY = 6;

interface PlausibleResponse {
  results?: { dimensions: string[]; metrics: number[] }[];
}

export type PageviewRows = { dimensions: string[]; metrics: number[] }[];

/**
 * Sum per-host daily rows into date ("YYYY-MM-DD") → pageviews.
 *
 * Null if ANY host failed: these feed the requests-per-pageview ratio the page
 * bills on, and a silently undercounted denominator is worse than "—".
 */
export function mergePageviews(
  results: PromiseSettledResult<PageviewRows>[],
): Map<string, number> | null {
  if (results.some((r) => r.status === "rejected")) {
    console.warn("[deco-legacy] a OneDollarStats host query failed");
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
 * Daily pageviews summed across `hostnames`, as date ("YYYY-MM-DD") → count.
 * Null when unconfigured or when any host query failed — the caller must
 * distinguish "no data source" from "zero pageviews".
 */
export async function dailyPageviews(
  hostnames: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, number> | null> {
  const apiKey = getSettings().oneDollarStatsApiKey;
  // Two warehouse hosts can map to one OneDollarStats site — dedupe or double-count.
  const hosts = [...new Set(hostnames)];
  if (!apiKey || hosts.length === 0) return null;

  const queryHost = async (hostname: string): Promise<PageviewRows> => {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OneDollarStats ${res.status}`);
    }
    return ((await res.json()) as PlausibleResponse).results ?? [];
  };

  const results: PromiseSettledResult<PageviewRows>[] = [];
  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    results.push(
      ...(await Promise.allSettled(
        hosts.slice(i, i + CONCURRENCY).map(queryHost),
      )),
    );
  }
  return mergePageviews(results);
}

/**
 * OneDollarStats indexes custom domains by their `www.` hostname while the
 * warehouse stores the bare domain; `.deco.site` subdomains are used as-is,
 * and a host already carrying `www.` is left alone.
 */
export function toOneDollarHostname(host: string): string {
  if (host.endsWith(".deco.site") || host.startsWith("www.")) return host;
  return `www.${host}`;
}
