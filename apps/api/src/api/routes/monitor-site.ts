/**
 * Monitor for Blocks v8 sites: the site's own OpenTelemetry, read from the
 * stats-lake warehouse (the same `CLICKHOUSE_ANALYTICS_*` connection as the
 * CDN views in `monitor.ts`).
 *
 * A v8 site sends OTLP to the hosted collector with its site token. The
 * collector verifies the token and stamps the token's site on every resource
 * as `service.name` and `deco.site`, so both name the site the token was
 * issued for. Every query here scopes on both: `ServiceName` is the first
 * column of the tables' sort key (without it a 7-day read scans every site),
 * and `deco.site` is only ever written by the collector after the token
 * check.
 *
 * Signals (all from `@decocms/blocks`):
 *   - `http.server.request.duration`: the site's own requests, labelled
 *     `http.route`, `http.request.method`, `status_class`, `cache`, `device`.
 *     Sent from blocks 8.5; before that the request views answer empty with
 *     a reason the page explains.
 *   - `http.client.request.duration`: upstream calls, labelled `provider`,
 *     `operation`, `status_class` (`2xx`…`5xx`, or `error` when no response
 *     came), `cached`, `retries`.
 *   - Error logs (`otel_logs`, severity ERROR), sampled by the site's
 *     telemetry settings.
 *
 * Histograms are DELTA (each row counts only its own interval), in seconds,
 * so counts and bucket counts add across rows. Percentiles are computed from
 * the summed buckets with linear interpolation inside a bucket
 * ({@link quantile}).
 */

/** The ranges the v8 Monitor offers. */
export type SiteRange = "1h" | "24h" | "7d";

const RANGES: Record<SiteRange, { ms: number; stepS: number }> = {
  "1h": { ms: 60 * 60_000, stepS: 60 },
  "24h": { ms: 24 * 60 * 60_000, stepS: 15 * 60 },
  "7d": { ms: 7 * 24 * 60 * 60_000, stepS: 2 * 60 * 60 },
};

export const SITE_VIEWS = new Set([
  "summary",
  "timeline",
  "routes",
  "upstreams",
  "errors",
  "releases",
]);

/** The views that read the site's own requests (blocks 8.5 and later). */
const REQUEST_VIEWS = new Set(["summary", "timeline", "routes"]);

export const SERVER_METRIC = "http.server.request.duration";
export const CLIENT_METRIC = "http.client.request.duration";

export interface SiteWindow {
  range: SiteRange;
  /** Inclusive start, epoch ms. */
  startMs: number;
  /** Exclusive end, epoch ms: `now` rounded up to the next bucket. */
  endMs: number;
  /** The previous window of the same length, for deltas. */
  prevStartMs: number;
  /** Timeline bucket size in seconds. */
  stepS: number;
}

/**
 * The window for a range ending now. The end is rounded up to the bucket
 * size, so every timeline bucket is whole and the last one is the current,
 * still filling, one. Null for an unknown range.
 */
export function resolveSiteWindow(
  range: string,
  nowMs: number,
): SiteWindow | null {
  if (!Object.hasOwn(RANGES, range)) return null;
  const { ms, stepS } = RANGES[range as SiteRange];
  const stepMs = stepS * 1000;
  const endMs = Math.ceil((nowMs + 1) / stepMs) * stepMs;
  const startMs = endMs - ms;
  return {
    range: range as SiteRange,
    startMs,
    endMs,
    prevStartMs: startMs - ms,
    stepS,
  };
}

// --- SQL ----------------------------------------------------------------------

/**
 * The tenant scope every query carries: the site's rows, as stamped by the
 * collector, in production. A resource without an environment counts as
 * production (the attribute is optional in the OTel resource).
 */
const SITE_SCOPE = `ServiceName = {slug:String}
        AND ResourceAttributes['deco.site'] = {slug:String}
        AND ResourceAttributes['deployment.environment.name'] IN ('production', '')`;

const HIST_TABLE = "default.otel_metrics_histogram";
const LOGS_TABLE = "default.otel_logs";

const inWindow = (col: string, from: string) =>
  `${col} >= fromUnixTimestamp64Milli({${from}:Int64}) AND ${col} < fromUnixTimestamp64Milli({end:Int64})`;

/**
 * One histogram per group: rows are grouped by their bucket bounds too, so
 * `sumForEach` only ever adds arrays of one length; {@link quantile} merges
 * groups whose bounds differ.
 */
