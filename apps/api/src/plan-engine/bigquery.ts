/**
 * The engine's one path to BigQuery (`callBigQuery`, with its scan
 * accounting) and the GA4 PDP-views query the collect step reads.
 */

import type { BigQueryRunner } from "./ports.ts";

const BIGQUERY_PAGE_SIZE = 5000;

interface BigQueryResponse {
  rows: Record<string, unknown>[];
  nextPageToken?: string;
  // Unreported reads as unknown (null), never as a free query; int64 arrives as a string.
  totalBytesProcessed?: string | number;
  totalBytesBilled?: string | number;
  cacheHit?: boolean;
}

/** On-demand analysis price, USD per TiB; the GCP bill is the real figure. */
const BIGQUERY_USD_PER_TIB = 6.25;
const BYTES_PER_TIB = 1024 ** 4;

/** One BigQuery call's cost footprint. */
export interface BigQueryScan {
  /** Which fetcher issued it, so a spike can be traced to a query. */
  label: string;
  /** null when the connector didn't report it — NOT the same as zero. */
  bytesProcessed: number | null;
  bytesBilled: number | null;
  cacheHit: boolean | null;
  rows: number;
}

function bytesOf(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function scanCostUsd(bytesBilled: number | null): number | null {
  if (bytesBilled === null) return null;
  return (bytesBilled / BYTES_PER_TIB) * BIGQUERY_USD_PER_TIB;
}

export type ScanSink = (scan: BigQueryScan) => void;

/**
 * Every query goes through here, so each scan's bytes are reported the same
 * way. The connector's `bigquery_query` has no per-query byte ceiling; a hard
 * cap has to be a GCP project quota.
 */
export async function callBigQuery(
  run: BigQueryRunner,
  toolArgs: Record<string, unknown>,
  ctx: { label: string; onScan?: ScanSink },
): Promise<BigQueryResponse> {
  const data = (await run(toolArgs)) as BigQueryResponse;
  ctx.onScan?.({
    label: ctx.label,
    bytesProcessed: bytesOf(data?.totalBytesProcessed),
    bytesBilled: bytesOf(data?.totalBytesBilled),
    cacheHit: typeof data?.cacheHit === "boolean" ? data.cacheHit : null,
    rows: Array.isArray(data?.rows) ? data.rows.length : 0,
  });
  return data;
}

const GA4_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/** `YYYYMMDD` of `daysAgo` days before `now`, in UTC (the export's suffix). */
function ga4Suffix(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/**
 * `view_item` events per product on the web over the last `days` complete
 * days. A numeric suffix range already leaves `events_intraday_*` out, and
 * only narrow columns are read: no event_params, which is what makes GA4
 * queries expensive. `item_id` is the VTEX product id.
 */
export function buildPdpViewsQuery(
  projectId: string,
  datasetId: string,
  days: number,
  now: Date = new Date(),
): string {
  if (!GA4_IDENTIFIER.test(projectId) || !GA4_IDENTIFIER.test(datasetId)) {
    throw new Error(
      `invalid GA4 project/dataset: ${JSON.stringify(projectId)}.${JSON.stringify(datasetId)}`,
    );
  }
  return `
SELECT item.item_id AS product_id, COUNT(*) AS views
FROM \`${projectId}.${datasetId}.events_*\`, UNNEST(items) AS item
WHERE _TABLE_SUFFIX BETWEEN '${ga4Suffix(now, days)}' AND '${ga4Suffix(now, 1)}'
  AND event_name = 'view_item'
  AND platform = 'WEB'
  AND item.item_id IS NOT NULL
GROUP BY product_id
`;
}

interface PdpViews {
  product_id: string;
  views: number;
}

/** Runs {@link buildPdpViewsQuery} and pages through every product. */
export async function fetchPdpViews(
  run: BigQueryRunner,
  projectId: string,
  datasetId: string,
  opts: { days?: number; onScan?: ScanSink } = {},
): Promise<PdpViews[]> {
  const sql = buildPdpViewsQuery(projectId, datasetId, opts.days ?? 7);
  const rows: Record<string, unknown>[] = [];
  let nextPageToken: string | undefined;
  // The cap only guards against a runaway result.
  for (let page = 1; page <= 10; page++) {
    const toolArgs = nextPageToken
      ? { projectId, pageToken: nextPageToken, maxResults: BIGQUERY_PAGE_SIZE }
      : { projectId, query: sql.trim(), maxResults: BIGQUERY_PAGE_SIZE };
    const data = await callBigQuery(run, toolArgs, {
      label: nextPageToken ? `fetchPdpViews:page${page}` : "fetchPdpViews",
      onScan: opts.onScan,
    });
    if (data.rows) rows.push(...data.rows);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return rows
    .map((row) => ({
      product_id: String(row.product_id ?? ""),
      views: Number(row.views ?? 0),
    }))
    .filter((r) => /^\d+$/.test(r.product_id) && r.views > 0);
}
