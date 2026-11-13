/**
 * A site's Deco Analytics as the audience dashboard's reports, from the org's
 * customer lake (`site_traffic_hourly` for totals, `site_dims_hourly` for
 * breakdowns). Rows keep the OneDollarStats report shape — `{ dimensions,
 * metrics }` with metrics in the same positions — so the dashboard draws
 * either source. Read as the org's own lake user, so the row policy already
 * limits it to the org's sites.
 */

import { queryCustomerLake } from "../customer-lake/client";

export interface AudienceRow {
  dimensions: string[];
  metrics: number[];
}

type Measure = "visitors" | "pageviews" | "events";

const VISITORS: Measure[] = ["visitors"];
const VISITORS_EVENTS: Measure[] = ["visitors", "events"];

/** Breakdown report → the lake dimension, the metrics in the order the
 *  dashboard reads them, and the one that ranks. */
const BREAKDOWNS: Record<
  string,
  { dim: string; metrics: Measure[]; order: Measure }
> = {
  pages: {
    dim: "path",
    metrics: ["pageviews", "visitors"],
    order: "pageviews",
  },
  sources: { dim: "sourceDomain", metrics: VISITORS, order: "visitors" },
  countries: { dim: "country", metrics: VISITORS, order: "visitors" },
  browsers: { dim: "browser", metrics: VISITORS, order: "visitors" },
  os: { dim: "os", metrics: VISITORS, order: "visitors" },
  devices: { dim: "device", metrics: VISITORS, order: "visitors" },
  events: { dim: "name", metrics: VISITORS_EVENTS, order: "events" },
  utm_campaign: {
    dim: "utmCampaign",
    metrics: VISITORS_EVENTS,
    order: "events",
  },
  utm_source: { dim: "utmSource", metrics: VISITORS_EVENTS, order: "events" },
  utm_medium: { dim: "utmMedium", metrics: VISITORS_EVENTS, order: "events" },
};

// The hour bounds only prune partitions; the local-day test decides.
const WINDOW = `site_id = {site:String}
  AND hour >= toDateTime({since:Date}) - INTERVAL 1 DAY
  AND hour < toDateTime({until:Date}) + INTERVAL 2 DAY
  AND toDate(hour, {tz:String}) BETWEEN {since:Date} AND {until:Date}`;

export async function loadDecoAudience(
  organizationId: string,
  siteId: string,
  report: string,
  window: { since: string; until: string; granularity: "hourly" | "daily" },
  tz: string,
): Promise<AudienceRow[]> {
  const params = {
    site: siteId,
    tz,
    since: window.since,
    until: window.until,
  };

  // Visits, bounce rate and visit duration aren't in the lake: zero in their
  // OneDollarStats positions, and the dashboard hides their cards.
  if (report === "kpis") {
    const [r] = await queryCustomerLake(
      organizationId,
      `SELECT uniqMerge(visitors) AS visitors, sum(pageviews) AS pageviews
       FROM customer_lake.site_traffic_hourly FINAL
       WHERE ${WINDOW}`,
      params,
    );
    return [
      {
        dimensions: [],
        metrics: [Number(r?.visitors ?? 0), 0, Number(r?.pageviews ?? 0), 0, 0],
      },
    ];
  }
  if (report === "timeseries") {
    const bucket =
      window.granularity === "hourly"
        ? "formatDateTime(toStartOfHour(hour, {tz:String}), '%Y-%m-%d %H:00:00', {tz:String})"
        : "toString(toDate(hour, {tz:String}))";
    const rows = await queryCustomerLake(
      organizationId,
      `SELECT ${bucket} AS bucket, uniqMerge(visitors) AS visitors, sum(pageviews) AS pageviews
       FROM customer_lake.site_traffic_hourly FINAL
       WHERE ${WINDOW}
       GROUP BY bucket ORDER BY bucket`,
      params,
    );
    return rows.map((r) => ({
      dimensions: [String(r.bucket)],
      metrics: [Number(r.pageviews), 0, Number(r.visitors), 0, 0],
    }));
  }

  // utm_content and utm_term aren't collected.
  const spec = BREAKDOWNS[report];
  if (!spec) return [];
  const rows = await queryCustomerLake(
    organizationId,
    `SELECT value, uniqMerge(visitors) AS visitors, sum(pageviews) AS pageviews, sum(events) AS events
     FROM customer_lake.site_dims_hourly FINAL
     WHERE ${WINDOW} AND dim = {dim:String}
     GROUP BY value ORDER BY ${spec.order} DESC LIMIT 100`,
    { ...params, dim: spec.dim },
  );
  return rows.map((r) => ({
    dimensions: [String(r.value)],
    metrics: spec.metrics.map((m) => Number(r[m])),
  }));
}

/** The Monitor's audience views (web `audience-contract.ts`) → the report each reads. */
export const AUDIENCE_REPORTS: Record<string, string> = {
  summary: "kpis",
  timeline: "timeseries",
  pages: "pages",
  sources: "sources",
  countries: "countries",
  devices: "devices",
};

/** OneDollarStats' positional rows, which {@link loadDecoAudience} mirrors, in
 *  the audience contract's shape. The lake has no visits, bounce or duration:
 *  null for it, never zero. */
export function toAudienceData(
  view: string,
  rows: AudienceRow[],
  previous: AudienceRow[] | null,
  source: "deco-analytics" | "onedollar" = "deco-analytics",
) {
  const summary = (r: AudienceRow[] | null) => {
    const m = r?.[0]?.metrics;
    if (!m) return null;
    const od = source === "onedollar";
    return {
      visitors: m[0] ?? 0,
      pageviews: m[2] ?? 0,
      sessions: od ? (m[1] ?? null) : null,
      bounceRate: od ? (m[3] ?? null) : null,
      visitDurationS: od ? (m[4] ?? null) : null,
    };
  };
  if (view === "summary") {
    return {
      view,
      summary: summary(rows) ?? {
        visitors: 0,
        pageviews: 0,
        sessions: null,
        bounceRate: null,
        visitDurationS: null,
      },
      previous: summary(previous),
    };
  }
  if (view === "timeline") {
    return {
      view,
      points: rows.map((r) => ({
        t: r.dimensions[0] ?? "",
        visitors: r.metrics[2] ?? 0,
        pageviews: r.metrics[0] ?? 0,
      })),
    };
  }
  // Each breakdown's first metric is the one it ranks by.
  return {
    view,
    rows: rows.map((r) => ({
      key: r.dimensions[0] ?? "",
      count: r.metrics[0] ?? 0,
    })),
  };
}
