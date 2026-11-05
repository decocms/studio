/**
 * Site traffic across the org, laid out like the Metrics board: one day's
 * pageviews as the headline chart, then requests, bandwidth and cache hits,
 * each against the same day a week before, then one row per site. The org's Analytics draws it from
 * every site's Monitor numbers; the locked tab draws it from preview numbers,
 * faded.
 */

import type { ReactNode } from "react";
import { type LinkProps, useNavigate } from "@tanstack/react-router";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import {
  type CdnSummary,
  formatBytes,
  formatNumber,
  formatPct,
  type TimelinePoint,
} from "@/layouts/main-panel-tabs/cdn-tab";
import { relativeChange } from "@/layouts/main-panel-tabs/monitor-v8";
import { MetricCard } from "@/layouts/task-board/analytics-sections";
import { Change, Trend } from "./parts";
import { Sparkline } from "./sparkline";

export interface SiteUsage {
  id: string;
  name: ReactNode;
  summary: CdnSummary;
  previous: CdnSummary | null;
  /** Pageviews per bucket, this day and the same day a week before. */
  series: readonly number[];
  previousSeries: readonly number[];
  link?: LinkProps;
}

export interface SitesMonitorData {
  /** What the plotted day is called, e.g. "Today" or "Oct 21". */
  currentLabel: string;
  summary: CdnSummary;
  previous: CdnSummary | null;
  timeline: readonly TimelinePoint[];
  previousTimeline: readonly TimelinePoint[];
  sites: readonly SiteUsage[];
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
    if (!prev) {
      byBucket.set(point.bucket, { ...point });
      continue;
    }
    const requests = prev.requests + point.requests;
    byBucket.set(point.bucket, {
      bucket: point.bucket,
      requests,
      bandwidth_bytes: prev.bandwidth_bytes + point.bandwidth_bytes,
      pageviews: prev.pageviews + point.pageviews,
      // Weighted by requests, as the summary's is.
      cache_hit_ratio:
        requests === 0
          ? 0
          : (prev.cache_hit_ratio * prev.requests +
              point.cache_hit_ratio * point.requests) /
            requests,
    });
  }
  return [...byBucket.values()].sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );
}

// --- cards ---------------------------------------------------------------------

type CardId = "pageviews" | "requests" | "bandwidth" | "cache";

const SIDE_CARDS: readonly CardId[] = ["requests", "bandwidth", "cache"];

const COLOR_CURRENT = "var(--chart-1)";
const COLOR_PREVIOUS = "var(--muted-foreground)";
const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" };

/** Whether anything measures this card: requests only exist for traffic the
 *  deco CDN serves, pageviews only for a site with the analytics tag. A zero
 *  from neither is no data, not no traffic. */
// ponytail: a CDN or tagged site with a truly empty day reads as not instrumented too
const measured = (id: CardId, s: CdnSummary) =>
  id === "pageviews" ? s.pageviews > 0 : s.total_requests > 0;

/** Traffic going up is good; cache hits are too. Nothing here is bad going up. */
const BETTER: Record<CardId, "up" | "none"> = {
  pageviews: "up",
  requests: "none",
  bandwidth: "none",
  cache: "up",
};

