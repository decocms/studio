/**
 * Monitor API Route (per-site CDN / edge analytics, read straight from the
 * stats-lake ClickHouse warehouse)
 *
 * This is the native, first-class replacement for the old deco.cx admin
 * "Monitor" surface, which Studio used to embed as an MCP-UI iframe (a pinned
 * view pointing at the deco.cx admin MCP's `get_monitor_data`). That path — the
 * deco.cx connection and its Supabase-resolved hostnames — is being retired.
 *
 * How this differs from `hosting.ts` (the control-plane BFF proxy):
 *   - There is NO control-plane hop and NO Supabase. The CDN facts live in the
 *     stats-lake ClickHouse warehouse, which Studio already reaches read-only
 *     through `deco-legacy/clickhouse-analytics.ts` (env `CLICKHOUSE_ANALYTICS_*`,
 *     the same warehouse the Infra Billing page bills on).
 *   - A site is scoped by its SLUG, resolved to a numeric `site_id` INSIDE
 *     ClickHouse via `dim_sites` (exact `name` match — never the stats-lake MCP's
 *     `ILIKE '%...%'`, which would bleed across similarly-named sites). This is
 *     the same slug→`site_id` bridge `infra-billing.ts` already uses, so no
 *     Supabase lookup is needed at request time.
 *
 * Tenancy is enforced exactly like the Hosting/Analytics tabs: the org is
 * resolved server-side from the authenticated `:org` path param, and the BFF
 * refuses any slug the org does not own in Studio's own `org_sites` table
 * (404, indistinguishable from a non-existent slug). The ClickHouse credentials
 * never reach the browser.
 *
 * Unlike Deco Analytics (internal, behind an org flag), this surface is GA: any
 * org that owns the site sees it. Visibility is gated on `monitorEnabled`
 * (public config — the warehouse is wired) AND ownership, not on the
 * control-plane being wired.
 *
 * Required env vars (see settings/resolve-config.ts and
 * deco-legacy/clickhouse-analytics.ts):
 *   CLICKHOUSE_ANALYTICS_ADDRESS   – stats-lake warehouse HTTP URL
 *   CLICKHOUSE_ANALYTICS_USERNAME  – read-only user (default "admin_monitor")
 *   CLICKHOUSE_ANALYTICS_PASSWORD  – its password
 * When unset, the routes return 503 and the tab stays hidden.
 */

import { Hono } from "hono";
import type { StudioContext } from "../../core/studio-context";
import { requireOrganization } from "../../core/studio-context";
import {
  analyticsQuery,
  isAnalyticsConfigured,
} from "../../deco-legacy/clickhouse-analytics";

type Variables = { studioContext: StudioContext };

/** The CDN views the customer-facing tab may ask for. */
const CDN_VIEWS = new Set([
  "summary",
  "timeline",
  "cache-status",
  "status-codes",
  "top-paths",
  "top-countries",
]);

/** Range → lookback window + bucket granularity. `24h` is the only hourly
 *  window (realtime-ish); everything else rolls up daily. Kept small and
 *  explicit — a client-supplied value outside this set is rejected. */
const RANGE_TO_WINDOW: Record<
  string,
  { days: number; granularity: "hourly" | "daily" }
> = {
  "24h": { days: 1, granularity: "hourly" },
  "7d": { days: 7, granularity: "daily" },
  "14d": { days: 14, granularity: "daily" },
  "30d": { days: 30, granularity: "daily" },
  "90d": { days: 90, granularity: "daily" },
};

/** Format a Date as ClickHouse `Date` literal (UTC `YYYY-MM-DD`). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve [since, until] Date strings for a lookback window (inclusive). */
function windowDates(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  return { since: toIsoDate(since), until: toIsoDate(until) };
}

/**
 * A site is scoped to its numeric `site_id`s resolved from the slug inside
 * ClickHouse. Exact `name =` match (not ILIKE): a customer's tab must never
 * pick up another site whose name merely contains this slug.
 */
const SITE_SCOPE =
  "site_id IN (SELECT id FROM default.dim_sites WHERE name = {slug:String})";

/**
 * Busiest distinct origin hosts for this site — the only key the shared-infra
 * facts carry (they have no `site_id`). Mirrors infra-billing's `siteHostnames`.
 * Bounded so a pathological site can't fan out an unbounded `IN` list.
 */
