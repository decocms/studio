/**
 * The Monitor's Logs tab for Blocks v8 sites: the site's own logs and spans,
 * one by one, newest first (`GET /api/:org/monitor/:site/site/events`). The
 * wire shape is `apps/web/src/components/monitor/site-events-contract.ts`.
 *
 * Same warehouse, tables and tenant scope as the aggregated views in
 * `monitor-site.ts`: `otel_logs` and `otel_traces`, scoped on the collector's
 * stamp of the site. What a site sends (from `@decocms/blocks`): error logs at
 * the error sample rate, and spans only once the site raises its trace sample
 * rate (0 by default), so most sites list error logs only.
 *
 * Levels: a log's from its OTel severity number (17+ error, 13+ warn, 9+ info,
 * 1–8 debug, unset info); a span is `error` when its status is Error, else `ok`.
 *
 * Counts (`total`, `histogram`, `facets`) come with the first page only; the
 * page after a cursor carries the events and the next cursor.
 */

import {
  inWindow,
  LOGS_TABLE,
  type RunQuery,
  SITE_SCOPE,
  type SiteWindow,
  TRACES_TABLE,
} from "./monitor-site";

const SITE_EVENT_KINDS = ["log", "span"] as const;
export type SiteEventKind = (typeof SITE_EVENT_KINDS)[number];

const SITE_EVENT_LEVELS = [
  "error",
  "warn",
  "info",
  "ok",
  "debug",
] as const;
export type SiteEventLevel = (typeof SITE_EVENT_LEVELS)[number];

export const SITE_EVENTS_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 200;
const MAX_SERVICES = 20;

export interface SiteEventFilters {
  /** Empty: every kind. */
  kinds: SiteEventKind[];
  /** Empty: every level. */
  levels: SiteEventLevel[];
  /** Empty: every service. */
  services: string[];
  /** Case-insensitive text in the message, or an exact trace id. */
  q: string;
}

/** Where the next page starts: the last event's time (ns) and id. */
export interface SiteEventsCursor {
  t: string;
  id: string;
}

export class SiteEventsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteEventsInputError";
  }
}

function list(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function oneOf<T extends string>(
  name: string,
  values: string[],
  allowed: readonly T[],
): T[] {
  for (const v of values) {
    if (!(allowed as readonly string[]).includes(v)) {
      throw new SiteEventsInputError(`unknown ${name}: ${v}`);
    }
  }
  return values as T[];
}

/** The filters from the query string; {@link SiteEventsInputError} on a bad one. */
export function parseSiteEventFilters(query: {
  kinds?: string;
  levels?: string;
  services?: string;
  q?: string;
}): SiteEventFilters {
  const q = (query.q ?? "").trim();
  if (q.length > MAX_QUERY_LENGTH) {
    throw new SiteEventsInputError("q is too long");
  }
  return {
    kinds: oneOf("kind", list(query.kinds), SITE_EVENT_KINDS),
    levels: oneOf("level", list(query.levels), SITE_EVENT_LEVELS),
    services: list(query.services).slice(0, MAX_SERVICES),
    q,
  };
}

export function encodeSiteEventsCursor(cursor: SiteEventsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

/** The cursor; {@link SiteEventsInputError} when it isn't one this API wrote. */
export function decodeSiteEventsCursor(value: string): SiteEventsCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8"),
    ) as { t?: unknown; id?: unknown } | null;
    if (
      typeof parsed?.t === "string" &&
      /^\d{1,20}$/.test(parsed.t) &&
      typeof parsed.id === "string" &&
      /^[ls][0-9A-F]{1,16}$/.test(parsed.id)
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // falls through
  }
  throw new SiteEventsInputError("invalid cursor");
}

// --- SQL ----------------------------------------------------------------------

/**
 * One row per log and per span in the window, in a single shape. `id` is a
 * hash, prefixed by kind, that orders ties on `ts` for the cursor.
 */
