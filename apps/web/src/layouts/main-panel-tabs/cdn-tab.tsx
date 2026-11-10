/**
 * CdnTab (displayed as "Monitor") — per-site CDN + audience analytics,
 * tenant-scoped.
 *
 * The native, first-class replacement for the old deco.cx admin "Monitor"
 * surface (previously embedded as an MCP-UI iframe). It mirrors that surface's
 * two sub-tabs:
 *   - Performance — CDN / edge facts (requests, pageviews, bandwidth, cache,
 *     status codes, top paths/countries) from the stats-lake `fact_usage_*` and
 *     `fact_analytics_*` views.
 *   - Audience — pageviews / visitors / sessions and their breakdowns from
 *     `fact_analytics_daily_view` — the native replacement for the old admin's
 *     OneDollarStats widget.
 *
 * Both halves read through the BFF at `/api/:org/monitor/:site/{cdn|audience}/
 * data?view=&range=`, which resolves the site_id from a slug the org owns and
 * never lets one tenant read another's numbers. No control-plane, no Supabase,
 * no upstream token in the browser.
 */

export interface RangeSel {
  range: string;
  since: string;
  until: string;
  compare: boolean;
}

export function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Bytes → a compact human unit (B / KB / MB / GB / TB). */
export function formatBytes(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatPct(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

// Cache-status and HTTP status dot colors, plus friendly status-code names.
const CACHE_COLORS: Record<string, string> = {
  hit: "bg-success",
  dynamic: "bg-notice",
  bypass: "bg-project-purple",
  miss: "bg-warning",
  expired: "bg-project-red",
  stale: "bg-project-amber",
  revalidated: "bg-chart-5",
  updating: "bg-subtle-foreground",
  none: "bg-muted-foreground",
};
export function cacheColor(k: string): string {
  return CACHE_COLORS[k.toLowerCase()] ?? "bg-muted-foreground";
}
export function statusColor(code: string): string {
  const n = Number(code);
  if (n >= 200 && n < 300) return "bg-success";
  if (n >= 300 && n < 400) return "bg-notice";
  if (n >= 400 && n < 500) return "bg-warning";
  if (n >= 500) return "bg-destructive";
  return "bg-muted-foreground";
}
const STATUS_NAMES: Record<string, string> = {
  "200": "200 OK",
  "201": "201 Created",
  "204": "204 No Content",
  "206": "206 Partial Content",
  "301": "301 Moved Permanently",
  "302": "302 Found",
  "304": "304 Not Modified",
  "307": "307 Temporary Redirect",
  "308": "308 Permanent Redirect",
  "400": "400 Bad Request",
  "401": "401 Unauthorized",
  "403": "403 Forbidden",
  "404": "404 Not Found",
  "410": "410 Gone",
  "429": "429 Too Many Requests",
  "499": "499 Client Closed Request",
  "500": "500 Internal Server Error",
  "502": "502 Bad Gateway",
  "503": "503 Service Unavailable",
  "504": "504 Gateway Timeout",
};
export function statusName(code: string): string {
  return STATUS_NAMES[code] ?? code;
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(err);
  }
  return body;
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
  pageviews: number;
}
export interface TimelinePoint {
  bucket: string;
  requests: number;
  bandwidth_bytes: number;
  pageviews: number;
  cache_hit_ratio: number;
}
export interface BreakdownRow {
  key: string;
  total_requests: number;
  total_bandwidth_bytes: number;
}

/** ISO 3166-1 alpha-2 → localized country name (e.g. "BR" → "Brazil"), so the
 *  breakdowns read like the old admin rather than showing raw codes. */
const REGION_NAMES = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();
export function formatCountry(code: string): string {
  if (!code) return "—";
  const up = code.toUpperCase();
  if (up.length !== 2) return code;
  try {
    return REGION_NAMES?.of(up) ?? code;
  } catch {
    return code;
  }
}