async function siteHostnames(
  slug: string,
  since: string,
  until: string,
): Promise<string[]> {
  const rows = await analyticsQuery<{ host: string }>(
    `SELECT host
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY host
      ORDER BY sum(requests) DESC
      LIMIT 25`,
    { slug, since, until },
  );
  return rows.map((r) => r.host).filter(Boolean);
}

export interface CdnSummary {
  total_requests: number;
  total_bandwidth_bytes: number;
  cache_hit_ratio: number;
  avg_latency_ms: number;
  status_2xx_count: number;
  status_4xx_count: number;
  status_5xx_count: number;
  unique_countries: number;
  /** Pageviews over the range, joined from the analytics facts so the tab can
   *  show the hybrid Requests/Pageview and Bandwidth/10k-Pageviews cards the old
   *  admin Monitor showed. */
  pageviews: number;
}

/** Pageviews for a site over a window, from the analytics facts. */
async function queryPageviews(
  slug: string,
  since: string,
  until: string,
): Promise<number> {
  const [row] = await analyticsQuery<{ pageviews: number }>(
    `SELECT sumIf(events, type = 'PageView') AS pageviews
       FROM default.fact_analytics_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}`,
    { slug, since, until },
  );
  return Number(row?.pageviews ?? 0);
}

/**
 * Headline cards. Merges the site's own CDN facts with its shared-infra facts
 * (attributable only through origin hosts), exactly like the admin's
 * MONITOR_SUMMARY, so the totals match what the old Monitor showed.
 */
async function querySummary(
  slug: string,
  since: string,
  until: string,
): Promise<CdnSummary> {
  const [hostnames, pageviews] = await Promise.all([
    siteHostnames(slug, since, until),
    queryPageviews(slug, since, until),
  ]);

  const [main] = await analyticsQuery<
    CdnSummary & { cache_hit_requests: number }
  >(
    `SELECT
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes,
        sum(if(cache_status = 'hit', requests, 0)) AS cache_hit_requests,
        avgIf(upstream_latency_ms, upstream_latency_ms > 0) AS avg_latency_ms,
        sum(if(status_code >= 200 AND status_code < 300, requests, 0)) AS status_2xx_count,
        sum(if(status_code >= 400 AND status_code < 500, requests, 0)) AS status_4xx_count,
        sum(if(status_code >= 500, requests, 0)) AS status_5xx_count,
        uniq(country) AS unique_countries
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}`,
    { slug, since, until },
  );

  const shared = hostnames.length
    ? (
        await analyticsQuery<{
          total_requests: number;
          total_bandwidth_bytes: number;
          cache_hit_requests: number;
        }>(
          `SELECT
              sum(requests) AS total_requests,
              sum(bandwidth_bytes) AS total_bandwidth_bytes,
              sum(if(cache_status = 'hit', requests, 0)) AS cache_hit_requests
             FROM default.fact_shared_infra_usage_daily_view
            WHERE origin_host IN {hostnames:Array(String)}
              AND date >= {since:Date} AND date <= {until:Date}`,
          { hostnames, since, until },
        )
      )[0]
    : undefined;

  const totalRequests =
    Number(main?.total_requests ?? 0) + Number(shared?.total_requests ?? 0);
  const cacheHits =
    Number(main?.cache_hit_requests ?? 0) +
    Number(shared?.cache_hit_requests ?? 0);

  return {
    total_requests: totalRequests,
    total_bandwidth_bytes:
      Number(main?.total_bandwidth_bytes ?? 0) +
      Number(shared?.total_bandwidth_bytes ?? 0),
    cache_hit_ratio: totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0,
    avg_latency_ms: Number(main?.avg_latency_ms ?? 0),
    status_2xx_count: Number(main?.status_2xx_count ?? 0),
    status_4xx_count: Number(main?.status_4xx_count ?? 0),
    status_5xx_count: Number(main?.status_5xx_count ?? 0),
    unique_countries: Number(main?.unique_countries ?? 0),
    pageviews,
  };
}

export interface CdnTimelinePoint {
  bucket: string;
  requests: number;
  bandwidth_bytes: number;
  pageviews: number;
  cache_hit_ratio: number;
}

