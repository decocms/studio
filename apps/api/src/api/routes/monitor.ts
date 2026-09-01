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
import {
  isAuthenticated,
  requireOrganization,
} from "../../core/studio-context";
import { getSettings } from "../../settings";
import {
  analyticsQuery,
  isAnalyticsConfigured,
} from "../../deco-legacy/clickhouse-analytics";
import { toOneDollarHostname } from "../../deco-legacy/onedollarstats";

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

/** Preset range → lookback window + bucket granularity, matching the old
 *  admin's date dropdown. Sub-week windows bucket hourly; the rest daily. A
 *  `custom` range (explicit since/until) is resolved separately. */
const RANGE_TO_WINDOW: Record<
  string,
  { days: number; granularity: "hourly" | "daily" }
> = {
  "60m": { days: 1, granularity: "hourly" },
  today: { days: 1, granularity: "hourly" },
  yesterday: { days: 2, granularity: "hourly" },
  "24h": { days: 1, granularity: "hourly" },
  "48h": { days: 2, granularity: "hourly" },
  "72h": { days: 3, granularity: "hourly" },
  "7d": { days: 7, granularity: "daily" },
  "14d": { days: 14, granularity: "daily" },
  "30d": { days: 30, granularity: "daily" },
  "90d": { days: 90, granularity: "daily" },
  "180d": { days: 180, granularity: "daily" },
  "1y": { days: 365, granularity: "daily" },
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a range selection to a concrete window. `custom` reads validated
 * `since`/`until` (YYYY-MM-DD); otherwise a preset from RANGE_TO_WINDOW. Returns
 * null for an unknown preset or a malformed custom range so the caller 400s.
 */
function resolveWindow(
  range: string,
  sinceQ: string | undefined,
  untilQ: string | undefined,
): {
  since: string;
  until: string;
  granularity: "hourly" | "daily";
  days: number;
} | null {
  if (range === "custom") {
    if (
      !sinceQ ||
      !untilQ ||
      !ISO_DATE.test(sinceQ) ||
      !ISO_DATE.test(untilQ)
    ) {
      return null;
    }
    const days = Math.max(
      1,
      Math.round((Date.parse(untilQ) - Date.parse(sinceQ)) / 86400000),
    );
    return {
      since: sinceQ,
      until: untilQ,
      granularity: days <= 2 ? "hourly" : "daily",
      days,
    };
  }
  const w = RANGE_TO_WINDOW[range];
  if (!w) return null;
  const { since, until } = windowDates(w.days);
  return { since, until, granularity: w.granularity, days: w.days };
}

/**
 * A site is scoped to its numeric `site_id`s resolved from the slug inside
 * ClickHouse. Exact `name =` match (not ILIKE): a customer's tab must never
 * pick up another site whose name merely contains this slug.
 */
const SITE_SCOPE =
  "site_id IN (SELECT id FROM default.dim_sites WHERE name = {slug:String})";

// --- Filters (the "Add filter" builder: field / operator / value) ------------

export interface MonitorFilter {
  field: string;
  op: "equals" | "not_equals" | "contains" | "not_contains";
  value: string;
}

/** Parse the `filters` query param (URL-encoded JSON array). Silently drops
 *  malformed entries — a bad filter must never 500 the dashboard. */
function parseFilters(raw: string | undefined): MonitorFilter[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f) => f && typeof f.field === "string" && typeof f.op === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Build `AND col OP {param}` conditions for the filters whose column exists in
 * the view being queried (`opts`). `status_code` is numeric; the rest are
 * strings. Values are always bound as parameters, never interpolated. Returns
 * the SQL fragment plus the params to merge into `query_params`.
 */
function cdnFilterSql(
  filters: MonitorFilter[],
  opts: { hasUrl: boolean; hasCountry: boolean },
): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  (filters ?? []).forEach((f, i) => {
    const col =
      f.field === "cache_status"
        ? "cache_status"
        : f.field === "status_code"
          ? "status_code"
          : f.field === "country"
            ? opts.hasCountry
              ? "country"
              : null
            : f.field === "path"
              ? opts.hasUrl
                ? "url"
                : null
              : null;
    if (!col) return;
    const p = `flt${i}`;
    const numeric = f.field === "status_code";
    if (f.op === "equals" || f.op === "not_equals") {
      const type = numeric ? "UInt32" : "String";
      params[p] = numeric ? Number(f.value) : f.value;
      parts.push(`AND ${col} ${f.op === "equals" ? "=" : "!="} {${p}:${type}}`);
    } else {
      // contains / not_contains — always string ILIKE.
      params[p] = `%${f.value}%`;
      parts.push(
        `AND toString(${col}) ${
          f.op === "contains" ? "ILIKE" : "NOT ILIKE"
        } {${p}:String}`,
      );
    }
  });
  return { sql: parts.length ? ` ${parts.join(" ")}` : "", params };
}

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
  filters: MonitorFilter[],
): Promise<CdnSummary> {
  const flt = cdnFilterSql(filters, { hasUrl: false, hasCountry: true });
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
        AND date >= {since:Date} AND date <= {until:Date}${flt.sql}`,
    { slug, since, until, ...flt.params },
  );

  // Shared-infra facts have no per-request dimensions to filter on, so a filtered
  // view drops them (matches the admin skipping shared-infra under filters).
  const shared =
    !filters.length && hostnames.length
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
  filters: MonitorFilter[],
): Promise<CdnTimelinePoint[]> {
  const flt = cdnFilterSql(filters, { hasUrl: false, hasCountry: true });
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
        AND ${dateCmp} >= {since:Date} AND ${dateCmp} <= {until:Date}${flt.sql}
      GROUP BY ${timeCol}
      ORDER BY ${timeCol} ASC`,
    { slug, since, until, ...flt.params },
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
  filters: MonitorFilter[],
): Promise<CdnBreakdownRow[]> {
  const flt = cdnFilterSql(filters, { hasUrl: false, hasCountry: true });
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
        AND date >= {since:Date} AND date <= {until:Date}${flt.sql}
      GROUP BY cache_status
      ORDER BY total_requests DESC`,
    { slug, since, until, ...flt.params },
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
  filters: MonitorFilter[],
): Promise<CdnBreakdownRow[]> {
  const flt = cdnFilterSql(filters, { hasUrl: false, hasCountry: true });
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
        AND date >= {since:Date} AND date <= {until:Date}${flt.sql}
      GROUP BY status_code
      ORDER BY total_requests DESC`,
    { slug, since, until, ...flt.params },
  );
  return rows.map((r) => ({
    key: String(r.status_code),
    total_requests: Number(r.total_requests),
    total_bandwidth_bytes: Number(r.total_bandwidth_bytes),
  }));
}

