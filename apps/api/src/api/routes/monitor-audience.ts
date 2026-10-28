/**
 * The Monitor's audience views, one normalized shape over two sources.
 *
 * A site registered in Deco Analytics reads from its read surface. Any other
 * site falls back to OneDollarStats, the legacy platform's Plausible-compatible
 * collector, until that source is retired; removing it then is deleting the
 * `onedollar` branch here. A site keeps one source for every range: a migrated
 * site's earlier history stays in OneDollarStats and is not stitched in.
 *
 * Tenancy is the caller's: `monitor.ts` proves the org owns the slug before
 * anything here runs. The Deco Analytics site id comes from the control-plane
 * for that slug, and the OneDollarStats host from the slug's own warehouse
 * hosts, so no client value ever names a site.
 */

import type {
  AudienceData,
  AudienceRange,
  AudienceResponse,
  AudienceRow,
  AudienceSource,
  AudienceSummary,
  AudienceView,
  AudienceWindow,
} from "@decocms/shared/monitor-audience";
import { z } from "zod";
import {
  readAnalyticsView,
  resolveWarehouseSiteId,
} from "../../deco-analytics/read-surface";
import {
  plausibleQuery,
  type PlausibleQuery,
  type PlausibleRows,
} from "../../deco-legacy/onedollarstats";
import { getSettings } from "../../settings";

// --- source choice ----------------------------------------------------------

/** What the control-plane says about the site's Deco Analytics registration. */
export type DecoAnalyticsState =
  | "registered"
  | "unregistered"
  /** The control-plane or read surface is not wired in this deployment. */
  | "not-configured";

/**
 * Deco Analytics wins whenever the site is registered there; OneDollarStats is
 * the fallback when it is wired and the site has a host it could index.
 */
export function pickAudienceSource(
  decoAnalytics: DecoAnalyticsState,
  oneDollarHost: string | null,
): AudienceSource | null {
  if (decoAnalytics === "registered") return "deco-analytics";
  if (oneDollarHost) return "onedollar";
  return null;
}

// --- OneDollarStats ---------------------------------------------------------

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

const RANGE_DAYS: Record<AudienceRange, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

/**
 * The UTC calendar days OneDollarStats reads for a range, plus the window of
 * equal length right before it. Plausible's date ranges are whole days, so
 * `24h` is today so far, bucketed by hour.
 */
export function oneDollarWindow(
  range: AudienceRange,
  now: Date,
): {
  since: string;
  until: string;
  previous: [string, string];
  bucket: "time:hour" | "time:day";
} {
  const days = RANGE_DAYS[range];
  const until = isoDay(now);
  const since = shiftDays(until, -(days - 1));
  return {
    since,
    until,
    previous: [shiftDays(since, -days), shiftDays(since, -1)],
    bucket: days === 1 ? "time:hour" : "time:day",
  };
}

const OD_SUMMARY_METRICS = [
  "visitors",
  "visits",
  "pageviews",
  "bounce_rate",
  "visit_duration",
];

const OD_BREAKDOWN_DIMENSION: Record<
  "pages" | "sources" | "countries" | "devices",
  string
> = {
  pages: "event:page",
  sources: "visit:referrer",
  countries: "visit:country",
  devices: "visit:device",
};

/** Breakdown rows kept per view. */
const BREAKDOWN_LIMIT = 50;