const EVENTS = `(
    SELECT
      'log' AS kind,
      toUnixTimestamp64Nano(Timestamp) AS ts,
      concat('l', hex(cityHash64(Timestamp, TraceId, SpanId, SeverityNumber, Body))) AS id,
      multiIf(
        SeverityNumber >= 17, 'error',
        SeverityNumber >= 13, 'warn',
        SeverityNumber >= 9 OR SeverityNumber = 0, 'info',
        'debug') AS level,
      ServiceName AS service,
      Body AS message,
      CAST(NULL AS Nullable(Float64)) AS duration_ms,
      TraceId AS trace_id,
      SpanId AS span_id,
      CAST(LogAttributes, 'Map(String, String)') AS attributes
    FROM ${LOGS_TABLE}
    WHERE ${SITE_SCOPE}
      AND ${inWindow("Timestamp", "start")}
    UNION ALL
    SELECT
      'span' AS kind,
      toUnixTimestamp64Nano(Timestamp) AS ts,
      concat('s', hex(cityHash64(TraceId, SpanId))) AS id,
      if(StatusCode IN ('Error', 'STATUS_CODE_ERROR'), 'error', 'ok') AS level,
      ServiceName AS service,
      SpanName AS message,
      toNullable(toFloat64(Duration) / 1e6) AS duration_ms,
      TraceId AS trace_id,
      SpanId AS span_id,
      CAST(SpanAttributes, 'Map(String, String)') AS attributes
    FROM ${TRACES_TABLE}
    WHERE ${SITE_SCOPE}
      AND ${inWindow("Timestamp", "start")}
  )`;

type Filter = keyof SiteEventFilters;

/** The WHERE over {@link EVENTS} for every filter but `skip`. */
function where(f: SiteEventFilters, skip?: Filter): string {
  const clauses = ["1"];
  if (skip !== "kinds" && f.kinds.length)
    clauses.push("kind IN {kinds:Array(String)}");
  if (skip !== "levels" && f.levels.length)
    clauses.push("level IN {levels:Array(String)}");
  if (skip !== "services" && f.services.length)
    clauses.push("service IN {services:Array(String)}");
  if (skip !== "q" && f.q)
    clauses.push(
      "(positionCaseInsensitiveUTF8(message, {q:String}) > 0 OR trace_id = {q:String})",
    );
  return clauses.join(" AND ");
}

function params(
  slug: string,
  w: SiteWindow,
  f: SiteEventFilters,
): Record<string, unknown> {
  return {
    slug,
    start: w.startMs,
    end: w.endMs,
    step: w.stepS,
    kinds: f.kinds,
    levels: f.levels,
    services: f.services,
    q: f.q,
  };
}

export interface SiteEventsQuery {
  query: string;
  params: Record<string, unknown>;
}

/** One page of events, newest first, after the cursor. One extra row tells if there's more. */
export function eventsPageQuery(
  slug: string,
  w: SiteWindow,
  f: SiteEventFilters,
  cursor: SiteEventsCursor | null,
): SiteEventsQuery {
  return {
    query: `SELECT kind, ts, id, level, service, message, duration_ms, trace_id, span_id, attributes
      FROM ${EVENTS}
      WHERE ${where(f)}${cursor ? "\n        AND (ts, id) < ({cursor_t:Int64}, {cursor_id:String})" : ""}
      ORDER BY ts DESC, id DESC
      LIMIT {limit:UInt32}`,
    params: {
      ...params(slug, w, f),
      limit: SITE_EVENTS_PAGE_SIZE + 1,
      ...(cursor ? { cursor_t: cursor.t, cursor_id: cursor.id } : {}),
    },
  };
}

/** Counts per bucket and level, under every filter but the level. */
export function eventsHistogramQuery(
  slug: string,
  w: SiteWindow,
  f: SiteEventFilters,
): SiteEventsQuery {
  return {
    query: `SELECT
        intDiv(intDiv(ts, 1000000000), {step:UInt32}) * {step:UInt32} AS t,
        level,
        count() AS count
      FROM ${EVENTS}
      WHERE ${where(f, "levels")}
      GROUP BY t, level
      ORDER BY t`,
    params: params(slug, w, f),
  };
}

/** Counts per service, under every filter but the service. */
export function eventsServicesQuery(
  slug: string,
  w: SiteWindow,
  f: SiteEventFilters,
): SiteEventsQuery {
  return {
    query: `SELECT service AS name, count() AS count
      FROM ${EVENTS}
      WHERE ${where(f, "services")}
      GROUP BY name
      ORDER BY count DESC, name
      LIMIT ${MAX_SERVICES}`,
    params: params(slug, w, f),
  };
}

// --- Rows -> page -------------------------------------------------------------

/** 64-bit integers arrive quoted from JSONEachRow. */
type Num = number | string;
const n = (v: Num | null | undefined): number => Number(v ?? 0) || 0;