function cardValue(id: CardId, s: CdnSummary): number {
  switch (id) {
    case "pageviews":
      return s.pageviews;
    case "requests":
      return s.total_requests;
    case "bandwidth":
      return s.total_bandwidth_bytes;
    case "cache":
      return s.cache_hit_ratio;
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

function pointValue(id: CardId, p: TimelinePoint): number {
  switch (id) {
    case "pageviews":
      return p.pageviews;
    case "requests":
      return p.requests;
    case "bandwidth":
      return p.bandwidth_bytes;
    case "cache":
      return p.cache_hit_ratio;
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

function formatCard(id: CardId, value: number): string {
  switch (id) {
    case "pageviews":
    case "requests":
      return formatNumber(value);
    case "bandwidth":
      return formatBytes(value);
    case "cache":
      return formatPct(value);
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatTick(id: CardId, value: number): string {
  switch (id) {
    case "pageviews":
    case "requests":
      return compact.format(value);
    case "bandwidth":
      return formatBytes(value);
    case "cache":
      return `${Math.round(value * 100)}%`;
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

/** A day reads as "10-21"; an hour of a single day as "14:00". */
const bucketLabel = (bucket: string) =>
  bucket.length > 10 ? bucket.slice(11, 16) : bucket.slice(5, 10);

function useCardLabel() {
  const t = useT();
  return (id: CardId) => {
    switch (id) {
      case "pageviews":
        return t("mainPanelTabs.cdnTab.pageviews");
      case "requests":
        return t("mainPanelTabs.cdnTab.requests");
      case "bandwidth":
        return t("mainPanelTabs.cdnTab.bandwidth");
      case "cache":
        return t("mainPanelTabs.cdnTab.cacheHit");
      default: {
        const unhandled: never = id;
        return unhandled;
      }
    }
  };
}

function TrendPlot({
  id,
  timeline,
  previousTimeline,
  currentLabel,
  tall,
}: {
  id: CardId;
  timeline: readonly TimelinePoint[];
  previousTimeline: readonly TimelinePoint[];
  currentLabel: string;
  tall: boolean;
}) {
  const t = useT();
  const label = useCardLabel();
  const gradient = `sites-${id}`;
  // The period before, laid over this one bucket by bucket.
  const data = timeline.map((p, i) => {
    const before = previousTimeline[i];
    return {
      bucket: bucketLabel(p.bucket),
      value: pointValue(id, p),
      reference: before ? pointValue(id, before) : null,
    };
  });
  return (
    <ChartContainer
      role="img"
      aria-label={label(id)}
      className={cn("w-full", tall ? "h-[150px] md:h-[170px]" : "h-[110px]")}
      config={{
        value: {
          label: currentLabel,
          color: COLOR_CURRENT,
        },
        reference: {
          label: t("monitor.compare.w1"),
          color: COLOR_PREVIOUS,
        },
      }}
    >
      <ComposedChart data={data} margin={{ left: 0, right: 0, top: 4 }}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_CURRENT} stopOpacity={0.18} />
            <stop offset="100%" stopColor={COLOR_CURRENT} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="4 4"
          stroke="var(--border)"
          strokeOpacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="bucket"
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          tickMargin={8}
          minTickGap={24}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={AXIS_TICK}
          width={52}
          tickCount={4}
          tickFormatter={(v: number) => formatTick(id, v)}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {name === "reference"
                      ? t("monitor.compare.w1")
                      : currentLabel}
                  </span>
                  <span className="tnum text-foreground">
                    {formatCard(id, Number(value))}
                  </span>
                </span>
              )}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="reference"
          stroke={COLOR_PREVIOUS}
          strokeOpacity={0.55}
          strokeWidth={1.25}
          strokeDasharray="4 4"
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={COLOR_CURRENT}
          strokeWidth={2}
          fill={`url(#${gradient})`}
          dot={false}
          activeDot={{ r: 3, stroke: "var(--background)", strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

/**
 * The card's figure for the week before, over the hours the day on screen has
 * so far: a day still running is held against the same hours, not a whole day.
 */
function previousValue(id: CardId, data: SitesMonitorData): number | null {
  if (data.timeline.length === 0) {
    return data.previous ? cardValue(id, data.previous) : null;
  }
  const hours = data.previousTimeline.slice(0, data.timeline.length);
  if (hours.length === 0) return null;
  if (id === "cache") {
    const requests = hours.reduce((n, p) => n + p.requests, 0);
    return requests === 0
      ? null
      : hours.reduce((n, p) => n + p.cache_hit_ratio * p.requests, 0) /
          requests;
  }
  return hours.reduce((n, p) => n + pointValue(id, p), 0);
}

function TrafficCard({
  id,
  data,
  tall = false,
}: {
  id: CardId;
  data: SitesMonitorData;
  tall?: boolean;
}) {
  const t = useT();
  const label = useCardLabel();
  const value = cardValue(id, data.summary);
  if (!measured(id, data.summary)) {
    return (
      <MetricCard
        title={label(id)}
        value={<NotInstrumented className="text-base" />}
        caption={
          <span className="text-meta">
            {t(
              id === "pageviews"
                ? "monitor.orgAnalytics.noTag"
                : "monitor.orgAnalytics.noCdn",
            )}
          </span>
        }
      />
    );
  }
  return (
    <MetricCard
      title={label(id)}
      value={formatCard(id, value)}
      caption={
        <Trend
          change={relativeChange(value, previousValue(id, data))}
          better={BETTER[id]}
          reference={t("monitor.compare.vs", {
            ref: t("monitor.compare.w1"),
          })}
        />
      }
    >
      {data.timeline.length > 0 && (
        <TrendPlot
          id={id}
          timeline={data.timeline}
          previousTimeline={data.previousTimeline}
          currentLabel={data.currentLabel}
          tall={tall}
        />
      )}
    </MetricCard>
  );
}

// --- sites ---------------------------------------------------------------------

const DASH = <span className="text-meta">–</span>;

function NotInstrumented({ className }: { className?: string }) {
  const t = useT();
  return (
    <span className={cn("text-muted-foreground", className)}>
      {t("monitor.orgAnalytics.notInstrumented")}
    </span>
  );
}

function SitesTable({ sites }: { sites: readonly SiteUsage[] }) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <SettingsSection title={t("monitor.orgAnalytics.sites")}>
      <div className="surface overflow-x-auto">
        <Table variant="flush">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">
                {t("monitor.filter.project")}
              </TableHead>
              <TableHead>{t("mainPanelTabs.cdnTab.pageviews")}</TableHead>
              <TableHead className="w-28" />
              <TableHead>{t("mainPanelTabs.cdnTab.requests")}</TableHead>
              <TableHead>{t("mainPanelTabs.cdnTab.bandwidth")}</TableHead>
              <TableHead className="pr-4 text-right">
                {t("mainPanelTabs.cdnTab.cacheHit")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((site) => (
              <TableRow
                key={site.id}
                className={cn(site.link && "cursor-pointer")}
                onClick={() => site.link && void navigate(site.link)}
              >
                <TableCell className="pl-4 text-sm font-medium text-foreground">
                  {site.name}
                </TableCell>
                <TableCell>
                  {measured("pageviews", site.summary) ? (
                    <span className="flex items-baseline gap-2">
                      <span className="text-sm tnum text-foreground">
                        {formatNumber(site.summary.pageviews)}
                      </span>
                      <Change
                        change={relativeChange(
                          site.summary.pageviews,
                          // Over the same hours, as the cards compare.
                          site.previousSeries.length > 0
                            ? site.previousSeries
                                .slice(0, site.series.length)
                                .reduce((n, v) => n + v, 0)
                            : (site.previous?.pageviews ?? null),
                        )}
                        better="up"
                      />
                    </span>
                  ) : (
                    <NotInstrumented className="text-sm" />
                  )}
                </TableCell>
                <TableCell>
                  {measured("pageviews", site.summary) &&
                  site.series.length > 1 ? (
                    <Sparkline
                      values={site.series}
                      reference={site.previousSeries}
                      className="h-6 w-24"
                    />
                  ) : (
                    DASH
                  )}
                </TableCell>
                {measured("requests", site.summary) ? (
                  <>
                    <TableCell className="text-sm tnum text-foreground">
                      {formatNumber(site.summary.total_requests)}
                    </TableCell>
                    <TableCell className="text-sm tnum text-foreground">
                      {formatBytes(site.summary.total_bandwidth_bytes)}
                    </TableCell>
                    <TableCell className="pr-4 text-right text-sm tnum text-foreground">
                      {formatPct(site.summary.cache_hit_ratio)}
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={3} className="pr-4">
                    <NotInstrumented className="text-sm" />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}

export function SitesMonitor({ data }: { data: SitesMonitorData }) {
  return (
    <div className="flex flex-col gap-4">
      <TrafficCard id="pageviews" data={data} tall />
      <div className="grid gap-4 md:grid-cols-3">
        {SIDE_CARDS.map((id) => (
          <TrafficCard key={id} id={id} data={data} />
        ))}
      </div>
      {data.sites.length > 0 && (
        <div className="mt-6">
          <SitesTable sites={data.sites} />
        </div>
      )}
    </div>
  );
}
