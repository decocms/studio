/**
 * What a hosted site actually serves, from its own telemetry.
 *
 * The Blocks v8 runtime labels every telemetry batch with the release it
 * serves (`deco.release` on the resource): a release loaded from the CDN is
 * its commit sha (40 hex); the bundled snapshot is its content revision,
 * `computeContentRevision(blocks)` (64 hex). The ingest at otel.decocms.com
 * names the service after the site token's site, and the rows land in the
 * stats-lake ClickHouse that Studio's monitoring already reads
 * (`CLICKHOUSE_URL`).
 *
 * Two sources, each optional: the upstream-fetch histogram
 * (`otel_metrics_histogram`, needs `studio_reader` SELECT on it) and the
 * sampled error logs (`otel_logs`). A source that fails (no grant, no table,
 * a timeout) is skipped; none answering is "no signal", never an error. A
 * site with telemetry off, a custom endpoint or no traffic reports nothing:
 * Releases then falls back to latest.json and says so.
 */

import { computeContentRevision } from "@decocms/blocks/protocol";
import { ClickHouseClientEngine } from "@/monitoring/query-engine";
import { getSettings } from "@/settings";

/** One release label the site reported in the window. */
export interface ServedLabel {
  /** A commit sha (40 hex) or a bundled snapshot's content revision (64 hex). */
  label: string;
  /** ISO time of the last report. */
  lastSeen: string;
}

/** Reads the labels site `site` reported in the last `minutes`. */
export type ServedLabelsReader = (
  site: string,
  minutes: number,
) => Promise<ServedLabel[] | null>;

export const SERVING_WINDOW_MINUTES = 15;
const QUERY_TIMEOUT_MS = 5_000;

const HISTOGRAM_SQL = `
SELECT ResourceAttributes['deco.release'] AS label, max(TimeUnix) AS last_seen
FROM default.otel_metrics_histogram
WHERE ServiceName = {site:String}
  AND MetricName = 'http.client.request.duration'
  AND TimeUnix >= now64() - INTERVAL {minutes:UInt32} MINUTE
GROUP BY label`;

const LOGS_SQL = `
SELECT ResourceAttributes['deco.release'] AS label, max(Timestamp) AS last_seen
FROM default.otel_logs
WHERE ServiceName = {site:String}
  AND Timestamp >= now64() - INTERVAL {minutes:UInt32} MINUTE
GROUP BY label`;

type Row = Record<string, unknown>;
type Query = (sql: string, params: Record<string, unknown>) => Promise<Row[]>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** ClickHouse renders DateTime64 as `YYYY-MM-DD hh:mm:ss.fff…` in UTC. */
function isoOf(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text =
    typeof value === "string" && !value.includes("T")
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const LABEL_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The reader over a query function: both sources, merged per label (the
 * later report wins). Null when no source answered.
 */
export function servedLabelsReader(query: Query): ServedLabelsReader {
  return async (site, minutes) => {
    const params = { site, minutes };
    const results = await Promise.allSettled(
      [HISTOGRAM_SQL, LOGS_SQL].map((sql) =>
        withTimeout(query(sql, params), QUERY_TIMEOUT_MS),
      ),
    );
    const answered = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    if (answered.length === 0) return null;
    const latest = new Map<string, string>();
    for (const row of answered.flat()) {
      const label =
        typeof row.label === "string" ? row.label.toLowerCase() : "";
      const lastSeen = isoOf(row.last_seen);
      if (!LABEL_RE.test(label) || !lastSeen) continue;
      const known = latest.get(label);
      if (!known || known < lastSeen) latest.set(label, lastSeen);
    }
    return [...latest]
      .map(([label, lastSeen]) => ({ label, lastSeen }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  };
}

let defaultReader: ServedLabelsReader | null | undefined;

/** The reader on Studio's ClickHouse, or null when none is configured. */
export function defaultServedLabelsReader(): ServedLabelsReader | null {
  if (defaultReader !== undefined) return defaultReader;
  const url = getSettings().clickhouseUrl;
  if (!url) {
    defaultReader = null;
    return null;
  }
  const engine = new ClickHouseClientEngine(url, { maxExecutionTime: 5 });
  defaultReader = servedLabelsReader((sql, params) =>
    engine.query(sql, params),
  );
  return defaultReader;
}

/** Content revision per commit sha: releases are immutable. */
const contentRevisionMemo = new Map<string, string>();
const MEMO_CAP = 2_000;

/**
 * The content revision of commit `sha`'s release, given a way to read its
 * blocks; memoized for the process.
 */
export async function contentRevisionOf(
  sha: string,
  readBlocks: () => Promise<Record<string, unknown> | null>,
): Promise<string | null> {
  const known = contentRevisionMemo.get(sha);
  if (known) return known;
  const blocks = await readBlocks();
  if (!blocks) return null;
  const revision = await computeContentRevision(blocks);
  if (contentRevisionMemo.size >= MEMO_CAP) contentRevisionMemo.clear();
  contentRevisionMemo.set(sha, revision);
  return revision;
}