/** Top paths/URLs by requests. `groupByPath` strips the query string so
 *  `/p?a=1` and `/p?a=2` collapse into `/p` (the "Ignore query string" toggle). */
async function queryTopPaths(
  slug: string,
  since: string,
  until: string,
  groupByPath: boolean,
  filters: MonitorFilter[],
): Promise<CdnBreakdownRow[]> {
  const flt = cdnFilterSql(filters, { hasUrl: true, hasCountry: false });
  const urlExpr = groupByPath ? "splitByChar('?', url)[1]" : "url";
  const rows = await analyticsQuery<{
    url: string;
    total_requests: number;
    total_bandwidth_bytes: number;
  }>(
    `SELECT
        ${urlExpr} AS url,
        sum(requests) AS total_requests,
        sum(bandwidth_bytes) AS total_bandwidth_bytes
       FROM default.fact_top_urls_daily_view
      WHERE ${SITE_SCOPE}
        AND date >= {since:Date} AND date <= {until:Date}${flt.sql}
      GROUP BY url
      ORDER BY total_requests DESC
      LIMIT 50`,
    { slug, since, until, ...flt.params },
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
  filters: MonitorFilter[],
): Promise<CdnBreakdownRow[]> {
  const flt = cdnFilterSql(filters, { hasUrl: false, hasCountry: true });
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
        AND date >= {since:Date} AND date <= {until:Date}${flt.sql}
      GROUP BY country
      ORDER BY total_requests DESC
      LIMIT 50`,
    { slug, since, until, ...flt.params },
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

// --- OneDollarStats (Plausible-compatible) audience reports ------------------
//
// The full audience dashboard the old admin embedded as the `stonks-dashboard`
// widget — rendered NATIVELY here instead. Every panel is one Plausible v2 query
// against `deco.lilstts.com/plausible`, proxied server-side so the backend key
// (`ONEDOLLAR_BACKEND_API_KEY`) never reaches the browser. This is the interim
// source for the dimensions the warehouse doesn't carry (visit duration, bounce
// rate, referrers, pages-by-pageview, full UTM); it is meant to be swapped for
// Deco Analytics once that covers them, so the front reads normalized rows and
// doesn't care which backend produced them.

const OD_API = "https://deco.lilstts.com/plausible";
const OD_TIMEOUT_MS = 12_000;

/** report → the Plausible metrics/dimension/order that build it. */
const OD_REPORTS: Record<
  string,
  { metrics: string[]; dimension?: string; order?: string }
> = {
  kpis: {
    metrics: [
      "visitors",
      "visits",
      "pageviews",
      "bounce_rate",
      "visit_duration",
    ],
  },
  timeseries: {
    metrics: [
      "pageviews",
      "visits",
      "visitors",
      "bounce_rate",
      "visit_duration",
    ],
  },
  pages: {
    metrics: ["pageviews", "visitors"],
    dimension: "event:page",
    order: "pageviews",
  },
  sources: {
    metrics: ["visitors"],
    dimension: "visit:referrer",
    order: "visitors",
  },
  countries: {
    metrics: ["visitors"],
    dimension: "visit:country",
    order: "visitors",
  },
  browsers: {
    metrics: ["visitors"],
    dimension: "visit:browser",
    order: "visitors",
  },
  os: { metrics: ["visitors"], dimension: "visit:os", order: "visitors" },
  devices: {
    metrics: ["visitors"],
    dimension: "visit:device",
    order: "visitors",
  },
  events: {
    metrics: ["visitors", "events"],
    dimension: "event:name",
    order: "events",
  },
  utm_campaign: {
    metrics: ["visitors", "events"],
    dimension: "visit:utm_campaign",
    order: "events",
  },
  utm_source: {
    metrics: ["visitors", "events"],
    dimension: "visit:utm_source",
    order: "events",
  },
  utm_medium: {
    metrics: ["visitors", "events"],
    dimension: "visit:utm_medium",
    order: "events",
  },
  utm_content: {
    metrics: ["visitors", "events"],
    dimension: "visit:utm_content",
    order: "events",
  },
  utm_term: {
    metrics: ["visitors", "events"],
    dimension: "visit:utm_term",
    order: "events",
  },
};

interface OdResult {
  dimensions: string[];
  metrics: number[];
}

/** The site's hostnames as OneDollarStats indexes them (`www.` variant), busiest
 *  first — the values the audience host picker offers and the site_id queries
 *  run against. From the warehouse domain set (no Supabase). Deduped, so two
 *  warehouse hosts that map to the same OneDollar host collapse. */
async function siteOdHosts(slug: string): Promise<string[]> {
  const { since, until } = windowDates(90);
  const hosts = await siteHostnames(slug, since, until);
  return [...new Set(hosts.map(toOneDollarHostname))];
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
    // Require a principal: `resolveOrgFromPath` lets anonymous requests fall
    // through, so without this a known org+site slug would expose CDN/audience
    // analytics to anyone. Membership is proven upstream; ownership just below.
    if (!isAuthenticated(ctx)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
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
    const window = resolveWindow(
      range,
      c.req.query("since"),
      c.req.query("until"),
    );
    if (!window) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }

    // The slug is the ClickHouse `dim_sites.name`; queries resolve the numeric
    // site_id from it. Lower-cased to match the ownership check and how slugs
    // are stored.
    const slug = site.toLowerCase();
    const { since, until } = window;
    const filters = parseFilters(c.req.query("filters"));

    try {
      let data: unknown;
      switch (view) {
        case "summary":
          data = await querySummary(slug, since, until, filters);
          break;
        case "timeline":
          data = await queryTimeline(
            slug,
            since,
            until,
            window.granularity,
            filters,
          );
          break;
        case "cache-status":
          data = await queryCacheStatus(slug, since, until, filters);
          break;
        case "status-codes":
          data = await queryStatusCodes(slug, since, until, filters);
          break;
        case "top-paths":
          data = await queryTopPaths(
            slug,
            since,
            until,
            c.req.query("groupByPath") === "1",
            filters,
          );
          break;
        case "top-countries":
          data = await queryTopCountries(slug, since, until, filters);
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
    // Require a principal: `resolveOrgFromPath` lets anonymous requests fall
    // through, so without this a known org+site slug would expose CDN/audience
    // analytics to anyone. Membership is proven upstream; ownership just below.
    if (!isAuthenticated(ctx)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
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
    const window = resolveWindow(
      range,
      c.req.query("since"),
      c.req.query("until"),
    );
    if (!window) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }

    const slug = site.toLowerCase();
    const { since, until } = window;

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

  // GET /api/:org/monitor/:site/hosts — the site's hostnames (OneDollar site_id
  // candidates, busiest first) for the audience host picker. `{ available:false }`
  // when OneDollarStats isn't wired. The first entry is the default selection.
  app.get("/:site/hosts", async (c) => {
    const ctx = c.get("studioContext");
    // Require a principal: `resolveOrgFromPath` lets anonymous requests fall
    // through, so without this a known org+site slug would expose CDN/audience
    // analytics to anyone. Membership is proven upstream; ownership just below.
    if (!isAuthenticated(ctx)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
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
    // Hostnames come from the CDN warehouse, so this works whenever the
    // warehouse is wired — independent of OneDollarStats (the subtitle needs it
    // even on Performance-only deployments).
    if (!isAnalyticsConfigured()) {
      return c.json({ available: false, hosts: [] });
    }
    try {
      const hosts = await siteOdHosts(site.toLowerCase());
      return c.json({ available: true, hosts });
    } catch (err) {
      console.error(`[monitor] hosts failed for site="${site}":`, err);
      return c.json({ available: true, hosts: [] });
    }
  });

  // GET /api/:org/monitor/:site/onedollar?report=&range=&host= — one
  // OneDollarStats (Plausible) audience report, proxied so the backend key stays
  // server-side. The full old-admin Analytics dashboard, native: kpis (with a
  // previous-period comparison for trend deltas), timeseries, pages, sources,
  // countries, browsers, os, devices, events, utm_*. `host` picks which of the
  // site's hostnames to read; it is VALIDATED against the site's own host set so
  // a client can never name another tenant's site_id.
  app.get("/:site/onedollar", async (c) => {
    const ctx = c.get("studioContext");
    // Require a principal: `resolveOrgFromPath` lets anonymous requests fall
    // through, so without this a known org+site slug would expose CDN/audience
    // analytics to anyone. Membership is proven upstream; ownership just below.
    if (!isAuthenticated(ctx)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
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

    const apiKey = getSettings().oneDollarStatsApiKey;
    if (!apiKey) {
      return c.json({
        available: false,
        error: "OneDollarStats not configured",
      });
    }

    const report = c.req.query("report") ?? "kpis";
    const spec = OD_REPORTS[report];
    if (!spec) {
      return c.json({ error: `unknown report: ${report}` }, 400);
    }
    const range = c.req.query("range") ?? "7d";
    const window = resolveWindow(
      range,
      c.req.query("since"),
      c.req.query("until"),
    );
    if (!window) {
      return c.json({ error: `unknown range: ${range}` }, 400);
    }

    const odHosts = await siteOdHosts(site.toLowerCase());
    const requested = c.req.query("host");
    // Only honor a requested host the site actually owns — never a client-named
    // arbitrary site_id.
    const host =
      requested && odHosts.includes(requested) ? requested : odHosts[0];
    if (!host) {
      return c.json({ available: true, report, range, results: [] });
    }

    const { since, until } = window;
    const dimension =
      report === "timeseries"
        ? window.granularity === "hourly"
          ? "time:hour"
          : "time:day"
        : spec.dimension;

    // Translate the shared filter model to Plausible v2 filters. Field → the
    // Plausible dimension it targets; unknown fields are dropped.
    const OD_FIELD_DIM: Record<string, string> = {
      page: "event:page",
      source: "visit:referrer",
      referrer: "visit:referrer",
      country: "visit:country",
      browser: "visit:browser",
      os: "visit:os",
      device: "visit:device",
      utm_campaign: "visit:utm_campaign",
      utm_source: "visit:utm_source",
      utm_medium: "visit:utm_medium",
      utm_content: "visit:utm_content",
      utm_term: "visit:utm_term",
    };
    const OD_OP: Record<string, string> = {
      equals: "is",
      not_equals: "is_not",
      contains: "contains",
      not_contains: "contains_not",
    };
    const plausibleFilters = parseFilters(c.req.query("filters"))
      .map((f) => {
        const dim = OD_FIELD_DIM[f.field];
        const op = OD_OP[f.op];
        return dim && op ? [op, dim, [f.value]] : null;
      })
      .filter(Boolean);

    const runOd = async (dateRange: [string, string]): Promise<OdResult[]> => {
      const res = await fetch(OD_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        body: JSON.stringify({
          site_id: host,
          metrics: spec.metrics,
          date_range: dateRange,
          ...(dimension ? { dimensions: [dimension] } : {}),
          ...(spec.order ? { order_by: [[spec.order, "desc"]] } : {}),
          ...(plausibleFilters.length ? { filters: plausibleFilters } : {}),
          pagination: { limit: 100, offset: 0 },
        }),
        signal: AbortSignal.timeout(OD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`OneDollarStats ${res.status}`);
      const payload = (await res.json().catch(() => null)) as {
        results?: OdResult[];
      } | null;
      return payload?.results ?? [];
    };

    try {
      // For KPIs, also read the immediately-preceding window of equal length so
      // the cards can show trend deltas (the ↓/↑ % the old admin shows).
      const results = await runOd([since, until]);
      let previous: OdResult[] | undefined;
      // KPIs always compare (the ↓/↑ deltas); timeseries only when the user
      // turned Compare on (the previous-period overlay).
      const wantsPrevious =
        report === "kpis" ||
        (report === "timeseries" && c.req.query("compare") === "1");
      if (wantsPrevious) {
        const prevUntil = since;
        const prevSince = toIsoDate(
          new Date(Date.parse(`${since}T00:00:00Z`) - window.days * 86400000),
        );
        previous = await runOd([prevSince, prevUntil]).catch(() => undefined);
      }
      return c.json({
        available: true,
        report,
        range,
        host,
        metrics: spec.metrics,
        results,
        ...(previous ? { previous } : {}),
      });
    } catch (err) {
      console.error(
        `[monitor] onedollar ${report} failed for host="${host}":`,
        err,
      );
      return c.json({ error: "Failed to reach OneDollarStats" }, 502);
    }
  });

  return app;
};
