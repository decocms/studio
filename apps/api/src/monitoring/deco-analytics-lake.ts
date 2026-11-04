/**
 * Deco Analytics views from the org's customer lake, in the read surface's
 * payload keys, for a Studio without the read surface. The lake holds hourly
 * rollups (`site_traffic_hourly`, `site_dims_hourly`), so only `overview`,
 * `behaviour` and `events` have data: sessions, bounce, duration, the funnel,
 * live, vitals and the heatmap stay absent, and segment filters aren't applied
 * because each dimension is its own aggregate. Read as the org's own lake user,
 * so the row policy limits it to the org's sites.
 */

import { queryCustomerLake } from "../customer-lake/client";

/** Hours each read-surface range covers; sub-hour ranges read the current hour. */
const RANGE_HOURS: Record<string, number> = {
  "5m": 1,
  "15m": 1,
  "30m": 1,
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

/** Payload key → lake dimension, per view. */
const RANKED: Record<string, Record<string, string>> = {
  overview: { sources: "sourceDomain" },
  behaviour: {
    pages: "path",
    sources: "sourceDomain",
    channels: "channel",
    campaigns: "utmCampaign",
    devices: "device",
    os: "os",
    browser: "browser",
    countries: "country",
  },
  events: { events: "name" },
};

/** The segment's filter dimensions the lake has, by the read surface's name. */
const FILTER_DIMS: Record<string, string> = {
  path: "path",
  source: "sourceDomain",
  channel: "channel",
  utmSource: "utmSource",
  utmMedium: "utmMedium",
  utmCampaign: "utmCampaign",
  country: "country",
  device: "device",
  browser: "browser",
  os: "os",
  name: "name",
};

/** What a ranked row counts: pages rank by pageviews, events by count. */
const COUNT = `multiIf(dim = 'path', sum(pageviews), dim = 'name', sum(events), uniqMerge(visitors))`;

/** `YYYY-MM-DD HH:00:00`, the lake's hour as a DateTime parameter. */
function hourLiteral(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13).replace("T", " ") + ":00:00";
}

/** The range as hour bounds ending with the current hour, and the window of
 *  equal length before it. Null for a range the read surface doesn't have. */
export function lakeWindow(
  range: string,
  now = Date.now(),
): { from: string; prevFrom: string; hours: number } | null {
  const hours = RANGE_HOURS[range];
  if (!hours) return null;
  const hour = 3_600_000;
  const current = Math.floor(now / hour) * hour;
  const from = current - (hours - 1) * hour;
  return {
    from: hourLiteral(from),
    prevFrom: hourLiteral(from - hours * hour),
    hours,
  };
}

/** The share of the previous window the lake has rows for, from its first
 *  hour: below 1 the comparison is partial and the UI says so. */
export function previousCoverage(
  first: string | null,
  win: { from: string; prevFrom: string },
): number {
  if (!first) return 0;
  const at = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`);
  const from = at(win.from);
  const prevFrom = at(win.prevFrom);
  const start = Math.max(at(first), prevFrom);
  return start >= from ? 0 : (from - start) / (from - prevFrom);
}

async function ranked(
  organizationId: string,
  params: Record<string, unknown>,
  keys: Record<string, string>,
): Promise<Record<string, { k: string; n: number }[]>> {
  const rows = await queryCustomerLake(
    organizationId,
    `SELECT dim, value AS k, ${COUNT} AS n
     FROM customer_lake.site_dims_hourly FINAL
     WHERE site_id = {site:String} AND hour >= {from:DateTime} AND dim IN {dims:Array(String)}
     GROUP BY dim, value ORDER BY dim, n DESC LIMIT 20 BY dim`,
    { ...params, dims: Object.values(keys) },
  );
  const out: Record<string, { k: string; n: number }[]> = {};
  for (const [key, dim] of Object.entries(keys)) {
    out[key] = rows
      .filter((r) => r.dim === dim)
      .map((r) => ({ k: String(r.k), n: Number(r.n) }));
  }
  return out;
}

async function overview(
  organizationId: string,
  params: Record<string, unknown>,
  win: { from: string; prevFrom: string; hours: number },
): Promise<Record<string, unknown>> {
  const bucket =
    win.hours <= 24
      ? "formatDateTime(hour, '%Y-%m-%d %H:00:00')"
      : "toString(toDate(hour))";
  const [[k], series] = await Promise.all([
    queryCustomerLake(
      organizationId,
      `SELECT
         uniqMergeIf(visitors, hour >= {from:DateTime}) AS c_visitors,
         sumIf(pageviews, hour >= {from:DateTime}) AS c_pageviews,
         sumIf(events, hour >= {from:DateTime}) AS c_events,
         uniqMergeIf(visitors, hour < {from:DateTime}) AS p_visitors,
         sumIf(pageviews, hour < {from:DateTime}) AS p_pageviews,
         sumIf(events, hour < {from:DateTime}) AS p_events,
         if(count() = 0, NULL, toString(min(hour))) AS first
       FROM customer_lake.site_traffic_hourly FINAL
       WHERE site_id = {site:String} AND hour >= {prevFrom:DateTime}`,
      params,
    ),
    queryCustomerLake(
      organizationId,
      `SELECT ${bucket} AS t, uniqMerge(visitors) AS visitors,
         sum(pageviews) AS pageviews, sum(events) AS events
       FROM customer_lake.site_traffic_hourly FINAL
       WHERE site_id = {site:String} AND hour >= {from:DateTime}
       GROUP BY t ORDER BY t`,
      params,
    ),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    kpis: [
      {
        visitors: n(k?.c_visitors),
        pageviews: n(k?.c_pageviews),
        events: n(k?.c_events),
      },
    ],
    kpisPrev: [
      {
        visitors: n(k?.p_visitors),
        pageviews: n(k?.p_pageviews),
        events: n(k?.p_events),
        covered: previousCoverage(
          typeof k?.first === "string" ? k.first : null,
          win,
        ),
      },
    ],
    series: series.map((r) => ({
      t: String(r.t),
      visitors: n(r.visitors),
      pageviews: n(r.pageviews),
      events: n(r.events),
    })),
    ...(await ranked(organizationId, params, RANKED.overview ?? {})),
  };
}

/** One view's payload, or `{}` for a view the lake has nothing for. */
export async function loadLakeAnalyticsView(
  organizationId: string,
  siteId: string,
  view: string,
  win: { from: string; prevFrom: string; hours: number },
): Promise<Record<string, unknown>> {
  const params = { site: siteId, from: win.from, prevFrom: win.prevFrom };
  if (view === "overview") return overview(organizationId, params, win);
  const keys = RANKED[view];
  return keys ? ranked(organizationId, params, keys) : {};
}

/** The values a filter dimension holds in the window, busiest first. Empty for
 *  a dimension the lake doesn't keep (region, city, prop, exp, flag). */
export async function loadLakeFilterValues(
  organizationId: string,
  siteId: string,
  dim: string,
  win: { from: string },
): Promise<{ k: string; n: number }[]> {
  const lakeDim = FILTER_DIMS[dim];
  if (!lakeDim) return [];
  const rows = await queryCustomerLake(
    organizationId,
    `SELECT value AS k, uniqMerge(visitors) AS n
     FROM customer_lake.site_dims_hourly FINAL
     WHERE site_id = {site:String} AND hour >= {from:DateTime} AND dim = {dim:String}
     GROUP BY value ORDER BY n DESC LIMIT 50`,
    { site: siteId, from: win.from, dim: lakeDim },
  );
  return rows.map((r) => ({ k: String(r.k), n: Number(r.n) }));
}