const HISTOGRAM_COLUMNS = `ExplicitBounds AS bounds,
        sumForEach(BucketCounts) AS buckets,
        sum(Count) AS count,
        max(Max) AS max`;

const VALID_HISTOGRAM = "length(BucketCounts) = length(ExplicitBounds) + 1";

export interface SiteQuery {
  query: string;
  params: Record<string, unknown>;
}

function baseParams(
  slug: string,
  w: SiteWindow,
  metric: string,
): Record<string, unknown> {
  return {
    slug,
    metric,
    start: w.startMs,
    prev: w.prevStartMs,
    end: w.endMs,
    step: w.stepS,
  };
}

/** The SQL for one view. `metric` is only overridable for validation runs. */
export function siteViewQuery(
  view: string,
  slug: string,
  w: SiteWindow,
  metric?: string,
): SiteQuery {
  switch (view) {
    case "summary":
      return {
        query: `SELECT
        TimeUnix >= fromUnixTimestamp64Milli({start:Int64}) AS current,
        ${HISTOGRAM_COLUMNS},
        sumIf(Count, Attributes['status_class'] = '5xx') AS errors,
        sumIf(Count, Attributes['cache'] = 'HIT') AS hits,
        sumIf(Count, Attributes['cache'] IN ('HIT', 'MISS')) AS cacheable
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND MetricName = {metric:String}
        AND ${inWindow("TimeUnix", "prev")}
        AND ${VALID_HISTOGRAM}
      GROUP BY current, bounds`,
        params: baseParams(slug, w, metric ?? SERVER_METRIC),
      };
    case "timeline":
      return {
        query: `SELECT
        intDiv(toUnixTimestamp(toDateTime(TimeUnix)), {step:UInt32}) * {step:UInt32} AS t,
        Attributes['status_class'] AS status_class,
        ${HISTOGRAM_COLUMNS}
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND MetricName = {metric:String}
        AND ${inWindow("TimeUnix", "start")}
        AND ${VALID_HISTOGRAM}
      GROUP BY t, status_class, bounds
      ORDER BY t`,
        params: baseParams(slug, w, metric ?? SERVER_METRIC),
      };
    case "routes":
      return {
        query: `SELECT
        Attributes['http.route'] AS route,
        ${HISTOGRAM_COLUMNS},
        sumIf(Count, Attributes['status_class'] = '5xx') AS errors
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND MetricName = {metric:String}
        AND ${inWindow("TimeUnix", "start")}
        AND ${VALID_HISTOGRAM}
      GROUP BY route, bounds
      ORDER BY count DESC
      LIMIT 1000`,
        params: baseParams(slug, w, metric ?? SERVER_METRIC),
      };
    case "upstreams":
      return {
        query: `SELECT
        Attributes['provider'] AS provider,
        Attributes['operation'] AS operation,
        ${HISTOGRAM_COLUMNS},
        sumIf(Count, Attributes['status_class'] IN ('5xx', 'error')) AS errors,
        sumIf(Count, Attributes['cached'] = 'true') AS cached
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND MetricName = {metric:String}
        AND ${inWindow("TimeUnix", "start")}
        AND ${VALID_HISTOGRAM}
      GROUP BY provider, operation, bounds
      ORDER BY count DESC
      LIMIT 1000`,
        params: baseParams(slug, w, metric ?? CLIENT_METRIC),
      };
    case "errors":
      return {
        query: `SELECT
        substring(Body, 1, 500) AS message,
        LogAttributes['http.route'] AS route,
        any(LogAttributes['error.code']) AS code,
        any(multiIf(
          LogAttributes['deco.block.type'] != '', LogAttributes['deco.block.type'],
          LogAttributes['provider'] != '', concat(LogAttributes['provider'], ' · ', LogAttributes['operation']),
          '')) AS source,
        count() AS count,
        toUnixTimestamp64Milli(max(Timestamp)) AS last_seen_ms
      FROM ${LOGS_TABLE}
      WHERE ${SITE_SCOPE}
        AND SeverityNumber >= 17
        AND ${inWindow("Timestamp", "start")}
      GROUP BY message, route
      ORDER BY count DESC, last_seen_ms DESC
      LIMIT 50`,
        params: { slug, start: w.startMs, end: w.endMs },
      };
    case "releases":
      // First seen over this window and the one before it: a release already
      // live before the window started is not a change inside it.
      return {
        query: `SELECT
        ResourceAttributes['deco.release'] AS release,
        toUnixTimestamp64Milli(min(TimeUnix)) AS first_seen_ms
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND ${inWindow("TimeUnix", "prev")}
        AND release != ''
      GROUP BY release
      HAVING first_seen_ms >= {start:Int64}
      ORDER BY first_seen_ms
      LIMIT 50`,
        params: { slug, start: w.startMs, prev: w.prevStartMs, end: w.endMs },
      };
    default:
      throw new Error(`unknown view: ${view}`);
  }
}