/** Usage over time. Hourly buckets for 24h, daily otherwise. Pageviews are
 *  daily-only in the analytics facts, so they merge by date for daily ranges and
 *  are 0 on hourly (24h) buckets — the chart still carries requests/bandwidth. */
async function queryTimeline(
  slug: string,
  since: string,
  until: string,
  granularity: "hourly" | "daily",
): Promise<CdnTimelinePoint[]> {
  const view =
    granularity === "hourly"
      ? "default.fact_usage_hourly_view"
      : "default.fact_usage_daily_view";
  const timeCol = granularity === "hourly" ? "utc_hour" : "date";
  const dateCmp = granularity === "hourly" ? `toDate(${timeCol})` : timeCol;

  // Aliases must NOT collide with the source column names (`requests`,
  // `bandwidth_bytes`): if they do, ClickHouse resolves the later `requests`
  // reference to the aggregate alias and nests sum() inside sum()
  // (ILLEGAL_AGGREGATION, code 184).
  const rows = await analyticsQuery<{
    bucket: string;
    requests_total: number;
    bandwidth_total: number;
    cache_hits: number;
  }>(
    `SELECT
        toString(${timeCol}) AS bucket,
        sum(requests) AS requests_total,
        sum(bandwidth_bytes) AS bandwidth_total,
        sum(if(cache_status = 'hit', requests, 0)) AS cache_hits
       FROM ${view}
      WHERE ${SITE_SCOPE}
        AND ${dateCmp} >= {since:Date} AND ${dateCmp} <= {until:Date}
      GROUP BY ${timeCol}
      ORDER BY ${timeCol} ASC`,
    { slug, since, until },
  );

  // Pageviews are daily; map them onto matching daily buckets.
  const pvByDate = new Map<string, number>();
  if (granularity === "daily") {
    const pvRows = await analyticsQuery<{ bucket: string; pageviews: number }>(
      `SELECT toString(date) AS bucket,
              sumIf(events, type = 'PageView') AS pageviews
         FROM default.fact_analytics_daily_view
        WHERE ${SITE_SCOPE}
          AND date >= {since:Date} AND date <= {until:Date}
        GROUP BY date`,
      { slug, since, until },
    );
    for (const r of pvRows) pvByDate.set(r.bucket, Number(r.pageviews));
  }

  return rows.map((r) => ({
    bucket: r.bucket,
    requests: Number(r.requests_total),
    bandwidth_bytes: Number(r.bandwidth_total),
    pageviews: pvByDate.get(r.bucket) ?? 0,
    cache_hit_ratio:
      Number(r.requests_total) > 0
        ? (Number(r.cache_hits) / Number(r.requests_total)) * 100
        : 0,
  }));
}

export interface CdnBreakdownRow {
  key: string;
  total_requests: number;
  total_bandwidth_bytes: number;
}

/** Cache-status distribution (hit / miss / expired / stale / dynamic / ...). */
async function queryCacheStatus(
  slug: string,
  since: string,
  until: string,
): Promise<CdnBreakdownRow[]> {
  const rows = await analyticsQuery<{
    cache_status: string;
    total_requests: number;
    total_bandwidth_bytes: number;
  }>(
    `SELECT
        cache_status,
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY cache_status
      ORDER BY total_requests DESC`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    key: r.cache_status,
    total_requests: Number(r.total_requests),
    total_bandwidth_bytes: Number(r.total_bandwidth_bytes),
  }));
}

/** HTTP status-code distribution. */
async function queryStatusCodes(
  slug: string,
  since: string,
  until: string,
): Promise<CdnBreakdownRow[]> {
  const rows = await analyticsQuery<{
    status_code: number;
    total_requests: number;
    total_bandwidth_bytes: number;
  }>(
    `SELECT
        status_code,
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY status_code
      ORDER BY total_requests DESC`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    key: String(r.status_code),
    total_requests: Number(r.total_requests),
    total_bandwidth_bytes: Number(r.total_bandwidth_bytes),
  }));
}

/** Top paths/URLs by requests. */
async function queryTopPaths(
  slug: string,
  since: string,
  until: string,
): Promise<CdnBreakdownRow[]> {
  const rows = await analyticsQuery<{
    url: string;
    total_requests: number;
    total_bandwidth_bytes: number;
  }>(
    `SELECT
        url,
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes
       FROM default.fact_top_urls_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY url
      ORDER BY total_requests DESC
      LIMIT 50`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    key: r.url,
    total_requests: Number(r.total_requests),
    total_bandwidth_bytes: Number(r.total_bandwidth_bytes),
  }));
}