export interface EventRow {
  kind: SiteEventKind;
  ts: Num;
  id: string;
  level: SiteEventLevel;
  service: string;
  message: string;
  duration_ms: number | null;
  trace_id: string;
  span_id: string;
  attributes: Record<string, string> | null;
}

export interface SiteEvent {
  id: string;
  timestamp: string;
  kind: SiteEventKind;
  level: SiteEventLevel;
  service: string;
  message: string;
  durationMs: number | null;
  traceId: string | null;
  spanId: string | null;
  attributes: Record<string, string>;
}

type LevelCounts = Record<SiteEventLevel, number>;

export interface SiteEventsPage {
  total: number;
  histogram: (LevelCounts & { t: string })[];
  facets: {
    levels: LevelCounts;
    services: { name: string; count: number }[];
  };
  events: SiteEvent[];
  nextCursor: string | null;
}

const zeroLevels = (): LevelCounts => ({
  error: 0,
  warn: 0,
  info: 0,
  ok: 0,
  debug: 0,
});

/** Nanoseconds since the epoch, as ISO 8601 (to the millisecond). */
function isoFromNs(ts: Num): string {
  return new Date(Number(BigInt(String(ts)) / 1_000_000n)).toISOString();
}

export function toEvent(r: EventRow): SiteEvent {
  return {
    id: r.id,
    timestamp: isoFromNs(r.ts),
    kind: r.kind,
    level: r.level,
    service: r.service,
    message: r.message,
    durationMs: r.duration_ms === null ? null : n(r.duration_ms),
    traceId: r.trace_id || null,
    spanId: r.span_id || null,
    attributes: r.attributes ?? {},
  };
}

/** One bucket per step over the whole window, oldest first, empty ones included. */
export function toHistogram(
  rows: { t: Num; level: SiteEventLevel; count: Num }[],
  w: SiteWindow,
): (LevelCounts & { t: string })[] {
  const byT = new Map<number, LevelCounts>();
  for (const r of rows) {
    const t = n(r.t);
    const counts = byT.get(t) ?? zeroLevels();
    if (Object.hasOwn(counts, r.level)) counts[r.level] += n(r.count);
    byT.set(t, counts);
  }
  const out: (LevelCounts & { t: string })[] = [];
  for (let t = w.startMs / 1000; t < w.endMs / 1000; t += w.stepS) {
    out.push({
      t: new Date(t * 1000).toISOString(),
      ...(byT.get(t) ?? zeroLevels()),
    });
  }
  return out;
}

/** Reads one page for a site the caller already checked the org owns. */
export async function querySiteEvents(
  run: RunQuery,
  slug: string,
  w: SiteWindow,
  f: SiteEventFilters,
  cursor: SiteEventsCursor | null,
): Promise<SiteEventsPage> {
  const page = eventsPageQuery(slug, w, f, cursor);
  const counted = !cursor;
  const hist = counted ? eventsHistogramQuery(slug, w, f) : null;
  const svc = counted ? eventsServicesQuery(slug, w, f) : null;
  const [rows, histRows, svcRows] = await Promise.all([
    run<EventRow>(page.query, page.params),
    hist
      ? run<{ t: Num; level: SiteEventLevel; count: Num }>(
          hist.query,
          hist.params,
        )
      : Promise.resolve([]),
    svc
      ? run<{ name: string; count: Num }>(svc.query, svc.params)
      : Promise.resolve([]),
  ]);

  const more = rows.length > SITE_EVENTS_PAGE_SIZE;
  const events = rows.slice(0, SITE_EVENTS_PAGE_SIZE).map(toEvent);
  const last = rows[SITE_EVENTS_PAGE_SIZE - 1];
  const nextCursor =
    more && last
      ? encodeSiteEventsCursor({ t: String(last.ts), id: last.id })
      : null;

  const histogram = counted ? toHistogram(histRows, w) : [];
  const levels = zeroLevels();
  for (const b of histogram)
    for (const l of SITE_EVENT_LEVELS) levels[l] += b[l];
  const totalLevels: readonly SiteEventLevel[] = f.levels.length
    ? f.levels
    : SITE_EVENT_LEVELS;
  let total = 0;
  for (const l of totalLevels) total += levels[l];
  return {
    total,
    histogram,
    facets: {
      levels,
      services: svcRows.map((r) => ({ name: r.name, count: n(r.count) })),
    },
    events,
    nextCursor,
  };
}