/**
 * Which metrics the site sent in the last 7 days: tells a request view with
 * no rows why ({@link emptyReason}).
 */
export function metricsProbeQuery(slug: string, nowMs: number): SiteQuery {
  return {
    query: `SELECT DISTINCT MetricName AS metric
      FROM ${HIST_TABLE}
      WHERE ${SITE_SCOPE}
        AND TimeUnix >= fromUnixTimestamp64Milli({since:Int64})
      LIMIT 20`,
    params: { slug, since: nowMs - 7 * 24 * 60 * 60_000 },
  };
}

// --- Percentiles ----------------------------------------------------------------

export interface Histogram {
  /** Upper bounds of every bucket but the last (which is open-ended). */
  bounds: number[];
  /** `bounds.length + 1` counts. */
  buckets: number[];
  /** The largest observation, when known (closes the last bucket). */
  max?: number;
}

/**
 * The q-quantile (0..1) of the union of histograms, or null when they hold
 * nothing. Each bucket's count is spread evenly across its range (linear
 * interpolation, as Prometheus' `histogram_quantile`): the first bucket starts
 * at 0 (durations), the open-ended last one ends at the largest observation
 * (or is a point at the last bound when that's unknown). Histograms with
 * different bounds are merged by cutting every bucket at every bound.
 */
export function quantile(histograms: Histogram[], q: number): number | null {
  interface Piece {
    lo: number;
    hi: number;
    count: number;
  }
  const pieces: Piece[] = [];
  for (const h of histograms) {
    if (h.buckets.length !== h.bounds.length + 1) continue;
    h.buckets.forEach((raw, i) => {
      const count = Number(raw);
      if (!(count > 0)) return;
      const lo = i === 0 ? 0 : (h.bounds[i - 1] ?? 0);
      const hi =
        i < h.bounds.length
          ? (h.bounds[i] ?? lo)
          : Math.max(lo, Number.isFinite(h.max) ? (h.max as number) : lo);
      pieces.push({ lo, hi, count });
    });
  }
  const total = pieces.reduce((s, p) => s + p.count, 0);
  if (total === 0) return null;

  // Cut every piece at every edge, so the elementary intervals don't overlap.
  const edges = [...new Set(pieces.flatMap((p) => [p.lo, p.hi]))].sort(
    (a, b) => a - b,
  );
  const byCell = new Map<string, Piece>();
  const add = (lo: number, hi: number, count: number) => {
    const key = `${lo}:${hi}`;
    const cell = byCell.get(key);
    if (cell) cell.count += count;
    else byCell.set(key, { lo, hi, count });
  };
  for (const p of pieces) {
    if (p.hi === p.lo) {
      add(p.lo, p.hi, p.count);
      continue;
    }
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i] as number;
      const b = edges[i + 1] as number;
      if (a < p.lo || b > p.hi) continue;
      add(a, b, (p.count * (b - a)) / (p.hi - p.lo));
    }
  }
  // A point mass at `x` sits after the interval ending at `x`.
  const cells = [...byCell.values()].sort((x, y) => x.hi - y.hi || x.lo - y.lo);

  const target = Math.min(Math.max(q, 0), 1) * total;
  let cumulative = 0;
  for (const c of cells) {
    if (cumulative + c.count >= target && c.count > 0) {
      const within = (target - cumulative) / c.count;
      return c.lo + (c.hi - c.lo) * Math.min(Math.max(within, 0), 1);
    }
    cumulative += c.count;
  }
  return cells.at(-1)?.hi ?? null;
}

/** Seconds → whole milliseconds; null stays null. */
function toMs(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * 1000);
}

// --- Rows → answers -------------------------------------------------------------

/** ClickHouse JSON quotes 64-bit integers; accept both. */
type Num = number | string;

interface HistogramRow {
  bounds: number[];
  buckets: Num[];
  count: Num;
  max: number;
}

const n = (v: Num | undefined | null): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