/** A count the source always reports; a missing cell reads as zero. */
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A metric the source may not report; missing stays null. */
function optional(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Plausible's aggregate row in {@link OD_SUMMARY_METRICS} order. */
export function oneDollarSummary(rows: PlausibleRows): AudienceSummary {
  const m = rows[0]?.metrics ?? [];
  return {
    visitors: count(m[0]),
    sessions: optional(m[1]),
    pageviews: count(m[2]),
    bounceRate: optional(m[3]),
    visitDurationS: optional(m[4]),
  };
}

/** Rows of `[bucket] → [visitors, pageviews]`, in time order. */
export function oneDollarTimeline(
  rows: PlausibleRows,
): Extract<AudienceData, { view: "timeline" }>["points"] {
  return rows
    .map((r) => ({
      t: r.dimensions[0] ?? "",
      visitors: count(r.metrics[0]),
      pageviews: count(r.metrics[1]),
    }))
    .filter((p) => p.t !== "")
    .sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * One name per source or device whichever collector reported it, so rows add
 * up across sites: OneDollarStats says "Google", "instagram.com" and
 * "Direct / None" where Deco Analytics says "google", "instagram" and "direct".
 * Pages and countries keep the source's own key.
 */
export function canonicalKey(view: AudienceView, key: string): string {
  if (view !== "sources" && view !== "devices") return key;
  const k = key.trim().toLowerCase();
  if (view === "devices") return k;
  if (k === "direct / none" || k === "(direct)" || k === "") return "direct";
  return k.replace(/^www\./, "").replace(/\.(com|com\.br|net|org)$/, "");
}

/** Rows merged by canonical key, busiest first. */
function rankRows(view: AudienceView, rows: AudienceRow[]): AudienceRow[] {
  const merged = new Map<string, number>();
  for (const r of rows) {
    if (r.key === "") continue;
    const key = canonicalKey(view, r.key);
    merged.set(key, (merged.get(key) ?? 0) + r.count);
  }
  return [...merged]
    .map(([key, n]) => ({ key, count: n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, BREAKDOWN_LIMIT);
}

/** Rows of `[key] → [visitors]`, busiest first. */
export function oneDollarRows(
  view: AudienceView,
  rows: PlausibleRows,
): AudienceRow[] {
  return rankRows(
    view,
    rows.map((r) => ({
      key: r.dimensions[0] ?? "",
      count: count(r.metrics[0]),
    })),
  );
}

async function readOneDollar(
  apiKey: string,
  host: string,
  view: AudienceView,
  range: AudienceRange,
  now: Date,
): Promise<{ window: AudienceWindow; data: AudienceData }> {
  const w = oneDollarWindow(range, now);
  const window: AudienceWindow = {
    kind: "calendar",
    since: w.since,
    until: w.until,
  };
  const base: Pick<PlausibleQuery, "site_id" | "pagination"> = {
    site_id: host,
    pagination: { limit: 1000, offset: 0 },
  };

  switch (view) {
    case "summary": {
      const query = (date_range: [string, string]) =>
        plausibleQuery(apiKey, {
          ...base,
          metrics: OD_SUMMARY_METRICS,
          date_range,
        });
      const [current, previous] = await Promise.all([
        query([w.since, w.until]),
        // Without the comparison the current window still renders.
        query(w.previous).catch(() => null),
      ]);
      return {
        window,
        data: {
          view,
          summary: oneDollarSummary(current),
          previous: previous ? oneDollarSummary(previous) : null,
        },
      };
    }
    case "timeline": {
      const rows = await plausibleQuery(apiKey, {
        ...base,
        metrics: ["visitors", "pageviews"],
        date_range: [w.since, w.until],
        dimensions: [w.bucket],
      });
      return { window, data: { view, points: oneDollarTimeline(rows) } };
    }
    case "pages":
    case "sources":
    case "countries":
    case "devices": {
      const rows = await plausibleQuery(apiKey, {
        ...base,
        metrics: ["visitors"],
        date_range: [w.since, w.until],
        dimensions: [OD_BREAKDOWN_DIMENSION[view]],
        order_by: [["visitors", "desc"]],
        pagination: { limit: BREAKDOWN_LIMIT, offset: 0 },
      });
      return { window, data: { view, rows: oneDollarRows(view, rows) } };
    }
    default: {
      const unhandled: never = view;
      throw new Error(`unknown audience view: ${String(unhandled)}`);
    }
  }
}

// --- Deco Analytics ---------------------------------------------------------

/** A payload cell as a number: some ClickHouse aggregates arrive as numeric strings. */
const NumberLike = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: "not a number" });
    return z.NEVER;
  }
  return n;
});

const DecoKpisSchema = z.object({
  visitors: NumberLike.optional(),
  pageviews: NumberLike.optional(),
  sessions: NumberLike.optional(),
  bounce_pct: NumberLike.optional(),
  duration_s: NumberLike.optional(),
});

const DecoSeriesRowSchema = z.object({
  t: z.union([z.string(), z.number()]).transform(String),
  visitors: NumberLike.optional(),
  pageviews: NumberLike.optional(),
});

const DecoBreakdownRowSchema = z.object({
  k: z.union([z.string(), z.number()]).transform(String),
  n: NumberLike,
});

/** Rows of `payload[key]` that match `schema`; malformed rows are dropped
 *  rather than failing the panel. */
