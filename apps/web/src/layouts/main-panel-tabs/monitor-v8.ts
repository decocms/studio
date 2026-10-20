/**
 * Pure pieces of the Blocks v8 Monitor (`monitor-v8-tab.tsx`): the answer
 * shapes of `/api/:org/monitor/:site/site/data` (apps/api
 * `monitor-site.ts`), which view a project opens, and the formatting the
 * tiles, tables and charts share.
 */
import type { MainSchemaAnswer } from "@/hooks/use-main-schema-v8";

export const SITE_RANGES = ["1h", "24h", "7d"] as const;
export type SiteRange = (typeof SITE_RANGES)[number];

export type SiteSection = "site" | "upstreams" | "errors";

export type EmptyReason =
  | "no_telemetry"
  | "server_metric_missing"
  | "no_requests";

export interface SitePeriod {
  requests: number;
  errors5xx: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  cacheHitRate: number | null;
}

export interface SiteSummary {
  current: SitePeriod;
  previous: SitePeriod;
  perSecond: number;
}

export interface TimelinePoint {
  t: number;
  requests: number;
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  p95Ms: number | null;
}

export interface RouteRow {
  route: string;
  requests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number | null;
}

export interface UpstreamRow {
  provider: string;
  operation: string;
  calls: number;
  p95Ms: number | null;
  errorRate: number | null;
  cachedRate: number | null;
}

export interface ErrorRow {
  message: string;
  route: string;
  code: string;
  source: string;
  count: number;
  lastSeenMs: number;
}

export interface ReleaseMarker {
  release: string;
  firstSeenMs: number;
}

export interface SiteWindow {
  startMs: number;
  endMs: number;
  stepS: number;
}

/** One view's answer: `available: false` when the warehouse isn't wired. */
export interface SiteViewAnswer<T> {
  available: boolean;
  data: T | null;
  reason?: EmptyReason;
  window?: SiteWindow;
}

/**
 * Which Monitor a project opens. Main's schema decides (the same answer as
 * the editor's): a v8 site gets the telemetry Monitor, and so does a site
 * last found v8 whose main can't be read right now (`"error"`); a v7 site
 * keeps the CDN Monitor. While main is being read, neither is shown, so a
 * v8 site never flashes the CDN view first.
 */
export function monitorKind(answer: MainSchemaAnswer): "v8" | "v7" | "loading" {
  if (answer === "loading") return "loading";
  return answer === "v7" ? "v7" : "v8";
}

/** The relative change from `previous` to `current`, or null when it can't be said. */
export function relativeChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * Whether a change is good, bad or neither for the tile it sits on: more
 * errors or a slower response is bad, more cache hits is good, traffic is
 * neither. Changes under 1% are neither.
 */
export function changeTone(
  change: number | null,
  better: "up" | "down" | "none",
): "good" | "bad" | "neutral" {
  if (change === null || better === "none" || Math.abs(change) < 0.01) {
    return "neutral";
  }
  return change > 0 === (better === "up") ? "good" : "bad";
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/** A share (0..1) as a percentage: one decimal under 10%, none above. */
export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "—";
  const pct = share * 100;
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: n >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
}

/** A rate per second, or per minute when it's under one a second. */
export function formatRate(perSecond: number): {
  value: string;
  unit: "s" | "min";
} {
  if (perSecond >= 1)
    return { value: formatCount(Math.round(perSecond)), unit: "s" };
  const perMinute = perSecond * 60;
  return {
    value:
      perMinute >= 10 || perMinute === 0
        ? formatCount(Math.round(perMinute))
        : perMinute.toFixed(1),
    unit: "min",
  };
}

/** The chart's x-axis label for a bucket start: clock time, with the day on 7d. */
export function bucketLabel(
  t: number,
  range: SiteRange,
  locale?: string,
): string {
  return new Intl.DateTimeFormat(
    locale,
    range === "7d"
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" },
  ).format(new Date(t));
}

/**
 * The timeline bucket a release first showed up in, so its marker sits on a
 * point of the chart. Null when it falls outside the window.
 */
export function releaseBucket(
  firstSeenMs: number,
  window: SiteWindow,
): number | null {
  if (firstSeenMs < window.startMs || firstSeenMs >= window.endMs) return null;
  const stepMs = window.stepS * 1000;
  return (
    window.startMs +
    Math.floor((firstSeenMs - window.startMs) / stepMs) * stepMs
  );
}

/** A release id as people read it: the first 7 characters of the hash. */
export function shortRelease(release: string): string {
  return release.slice(0, 7);
}

/** How long ago, in the largest whole unit: "now", "5 min", "3 h", "2 d". */
export function sinceLabel(
  thenMs: number,
  nowMs: number,
): { count: number; unit: "now" | "min" | "h" | "d" } {
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return { count: 0, unit: "now" };
  if (minutes < 60) return { count: minutes, unit: "min" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { count: hours, unit: "h" };
  return { count: Math.floor(hours / 24), unit: "d" };
}