const hist = (r: HistogramRow): Histogram => ({
  bounds: r.bounds.map(Number),
  buckets: r.buckets.map(n),
  max: Number(r.max),
});

const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? part / whole : null;

export interface SitePeriod {
  requests: number;
  errors5xx: number;
  /** Share of requests answered with 5xx (0..1), null with no requests. */
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /**
   * Share of the pages the edge cache could serve that it did serve
   * (`HIT` over `HIT` + `MISS`). Drafts, server functions, non-GET and
   * private requests never go through the cache, so they don't count.
   */
  cacheHitRate: number | null;
}

export interface SiteSummary {
  current: SitePeriod;
  previous: SitePeriod;
  /** Average requests per second over the window. */
  perSecond: number;
}

type SummaryRow = HistogramRow & {
  current: Num | boolean;
  errors: Num;
  hits: Num;
  cacheable: Num;
};

export function toSummary(rows: SummaryRow[], w: SiteWindow): SiteSummary {
  const period = (current: boolean): SitePeriod => {
    const mine = rows.filter((r) => Boolean(n(r.current as Num)) === current);
    const requests = mine.reduce((s, r) => s + n(r.count), 0);
    const errors5xx = mine.reduce((s, r) => s + n(r.errors), 0);
    const hits = mine.reduce((s, r) => s + n(r.hits), 0);
    const cacheable = mine.reduce((s, r) => s + n(r.cacheable), 0);
    const hs = mine.map(hist);
    return {
      requests,
      errors5xx,
      errorRate: ratio(errors5xx, requests),
      p50Ms: toMs(quantile(hs, 0.5)),
      p95Ms: toMs(quantile(hs, 0.95)),
      cacheHitRate: ratio(hits, cacheable),
    };
  };
  const current = period(true);
  return {
    current,
    previous: period(false),
    perSecond: current.requests / ((w.endMs - w.startMs) / 1000),
  };
}

export interface TimelinePoint {
  /** Bucket start, epoch ms. */
  t: number;
  requests: number;
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  p95Ms: number | null;
}

type TimelineRow = HistogramRow & { t: Num; status_class: string };

/** One point per bucket of the window, zeros where nothing came. */
export function toTimeline(
  rows: TimelineRow[],
  w: SiteWindow,
): TimelinePoint[] {
  const stepMs = w.stepS * 1000;
  const byT = new Map<number, TimelineRow[]>();
  for (const r of rows) {
    const t = n(r.t) * 1000;
    byT.set(t, [...(byT.get(t) ?? []), r]);
  }
  const points: TimelinePoint[] = [];
  for (let t = w.startMs; t < w.endMs; t += stepMs) {
    const mine = byT.get(t) ?? [];
    const by = (cls: string) =>
      mine
        .filter((r) => r.status_class === cls)
        .reduce((s, r) => s + n(r.count), 0);
    points.push({
      t,
      requests: mine.reduce((s, r) => s + n(r.count), 0),
      "2xx": by("2xx") + by("1xx"),
      "3xx": by("3xx"),
      "4xx": by("4xx"),
      "5xx": by("5xx"),
      p95Ms: toMs(quantile(mine.map(hist), 0.95)),
    });
  }
  return points;
}

export interface RouteRow {
  route: string;
  requests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number | null;
}

type RouteSqlRow = HistogramRow & { route: string; errors: Num };

/** The busiest routes (top 20 by requests), each with its p95 and 5xx share. */
export function toRoutes(rows: RouteSqlRow[]): RouteRow[] {
  const groups = new Map<string, RouteSqlRow[]>();
  for (const r of rows) {
    const key = r.route || "unmatched";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups]
    .map(([route, rs]) => {
      const requests = rs.reduce((s, r) => s + n(r.count), 0);
      const hs = rs.map(hist);
      return {
        route,
        requests,
        p50Ms: toMs(quantile(hs, 0.5)),
        p95Ms: toMs(quantile(hs, 0.95)),
        errorRate: ratio(
          rs.reduce((s, r) => s + n(r.errors), 0),
          requests,
        ),
      };
    })
    .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route))
    .slice(0, 20);
}

export interface UpstreamRow {
  provider: string;
  operation: string;
  calls: number;
  p95Ms: number | null;
  /** 5xx answers and calls that got no answer, over all calls. */
  errorRate: number | null;
  /** Calls answered by the site's upstream cache. */
  cachedRate: number | null;
}