function decoRows<T extends z.ZodType>(
  payload: Record<string, unknown>,
  key: string,
  schema: T,
): z.infer<T>[] {
  const rows = payload[key];
  if (!Array.isArray(rows)) return [];
  const out: z.infer<T>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** The `overview` view's `kpis` row. */
export function decoSummary(payload: Record<string, unknown>): AudienceSummary {
  const k = decoRows(payload, "kpis", DecoKpisSchema)[0] ?? {};
  return {
    visitors: k.visitors ?? 0,
    pageviews: k.pageviews ?? 0,
    sessions: k.sessions ?? null,
    bounceRate: k.bounce_pct ?? null,
    visitDurationS: k.duration_s ?? null,
  };
}

/** The `overview` view's `series`, in time order. */
export function decoTimeline(
  payload: Record<string, unknown>,
): Extract<AudienceData, { view: "timeline" }>["points"] {
  return decoRows(payload, "series", DecoSeriesRowSchema)
    .map((r) => ({
      t: r.t,
      visitors: r.visitors ?? 0,
      pageviews: r.pageviews ?? 0,
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

/** A `{k, n}` breakdown panel, busiest first. */
export function decoBreakdown(
  view: AudienceView,
  payload: Record<string, unknown>,
  key: string,
): AudienceRow[] {
  return rankRows(
    view,
    decoRows(payload, key, DecoBreakdownRowSchema).map((r) => ({
      key: r.k,
      count: r.n,
    })),
  );
}

/** Which read-surface view, and which panel of it, answers each breakdown. */
const DECO_PANELS: Record<
  "pages" | "sources" | "countries" | "devices",
  { view: string; key: string }
> = {
  sources: { view: "overview", key: "sources" },
  pages: { view: "behaviour", key: "pages" },
  countries: { view: "behaviour", key: "countries" },
  devices: { view: "behaviour", key: "devices" },
};

async function readDecoAnalytics(
  conf: { analyticsDataUrl: string; analyticsMasterToken: string },
  siteId: string,
  site: string,
  view: AudienceView,
  range: AudienceRange,
): Promise<
  | { ok: true; window: AudienceWindow; data: AudienceData }
  | { ok: false; error: string }
> {
  const panel =
    view === "summary" || view === "timeline"
      ? { view: "overview", key: "" }
      : DECO_PANELS[view];
  const read = await readAnalyticsView({
    ...conf,
    siteId,
    view: panel.view,
    range,
    site,
  });
  if (!read.ok) return { ok: false, error: read.error };

  const window: AudienceWindow = { kind: "rolling", range };
  switch (view) {
    case "summary":
      return {
        ok: true,
        window,
        data: { view, summary: decoSummary(read.payload), previous: null },
      };
    case "timeline":
      return {
        ok: true,
        window,
        data: { view, points: decoTimeline(read.payload) },
      };
    case "pages":
    case "sources":
    case "countries":
    case "devices":
      return {
        ok: true,
        window,
        data: { view, rows: decoBreakdown(view, read.payload, panel.key) },
      };
    default: {
      const unhandled: never = view;
      throw new Error(`unknown audience view: ${String(unhandled)}`);
    }
  }
}

// --- the read ---------------------------------------------------------------

export type AudienceRead =
  | { ok: true; body: AudienceResponse }
  | { ok: false; error: string };

/**
 * Resolve the site's source and read one view. `oneDollarHosts` are the
 * site's own hosts as OneDollarStats indexes them, busiest first; `host`
 * picks one of them and is ignored when it is not in that list.
 */
export async function readAudience(opts: {
  org: { id: string };
  site: string;
  view: AudienceView;
  range: AudienceRange;
  oneDollarHosts: () => Promise<string[]>;
  host?: string;
  now?: Date;
}): Promise<AudienceRead> {
  const {
    controlplaneRestUrl,
    controlplaneServiceToken,
    analyticsDataUrl,
    analyticsMasterToken,
    oneDollarStatsApiKey,
  } = getSettings();

  let decoAnalytics: DecoAnalyticsState = "not-configured";
  let siteId: string | null = null;
  if (
    controlplaneRestUrl &&
    controlplaneServiceToken &&
    analyticsDataUrl &&
    analyticsMasterToken
  ) {
    const resolution = await resolveWarehouseSiteId(
      opts.org,
      opts.site,
      controlplaneRestUrl,
      controlplaneServiceToken,
    );
    // Never fall back to OneDollarStats on a failed lookup: a registered site's numbers would change.
    if (resolution.status === "error") {
      return { ok: false, error: "Failed to resolve analytics registration" };
    }
    decoAnalytics = resolution.status;
    if (resolution.status === "registered") siteId = resolution.id;
  }

  let oneDollarHost: string | null = null;
  if (decoAnalytics !== "registered" && oneDollarStatsApiKey) {
    const hosts = await opts.oneDollarHosts();
    oneDollarHost =
      opts.host && hosts.includes(opts.host) ? opts.host : (hosts[0] ?? null);
  }

  const source = pickAudienceSource(decoAnalytics, oneDollarHost);
  switch (source) {
    case null:
      return { ok: true, body: { available: false, reason: "no-source" } };
    case "deco-analytics": {
      if (!siteId || !analyticsDataUrl || !analyticsMasterToken) {
        return { ok: false, error: "Deco Analytics is not configured" };
      }
      const read = await readDecoAnalytics(
        { analyticsDataUrl, analyticsMasterToken },
        siteId,
        opts.site,
        opts.view,
        opts.range,
      );
      if (!read.ok) return { ok: false, error: read.error };
      return {
        ok: true,
        body: {
          available: true,
          source,
          range: opts.range,
          window: read.window,
          data: read.data,
        },
      };
    }
    case "onedollar": {
      if (!oneDollarHost || !oneDollarStatsApiKey) {
        return { ok: false, error: "OneDollarStats is not configured" };
      }
      try {
        const read = await readOneDollar(
          oneDollarStatsApiKey,
          oneDollarHost,
          opts.view,
          opts.range,
          opts.now ?? new Date(),
        );
        return {
          ok: true,
          body: {
            available: true,
            source,
            range: opts.range,
            window: read.window,
            data: read.data,
          },
        };
      } catch (err) {
        console.error(
          `[monitor] audience ${opts.view} failed for host="${oneDollarHost}":`,
          err,
        );
        return { ok: false, error: "Failed to reach OneDollarStats" };
      }
    }
    default: {
      const unhandled: never = source;
      throw new Error(`unknown audience source: ${String(unhandled)}`);
    }
  }
}
