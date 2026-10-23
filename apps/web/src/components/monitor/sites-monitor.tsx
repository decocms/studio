/**
 * The site Monitor's Performance view, summed across sites: the same stats and
 * usage chart a project's Monitor shows, then one line per site. The org's
 * Analytics draws it from every site's numbers; the locked tab draws it from
 * preview numbers, faded.
 */

import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Card,
  type CdnSummary,
  formatBytes,
  formatNumber,
  formatPct,
  Stat,
  type TimelinePoint,
  UsageChart,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { useT } from "@/i18n/use-t.ts";

export interface SiteUsage {
  id: string;
  name: ReactNode;
  summary: CdnSummary;
  link?: LinkProps;
}

const EMPTY_SUMMARY: CdnSummary = {
  total_requests: 0,
  total_bandwidth_bytes: 0,
  cache_hit_ratio: 0,
  avg_latency_ms: 0,
  status_2xx_count: 0,
  status_4xx_count: 0,
  status_5xx_count: 0,
  unique_countries: 0,
  pageviews: 0,
};

/** Counts add up; cache hit and latency are weighted by each site's requests. */
export function sumSummaries(list: readonly CdnSummary[]): CdnSummary {
  const total = list.reduce(
    (acc, s) => ({
      total_requests: acc.total_requests + s.total_requests,
      total_bandwidth_bytes:
        acc.total_bandwidth_bytes + s.total_bandwidth_bytes,
      cache_hit_ratio:
        acc.cache_hit_ratio + s.cache_hit_ratio * s.total_requests,
      avg_latency_ms: acc.avg_latency_ms + s.avg_latency_ms * s.total_requests,
      status_2xx_count: acc.status_2xx_count + s.status_2xx_count,
      status_4xx_count: acc.status_4xx_count + s.status_4xx_count,
      status_5xx_count: acc.status_5xx_count + s.status_5xx_count,
      unique_countries: Math.max(acc.unique_countries, s.unique_countries),
      pageviews: acc.pageviews + s.pageviews,
    }),
    EMPTY_SUMMARY,
  );
  const requests = total.total_requests || 1;
  return {
    ...total,
    cache_hit_ratio: total.cache_hit_ratio / requests,
    avg_latency_ms: total.avg_latency_ms / requests,
  };
}

/** Every site's points added up per bucket, in bucket order. */
export function sumTimelines(
  list: readonly (readonly TimelinePoint[])[],
): TimelinePoint[] {
  const byBucket = new Map<string, TimelinePoint>();
  for (const point of list.flat()) {
    const prev = byBucket.get(point.bucket);
    byBucket.set(
      point.bucket,
      prev
        ? {
            bucket: point.bucket,
            requests: prev.requests + point.requests,
            bandwidth_bytes: prev.bandwidth_bytes + point.bandwidth_bytes,
            pageviews: prev.pageviews + point.pageviews,
            cache_hit_ratio: prev.cache_hit_ratio,
          }
        : { ...point },
    );
  }
  return [...byBucket.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );
}

const COLS =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,6rem)] md:grid-cols-[minmax(0,1fr)_repeat(4,7rem)] items-center gap-3";

function SiteCells({ summary }: { summary: CdnSummary }) {
  return (
    <>
      <span className="tnum text-right text-foreground">
        {formatNumber(summary.total_requests)}
      </span>
      <span className="tnum text-right text-muted-foreground">
        {formatNumber(summary.pageviews)}
      </span>
      <span className="tnum text-right text-muted-foreground">
        {formatBytes(summary.total_bandwidth_bytes)}
      </span>
      <span className="tnum hidden text-right text-muted-foreground md:block">
        {formatPct(summary.cache_hit_ratio)}
      </span>
    </>
  );
}

export function SitesMonitor({
  summary,
  timeline,
  sites,
  loading,
}: {
  summary: CdnSummary | null;
  timeline: readonly TimelinePoint[];
  sites: readonly SiteUsage[];
  loading: boolean;
}) {
  const t = useT();
  const s = summary;
  const reqPerPv = s && s.pageviews > 0 ? s.total_requests / s.pageviews : null;
  const bwPer10kPv =
    s && s.pageviews > 0
      ? s.total_bandwidth_bytes / (s.pageviews / 10000)
      : null;
  const row = "h-10 rounded-lg px-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      {loading || !s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={t("mainPanelTabs.cdnTab.requests")}
            value={formatNumber(s.total_requests)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.pageviews")}
            value={formatNumber(s.pageviews)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.bandwidth")}
            value={formatBytes(s.total_bandwidth_bytes)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.cacheHit")}
            value={formatPct(s.cache_hit_ratio)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.requestsPerPageview")}
            value={reqPerPv === null ? "—" : reqPerPv.toFixed(1)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.bandwidthPer10k")}
            value={bwPer10kPv === null ? "—" : formatBytes(bwPer10kPv)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.avgLatency")}
            value={`${Math.round(s.avg_latency_ms)} ms`}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.errors5xx")}
            value={formatNumber(s.status_5xx_count)}
          />
        </div>
      )}

      <UsageChart points={timeline} loading={loading} />

      <Card title={t("monitor.orgAnalytics.sites")}>
        <div className="-mx-2 -my-1 flex flex-col">
          <div className={cn(COLS, "px-2 pb-1 text-meta")}>
            <span>{t("monitor.filter.project")}</span>
            <span className="text-right">
              {t("mainPanelTabs.cdnTab.requests")}
            </span>
            <span className="text-right">
              {t("mainPanelTabs.cdnTab.pageviews")}
            </span>
            <span className="text-right">
              {t("mainPanelTabs.cdnTab.bandwidth")}
            </span>
            <span className="hidden text-right md:block">
              {t("mainPanelTabs.cdnTab.cacheHit")}
            </span>
          </div>
          {loading && sites.length === 0 && (
            <Skeleton className="mx-2 my-3 h-4" />
          )}
          {sites.map((site) =>
            site.link ? (
              <Link
                key={site.id}
                {...site.link}
                className={cn(
                  COLS,
                  row,
                  "transition-colors hover:bg-accent/50",
                )}
              >
                <span className="min-w-0 text-foreground">{site.name}</span>
                <SiteCells summary={site.summary} />
              </Link>
            ) : (
              <div key={site.id} className={cn(COLS, row)}>
                <span className="min-w-0 text-foreground">{site.name}</span>
                <SiteCells summary={site.summary} />
              </div>
            ),
          )}
        </div>
      </Card>
    </div>
  );
}