type UpstreamSqlRow = HistogramRow & {
  provider: string;
  operation: string;
  errors: Num;
  cached: Num;
};

export function toUpstreams(rows: UpstreamSqlRow[]): UpstreamRow[] {
  const groups = new Map<string, UpstreamSqlRow[]>();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.operation}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((rs) => {
      const calls = rs.reduce((s, r) => s + n(r.count), 0);
      return {
        provider: rs[0]?.provider ?? "",
        operation: rs[0]?.operation ?? "",
        calls,
        p95Ms: toMs(quantile(rs.map(hist), 0.95)),
        errorRate: ratio(
          rs.reduce((s, r) => s + n(r.errors), 0),
          calls,
        ),
        cachedRate: ratio(
          rs.reduce((s, r) => s + n(r.cached), 0),
          calls,
        ),
      };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 50);
}

export interface ErrorRow {
  message: string;
  /** The page route the error came from, when the log carries one. */
  route: string;
  /** `error.code` (BLOCK_FAILED, FETCH_FAILED, …). */
  code: string;
  /** The block type, or `provider · operation` for an upstream call. */
  source: string;
  count: number;
  lastSeenMs: number;
}

function toErrors(
  rows: {
    message: string;
    route: string;
    code: string;
    source: string;
    count: Num;
    last_seen_ms: Num;
  }[],
): ErrorRow[] {
  return rows.map((r) => ({
    message: r.message,
    route: r.route,
    code: r.code,
    source: r.source,
    count: n(r.count),
    lastSeenMs: n(r.last_seen_ms),
  }));
}

export interface ReleaseMarker {
  release: string;
  firstSeenMs: number;
}

function toReleases(
  rows: { release: string; first_seen_ms: Num }[],
): ReleaseMarker[] {
  return rows.map((r) => ({
    release: r.release,
    firstSeenMs: n(r.first_seen_ms),
  }));
}

// --- Empty request views ---------------------------------------------------------

/**
 * Why a request view has nothing to show:
 *   - `no_telemetry`: the site sent nothing in the last 7 days (no site
 *     token yet, or no traffic at all).
 *   - `server_metric_missing`: the site sends telemetry, but not its own
 *     requests: it runs a Blocks version before 8.5. Upstreams and errors
 *     still work.
 *   - `no_requests`: the site sends request metrics, just none in this range.
 */
export type EmptyReason =
  | "no_telemetry"
  | "server_metric_missing"
  | "no_requests";

export function emptyReason(metricsSent: string[]): EmptyReason {
  if (metricsSent.length === 0) return "no_telemetry";
  if (!metricsSent.includes(SERVER_METRIC)) return "server_metric_missing";
  return "no_requests";
}

/** Whether a request view's answer is empty. */
function isEmptyRequestView(view: string, data: unknown): boolean {
  if (view === "summary") {
    const { current } = data as SiteSummary;
    return current.requests === 0;
  }
  if (view === "timeline") {
    return (data as TimelinePoint[]).every((p) => p.requests === 0);
  }
  return (data as unknown[]).length === 0;
}

export type RunQuery = <T>(
  query: string,
  params: Record<string, unknown>,
) => Promise<T[]>;

export interface SiteViewAnswer {
  data: unknown;
  /** Set (and `data` null) when a request view is empty. */
  reason?: EmptyReason;
}

/** Runs one view for a site the caller already checked the org owns. */
export async function querySiteView(
  run: RunQuery,
  view: string,
  slug: string,
  w: SiteWindow,
  nowMs: number,
): Promise<SiteViewAnswer> {
  const { query, params } = siteViewQuery(view, slug, w);
  const rows = await run<never>(query, params);
  let data: unknown;
  switch (view) {
    case "summary":
      data = toSummary(rows, w);
      break;
    case "timeline":
      data = toTimeline(rows, w);
      break;
    case "routes":
      data = toRoutes(rows);
      break;
    case "upstreams":
      data = toUpstreams(rows);
      break;
    case "errors":
      data = toErrors(rows);
      break;
    case "releases":
      data = toReleases(rows);
      break;
  }
  if (REQUEST_VIEWS.has(view) && isEmptyRequestView(view, data)) {
    const probe = metricsProbeQuery(slug, nowMs);
    const sent = await run<{ metric: string }>(probe.query, probe.params);
    return { data: null, reason: emptyReason(sent.map((r) => r.metric)) };
  }
  return { data };
}