/** Top countries by requests. */
async function queryTopCountries(
  slug: string,
  since: string,
  until: string,
): Promise<CdnBreakdownRow[]> {
  const rows = await analyticsQuery<{
    country: string;
    total_requests: number;
    total_bandwidth_bytes: number;
  }>(
    `SELECT
        country,
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes
       FROM default.fact_usage_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY country
      ORDER BY total_requests DESC
      LIMIT 50`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    key: r.country,
    total_requests: Number(r.total_requests),
    total_bandwidth_bytes: Number(r.total_bandwidth_bytes),
  }));
}

// --- Audience (the OneDollar-equivalent, native from the analytics facts) ---
//
// `fact_analytics_daily_view` carries the pageview/visitor facts the old admin
// Monitor's "Analytics" tab used to read from the OneDollarStats widget. Reading
// them here makes that half native too — no third-party widget, no legacy path.

/** The audience views the customer-facing tab may ask for. */
const AUDIENCE_VIEWS = new Set([
  "summary",
  "timeline",
  "top-sources",
  "top-countries",
  "devices",
]);

export interface AudienceSummary {
  pageviews: number;
  visitors: number;
  sessions: number;
}

/** Headline audience cards. NOTE: `visitors`/`sessions` sum the per-day unique
 *  counts, so they are visitor-days, not distinct-over-the-range uniques (the
 *  facts carry no mergeable uniq state). Pageviews is exact. */
async function queryAudienceSummary(
  slug: string,
  since: string,
  until: string,
): Promise<AudienceSummary> {
  const [row] = await analyticsQuery<AudienceSummary>(
    `SELECT
        sumIf(events, type = 'PageView') AS pageviews,
        sum(unique_visitors) AS visitors,
        sum(unique_sessions) AS sessions
       FROM default.fact_analytics_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}`,
    { slug, since, until },
  );
  return {
    pageviews: Number(row?.pageviews ?? 0),
    visitors: Number(row?.visitors ?? 0),
    sessions: Number(row?.sessions ?? 0),
  };
}

export interface AudienceTimelinePoint {
  bucket: string;
  pageviews: number;
  visitors: number;
}

async function queryAudienceTimeline(
  slug: string,
  since: string,
  until: string,
): Promise<AudienceTimelinePoint[]> {
  const rows = await analyticsQuery<{
    bucket: string;
    pageviews: number;
    visitors: number;
  }>(
    `SELECT
        toString(date) AS bucket,
        sumIf(events, type = 'PageView') AS pageviews,
        sum(unique_visitors) AS visitors
       FROM default.fact_analytics_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY date
      ORDER BY date ASC`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    pageviews: Number(r.pageviews),
    visitors: Number(r.visitors),
  }));
}

export interface AudienceBreakdownRow {
  key: string;
  pageviews: number;
  visitors: number;
}

/** Pageview/visitor breakdown grouped by one dimension (source/country/device). */
async function queryAudienceBreakdown(
  slug: string,
  since: string,
  until: string,
  dimension: "utm_source" | "country" | "device_type",
): Promise<AudienceBreakdownRow[]> {
  const rows = await analyticsQuery<{
    key: string;
    pageviews: number;
    visitors: number;
  }>(
    `SELECT
        ${dimension} AS key,
        sumIf(events, type = 'PageView') AS pageviews,
        sum(unique_visitors) AS visitors
       FROM default.fact_analytics_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}
      GROUP BY ${dimension}
      ORDER BY pageviews DESC
      LIMIT 50`,
    { slug, since, until },
  );
  return rows.map((r) => ({
    key: r.key,
    pageviews: Number(r.pageviews),
    visitors: Number(r.visitors),
  }));
}

/**
 * Org-scoped monitor routes mounted at `/api/:org/monitor`. Direct-ClickHouse
 * reads, tenancy via `org_sites`, no control-plane and no Supabase.
 */
export const createMonitorRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  // GET /api/:org/monitor/:site/cdn/data?view=&range= — one CDN view, tenant
  // scoped. `{ available:false }` (not an error) when the warehouse isn't wired
  // so the tab can show a configuration/empty state instead of failing.
  app.get("/:site/cdn/data", async (c) => {
    const ctx = c.get("studioContext");
    const org = requireOrganization(ctx);
    const site = c.req.param("site");
    if (!site) return c.json({ error: "site is required" }, 400);

    // Same ownership guard as the Hosting/Analytics tabs: the org must own this
    // slug. 404 (not 403) so an unowned slug looks like a non-existent one.
    const owned = await ctx.storage.orgSites.isOwnedBy(
      site.toLowerCase(),
      org.id,
    );
    if (!owned) {
      return c.json({ error: "Site not found in organization" }, 404);
    }

    if (!isAnalyticsConfigured()) {
      return c.json({ available: false, error: "Monitor is not configured" });
    }

    const view = c.req.query("view") ?? "summary";
    if (!CDN_VIEWS.has(view)) {
      return c.json({ error: `unknown or unavailable view: ${view}` }, 400);
    }
    const range = c.req.query("range") ?? "7d";
    const window = RANGE_TO_WINDOW[range];
    if (!window) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }

    // The slug is the ClickHouse `dim_sites.name`; queries resolve the numeric
    // site_id from it. Lower-cased to match the ownership check and how slugs
    // are stored.
    const slug = site.toLowerCase();
    const { since, until } = windowDates(window.days);

    try {
      let data: unknown;
      switch (view) {
        case "summary":
          data = await querySummary(slug, since, until);
          break;
        case "timeline":
          data = await queryTimeline(slug, since, until, window.granularity);
          break;
        case "cache-status":
          data = await queryCacheStatus(slug, since, until);
          break;
        case "status-codes":
          data = await queryStatusCodes(slug, since, until);
          break;
        case "top-paths":
          data = await queryTopPaths(slug, since, until);
          break;
        case "top-countries":
          data = await queryTopCountries(slug, since, until);
          break;
      }
      return c.json({ available: true, view, range, data });
    } catch (err) {
      console.error(
        `[monitor] cdn ${view} query failed for site="${slug}":`,
        err,
      );
      return c.json({ error: "Failed to query monitor warehouse" }, 502);
    }
  });

  // GET /api/:org/monitor/:site/audience/data?view=&range= — the pageview /
  // visitor half (the native replacement for the old admin's OneDollarStats
  // "Analytics" tab). Same tenancy guard and shape as the CDN handler.
  app.get("/:site/audience/data", async (c) => {
    const ctx = c.get("studioContext");
    const org = requireOrganization(ctx);
    const site = c.req.param("site");
    if (!site) return c.json({ error: "site is required" }, 400);

    const owned = await ctx.storage.orgSites.isOwnedBy(
      site.toLowerCase(),
      org.id,
    );
    if (!owned) {
      return c.json({ error: "Site not found in organization" }, 404);
    }

    if (!isAnalyticsConfigured()) {
      return c.json({ available: false, error: "Monitor is not configured" });
    }

    const view = c.req.query("view") ?? "summary";
    if (!AUDIENCE_VIEWS.has(view)) {
      return c.json({ error: `unknown or unavailable view: ${view}` }, 400);
    }
    const range = c.req.query("range") ?? "7d";
    const window = RANGE_TO_WINDOW[range];
    if (!window) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }

    const slug = site.toLowerCase();
    const { since, until } = windowDates(window.days);

    try {
      let data: unknown;
      switch (view) {
        case "summary":
          data = await queryAudienceSummary(slug, since, until);
          break;
        case "timeline":
          data = await queryAudienceTimeline(slug, since, until);
          break;
        case "top-sources":
          data = await queryAudienceBreakdown(slug, since, until, "utm_source");
          break;
        case "top-countries":
          data = await queryAudienceBreakdown(slug, since, until, "country");
          break;
        case "devices":
          data = await queryAudienceBreakdown(
            slug,
            since,
            until,
            "device_type",
          );
          break;
      }
      return c.json({ available: true, view, range, data });
    } catch (err) {
      console.error(
        `[monitor] audience ${view} query failed for site="${slug}":`,
        err,
      );
      return c.json({ error: "Failed to query monitor warehouse" }, 502);
    }
  });

  return app;
};
