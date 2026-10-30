/**
 * The Monitor's Performance tab for a v7 site: how the CDN served it, from the
 * stats-lake warehouse (`/api/:org/monitor/:site/cdn/data`). Drawn with the
 * Monitor's own cards and charts; the standalone Monitor app keeps its fuller
 * screen with filters and bandwidth ratios.
 */

import { type ReactNode, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Globe01 } from "@untitledui/icons";
import {
  Area,
  AreaChart,
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
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { Page } from "@/components/page";
import { resolveAnalyticsSiteSlug } from "@decocms/shared/site-slug";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  type BreakdownRow,
  CdnTab,
  type CdnSummary,
  cacheColor,
  fetchJson,
  formatBytes,
  formatCountry,
  formatNumber,
  statusColor,
  statusName,
  type TimelinePoint,
} from "@/layouts/main-panel-tabs/cdn-tab";
import {
  monitorKind,
  relativeChange,
} from "@/layouts/main-panel-tabs/monitor-v8";
import { AXIS_TICK, MetricCard } from "@/layouts/task-board/analytics-sections";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { weightedMean } from "./aggregate";
import { RankedList } from "./analytics/panels";
import { PERFORMANCE_SECTIONS } from "./analytics/sections";
import type { SectionRange } from "./audience-view";
import { DecoStack } from "./deco-stack";
import { TopbarSelect } from "./topbar-select";
import type { SiteProject } from "./org-insights";
import { Spread, Trend } from "./parts";

const RANGES = ["today", "yesterday", "7d", "30d", "90d"] as const;
type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = {
  today: 1,
  yesterday: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
const COLOR_REQUESTS = "var(--chart-1)";

function rangeLabel(range: Range, t: TFunction): string {
  switch (range) {
    case "today":
      return t("mainPanelTabs.cdnTab.today");
    case "yesterday":
      return t("mainPanelTabs.cdnTab.yesterday");
    case "7d":
      return t("mainPanelTabs.cdnTab.last7d");
    case "30d":
      return t("mainPanelTabs.cdnTab.last30d");
    case "90d":
      return t("mainPanelTabs.cdnTab.last90d");
    default: {
      const unhandled: never = range;
      return unhandled;
    }
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The equal-length window right before a multi-day range, in the warehouse's
 * UTC days. Null for today (a partial day against a whole one misleads) and
 * yesterday (one day against the day before is mostly weekday noise).
 */
function previousWindow(range: Range): { since: string; until: string } | null {
  const days = RANGE_DAYS[range];
  if (days === 1) return null;
  const today = Date.parse(`${isoDay(Date.now())}T00:00:00Z`);
  const day = 86_400_000;
  return {
    since: isoDay(today - (2 * days - 1) * day),
    until: isoDay(today - days * day),
  };
}

function useCdnView<T>(
  base: string,
  view: string,
  range: string,
  extra = "",
  enabled = true,
) {
  return useQuery({
    queryKey: KEYS.cdnData(base, `cdn:${view}${extra}`, range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/cdn/data?view=${view}&range=${range}${extra}`,
      )) as { available?: boolean; data?: T };
      return body.available === false
        ? null
        : ((body.data ?? null) as T | null);
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

function RangeAction({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  const t = useT();
  return (
    <Page.Actions>
      <TopbarSelect
        label={t("monitor.audience.range")}
        value={value}
        options={RANGES.map((range) => ({
          value: range,
          label: rangeLabel(range, t),
        }))}
        onChange={onChange}
      />
    </Page.Actions>
  );
}

function tick(bucket: string): string {
  return bucket.length > 10 ? bucket.slice(11, 16) : bucket.slice(5);
}

/** Requests and bytes per pageview: what a page costs to serve. */
const perPageview = (s: CdnSummary | null) =>
  s && s.pageviews > 0
    ? {
        requests: s.total_requests / s.pageviews,
        bytesPer10k: s.total_bandwidth_bytes / (s.pageviews / 10_000),
      }
    : null;

function Cards({
  summary,
  previous,
}: {
  summary: CdnSummary;
  previous: CdnSummary | null;
}) {
  const t = useT();
  const now = perPageview(summary);
  const before = perPageview(previous);
  const cards: {
    title: string;
    value: string;
    current?: number;
    prior?: number;
    better?: "up" | "down" | "none";
    caption?: ReactNode;
  }[] = [
    {
      title: t("mainPanelTabs.cdnTab.requests"),
      value: formatNumber(summary.total_requests),
      current: summary.total_requests,
      prior: previous?.total_requests,
      better: "none",
    },
    {
      title: t("mainPanelTabs.cdnTab.pageviews"),
      value: formatNumber(summary.pageviews),
      current: summary.pageviews,
      prior: previous?.pageviews,
      better: "up",
    },
    {
      title: t("mainPanelTabs.cdnTab.bandwidth"),
      value: formatBytes(summary.total_bandwidth_bytes),
      current: summary.total_bandwidth_bytes,
      prior: previous?.total_bandwidth_bytes,
      better: "none",
    },
    {
      title: t("mainPanelTabs.cdnTab.cacheHit"),
      value: formatRatio(summary.cache_hit_ratio),
      current: summary.cache_hit_ratio,
      prior: previous?.cache_hit_ratio,
      better: "up",
    },
    {
      title: t("mainPanelTabs.cdnTab.requestsPerPageview"),
      value: now ? ONE_DECIMAL.format(now.requests) : "—",
      current: now?.requests,
      prior: before?.requests,
      better: "down",
    },
    {
      title: t("mainPanelTabs.cdnTab.bandwidthPer10k"),
      value: now ? formatBytes(now.bytesPer10k) : "—",
      current: now?.bytesPer10k,
      prior: before?.bytesPer10k,
      better: "down",
    },
    {
      title: t("mainPanelTabs.cdnTab.avgLatency"),
      value: `${Math.round(summary.avg_latency_ms)} ms`,
      current: summary.avg_latency_ms,
      prior: previous?.avg_latency_ms,
      better: "down",
    },
    {
      title: t("mainPanelTabs.cdnTab.errors5xx"),
      value: formatNumber(summary.status_5xx_count),
      caption: (
        <span className="text-meta">
          {t("monitor.performance.errorShare", {
            share: shareOf(summary.status_5xx_count, summary.total_requests),
          })}
        </span>
      ),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <MetricCard
          key={card.title}
          title={card.title}
          value={card.value}
          caption={
            card.caption ?? (
              <Trend
                change={
                  card.current !== undefined && card.prior !== undefined
                    ? relativeChange(card.current, card.prior)
                    : null
                }
                better={card.better ?? "none"}
                reference=""
              />
            )
          }
        />
      ))}
    </div>
  );
}

const USAGE = ["requests", "pageviews", "bandwidth_bytes"] as const;
type Usage = (typeof USAGE)[number];
type UsageView = "all" | Usage;
const USAGE_VIEWS: readonly UsageView[] = ["all", ...USAGE];

const USAGE_COLORS: Record<Usage, string> = {
  requests: COLOR_REQUESTS,
  pageviews: "var(--chart-2)",
  bandwidth_bytes: "var(--chart-4)",
};

function usageLabel(view: UsageView, t: TFunction): string {
  switch (view) {
    case "all":
      return t("monitor.performance.allUsage");
    case "requests":
      return t("mainPanelTabs.cdnTab.requests");
    case "pageviews":
      return t("mainPanelTabs.cdnTab.pageviews");
    case "bandwidth_bytes":
      return t("mainPanelTabs.cdnTab.bandwidth");
    default: {
      const unhandled: never = view;
      return unhandled;
    }
  }
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const formatUsage = (metric: Usage, v: number) =>
  metric === "bandwidth_bytes" ? formatBytes(v) : compact.format(v);
const isUsage = (key: unknown): key is Usage => USAGE.some((m) => m === key);

/**
 * Requests, pageviews and bandwidth over the range: all three together, with
 * bandwidth on its own axis, or one at a time on its own scale, where
 * pageviews read as more than a flat line under millions of requests.
 */
function UsageChart({ points }: { points: TimelinePoint[] }) {
  const t = useT();
  const [view, setView] = useState<UsageView>("all");
  const shown: readonly Usage[] = view === "all" ? USAGE : [view];
  const axisOf = (m: Usage) =>
    view === "all" && m === "bandwidth_bytes" ? "bytes" : "main";
  const yAxis = (id: "main" | "bytes", side: "left" | "right") => (
    <YAxis
      yAxisId={id}
      orientation={side}
      axisLine={false}
      tickLine={false}
      tick={AXIS_TICK}
      width={56}
      tickCount={4}
      allowDecimals={false}
      tickFormatter={(v: number) =>
        formatUsage(
          id === "bytes" ? "bandwidth_bytes" : (shown[0] ?? "requests"),
          v,
        )
      }
    />
  );
  return (
    <MetricCard
      title={t("mainPanelTabs.cdnTab.usageOverTime")}
      aside={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(v) => {
            const next = USAGE_VIEWS.find((m) => m === v);
            if (next) setView(next);
          }}
        >
          {USAGE_VIEWS.map((m) => (
            <ToggleGroupItem
              key={m}
              value={m}
              className="flex-none gap-1.5 px-2.5 text-xs font-normal"
            >
              {m !== "all" && (
                <span
                  className="size-2 rounded-full"
                  style={{ background: USAGE_COLORS[m] }}
                />
              )}
              {usageLabel(m, t)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      <ChartContainer
        config={Object.fromEntries(
          shown.map((m) => [
            m,
            { label: usageLabel(m, t), color: USAGE_COLORS[m] },
          ]),
        )}
        className="h-[220px] w-full"
      >
        <ComposedChart data={points} margin={{ left: 0, right: 0, top: 4 }}>
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
            minTickGap={32}
            tickFormatter={tick}
          />
          {view === "all" ? (
            <>
              {yAxis("main", "left")}
              {yAxis("bytes", "right")}
            </>
          ) : (
            yAxis("main", "right")
          )}
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) =>
                  isUsage(name) && (
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        {usageLabel(name, t)}
                      </span>
                      <span className="tnum text-foreground">
                        {formatUsage(name, Number(value))}
                      </span>
                    </span>
                  )
                }
              />
            }
          />
          {shown.map((m) =>
            m === "requests" || view !== "all" ? (
              <Area
                key={m}
                yAxisId={axisOf(m)}
                dataKey={m}
                type="monotone"
                fill={USAGE_COLORS[m]}
                fillOpacity={0.15}
                stroke={USAGE_COLORS[m]}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={m}
                yAxisId={axisOf(m)}
                dataKey={m}
                type="monotone"
                stroke={USAGE_COLORS[m]}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ),
          )}
        </ComposedChart>
      </ChartContainer>
    </MetricCard>
  );
}

/** One v7 site's CDN performance, inside the Monitor. */
function CdnPerformance({
  base,
  after,
}: {
  base: string;
  /** Drawn under the CDN, read over the same period. */
  after?: (range: Range) => ReactNode;
}) {
  const t = useT();
  const [range, setRange] = useState<Range>("7d");
  const prev = previousWindow(range);
  const summary = useCdnView<CdnSummary>(base, "summary", range);
  const previous = useCdnView<CdnSummary>(
    base,
    "summary",
    "custom",
    prev ? `&since=${prev.since}&until=${prev.until}` : "",
    prev !== null,
  );
  const timeline = useCdnView<TimelinePoint[]>(base, "timeline", range);
  const [measure, setMeasure] = useState<"requests" | "bandwidth">("requests");
  const [ignoreQuery, setIgnoreQuery] = useState(true);
  const paths = useCdnView<BreakdownRow[]>(
    base,
    "top-paths",
    range,
    ignoreQuery ? "&groupByPath=1" : "",
  );
  const statuses = useCdnView<BreakdownRow[]>(base, "status-codes", range);
  const cache = useCdnView<BreakdownRow[]>(base, "cache-status", range);
  const countries = useCdnView<BreakdownRow[]>(base, "top-countries", range);
  const action = <RangeAction value={range} onChange={setRange} />;

  if (summary.isError) {
    return (
      <>
        {action}
        <EmptyState
          icon={<Globe01 className="size-5" />}
          title={t("mainPanelTabs.cdnTab.errorTitle")}
          description={(summary.error as Error).message}
        />
      </>
    );
  }
  if (summary.data === null) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.unconfiguredTitle")}
        description={t("mainPanelTabs.cdnTab.unconfiguredBody")}
      />
    );
  }

  const panel = (
    query: { isLoading: boolean; data: BreakdownRow[] | null | undefined },
    title: string,
    options: {
      label?: (key: string) => string;
      dot?: (key: string) => string;
      aside?: ReactNode;
    } = {},
  ) =>
    query.isLoading ? (
      <Skeleton className="h-64" />
    ) : (
      <RankedList
        title={title}
        aside={options.aside}
        rows={(query.data ?? [])
          .map((r) => ({
            k: r.key,
            n:
              measure === "requests"
                ? r.total_requests
                : r.total_bandwidth_bytes,
          }))
          .sort((x, y) => y.n - x.n)}
        label={options.label}
        dot={options.dot}
        format={measure === "requests" ? formatNumber : formatBytes}
        limit={10}
        expandable
      />
    );

  return (
    <>
      {action}
      {summary.isLoading || !summary.data ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Cards
            summary={summary.data}
            previous={prev ? (previous.data ?? null) : null}
          />
        </div>
      )}
      {timeline.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        (timeline.data?.length ?? 0) > 1 && (
          <UsageChart points={timeline.data ?? []} />
        )
      )}
      <div className="flex items-center gap-2">
        <span className="text-meta">{t("mainPanelTabs.cdnTab.measureBy")}</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={measure}
          onValueChange={(v) => {
            if (v === "requests" || v === "bandwidth") setMeasure(v);
          }}
        >
          <ToggleGroupItem
            value="requests"
            className="flex-none px-2.5 text-xs font-normal"
          >
            {t("mainPanelTabs.cdnTab.requests")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="bandwidth"
            className="flex-none px-2.5 text-xs font-normal"
          >
            {t("mainPanelTabs.cdnTab.bandwidth")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {panel(cache, t("mainPanelTabs.cdnTab.cacheStatus"), {
          dot: cacheColor,
        })}
        {panel(statuses, t("mainPanelTabs.cdnTab.statusCodes"), {
          label: statusName,
          dot: statusColor,
        })}
        {panel(paths, t("mainPanelTabs.cdnTab.topPaths"), {
          aside: (
            <label className="text-meta flex cursor-pointer items-center gap-1.5">
              <Checkbox
                checked={ignoreQuery}
                onCheckedChange={(v) => setIgnoreQuery(v === true)}
              />
              {t("mainPanelTabs.cdnTab.ignoreQueryString")}
            </label>
          ),
        })}
        {panel(countries, t("mainPanelTabs.cdnTab.topCountries"), {
          label: formatCountry,
        })}
      </div>
      {after?.(range)}
    </>
  );
}

/**
 * Deco Analytics reads rolling windows, not days: the CDN's day or days read
 * as the window that holds them.
 */
const DECO_RANGE: Record<Range, SectionRange> = {
  today: "24h",
  yesterday: "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "30d",
};

/**
 * A site's performance inside the Monitor: the CDN for a v7 site, the site's
 * own telemetry for a Blocks v8 one (its own screen, as the Monitor app shows it).
 */
function SitePerformance({
  projectId,
  project,
}: {
  projectId: string;
  project: SiteProject | undefined;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(projectId);
  const kind = monitorKind(useMainSchemaV8(projectId));
  if (kind === "loading") {
    return (
      <Frame>
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </Frame>
    );
  }
  if (kind !== "v7") return <CdnTab virtualMcpId={projectId} />;
  const site = resolveAnalyticsSiteSlug(entity);
  if (!site) {
    return (
      <Frame>
        <EmptyState
          icon={<Globe01 className="size-5" />}
          title={t("mainPanelTabs.cdnTab.noSiteTitle")}
          description={t("mainPanelTabs.cdnTab.noSiteBody")}
        />
      </Frame>
    );
  }
  return (
    <Frame>
      <CdnPerformance
        key={site}
        base={`/api/${org.slug}/monitor/${encodeURIComponent(site)}`}
        after={(range) =>
          project && (
            <DecoStack
              project={project}
              sections={PERFORMANCE_SECTIONS}
              range={DECO_RANGE[range]}
            />
          )
        }
      />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-6 pb-10 md:px-10">
        {children}
      </div>
    </div>
  );
}

function cdnQuery<T>(base: string, view: string, range: string, extra = "") {
  return {
    queryKey: KEYS.cdnData(base, `cdn:${view}${extra}`, range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/cdn/data?view=${view}&range=${range}${extra}`,
      )) as { available?: boolean; data?: T };
      return body.available === false
        ? null
        : ((body.data ?? null) as T | null);
    },
    retry: false,
    staleTime: 30_000,
  };
}

const SITE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const formatMs = (ms: number) => `${Math.round(ms)} ms`;
const ONE_DECIMAL = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const formatRatio = (pct: number) => `${ONE_DECIMAL.format(pct)}%`;

/** Requests over time, one stacked band per site. */
function StackedRequests({
  sites,
}: {
  sites: { project: SiteProject; points: TimelinePoint[] }[];
}) {
  const t = useT();
  const buckets = new Map<string, Record<string, number | string>>();
  for (const { project, points } of sites) {
    for (const p of points) {
      const row = buckets.get(p.bucket) ?? { bucket: p.bucket };
      row[project.id] = (Number(row[project.id]) || 0) + p.requests;
      buckets.set(p.bucket, row);
    }
  }
  const data = [...buckets.values()].sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
  const color = (i: number) => SITE_COLORS[i % SITE_COLORS.length];
  return (
    <MetricCard title={t("monitor.performance.overTime")}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {sites.map(({ project }, i) => (
            <li key={project.id} className="flex items-center gap-2 text-sm">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: color(i) }}
              />
              {project.title}
            </li>
          ))}
        </ul>
        <ChartContainer
          config={Object.fromEntries(
            sites.map(({ project }, i) => [
              project.id,
              { label: project.title, color: color(i) },
            ]),
          )}
          className="h-[170px] w-full"
        >
          <AreaChart data={data} margin={{ left: 0, right: 0, top: 4 }}>
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
              minTickGap={32}
              tickFormatter={tick}
            />
            <YAxis
              orientation="right"
              axisLine={false}
              tickLine={false}
              tick={AXIS_TICK}
              width={44}
              tickCount={4}
              allowDecimals={false}
              tickFormatter={(v: number) =>
                new Intl.NumberFormat(undefined, {
                  notation: "compact",
                }).format(v)
              }
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {sites.map(({ project }, i) => (
              <Area
                key={project.id}
                dataKey={project.id}
                stackId="sites"
                type="monotone"
                fill={color(i)}
                fillOpacity={0.2}
                stroke={color(i)}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>
    </MetricCard>
  );
}

/**
 * Every project's CDN at once. Requests and 5xx errors add up; the cache hit
 * rate and latency are averages, weighted by each site's requests, with the
 * sites' own values under them. A row opens that project.
 */
function OrgPerformance({
  projects,
  onProject,
}: {
  projects: readonly SiteProject[];
  onProject: (projectId: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const [range, setRange] = useState<Range>("7d");
  const prev = previousWindow(range);
  const base = (p: SiteProject) =>
    `/api/${org.slug}/monitor/${encodeURIComponent(p.analyticsSite)}`;
  const summaries = useQueries({
    queries: projects.map((p) =>
      cdnQuery<CdnSummary>(base(p), "summary", range),
    ),
  });
  const previous = useQueries({
    queries: projects.map((p) => ({
      ...cdnQuery<CdnSummary>(
        base(p),
        "summary",
        "custom",
        prev ? `&since=${prev.since}&until=${prev.until}` : "",
      ),
      enabled: prev !== null,
    })),
  });
  const timelines = useQueries({
    queries: projects.map((p) =>
      cdnQuery<TimelinePoint[]>(base(p), "timeline", range),
    ),
  });
  const action = <RangeAction value={range} onChange={setRange} />;
  const loading = summaries.some((q) => q.isLoading);

  const rows = projects
    .map((project, i) => ({
      project,
      loading: summaries[i]?.isLoading ?? false,
      summary: summaries[i]?.data ?? null,
      previous: previous[i]?.data ?? null,
    }))
    .sort(
      (a, b) =>
        (b.summary?.total_requests ?? -1) - (a.summary?.total_requests ?? -1),
    );
  const serving = rows.filter((r) => (r.summary?.total_requests ?? 0) > 0);

  if (!loading && serving.length === 0) {
    return (
      <>
        {action}
        <EmptyState
          icon={<Globe01 className="size-5" />}
          title={t("monitor.performance.org.emptyTitle")}
          description={t("monitor.performance.org.emptyDesc")}
        />
      </>
    );
  }

  const sum = (pick: (s: CdnSummary) => number, from: "summary" | "previous") =>
    serving.reduce((n, r) => n + (r[from] ? pick(r[from]) : 0), 0);
  const comparable = prev !== null && serving.every((r) => r.previous);
  const requests = sum((s) => s.total_requests, "summary");
  const errors = sum((s) => s.status_5xx_count, "summary");
  const weighted = (pick: (s: CdnSummary) => number) =>
    serving.map((r) => ({
      title: r.project.title,
      value: r.summary ? pick(r.summary) : 0,
      weight: r.summary?.total_requests ?? 0,
    }));
  const cache = weighted((s) => s.cache_hit_ratio);
  const latency = weighted((s) => s.avg_latency_ms);
  const sites = projects.flatMap((project, i) => {
    const points = timelines[i]?.data;
    return points && points.some((p) => p.requests > 0)
      ? [{ project, points }]
      : [];
  });

  return (
    <>
      {action}
      {loading && serving.length === 0 ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard
              title={t("mainPanelTabs.cdnTab.requests")}
              value={formatNumber(requests)}
              caption={
                comparable && (
                  <Trend
                    change={relativeChange(
                      requests,
                      sum((s) => s.total_requests, "previous"),
                    )}
                    better="none"
                    reference=""
                  />
                )
              }
            />
            <MetricCard
              title={t("mainPanelTabs.cdnTab.cacheHit")}
              value={formatRatio(weightedMean(cache) ?? 0)}
              caption={
                <Spread
                  values={cache}
                  format={formatRatio}
                  lowerIsBetter={false}
                />
              }
            />
            <MetricCard
              title={t("mainPanelTabs.cdnTab.avgLatency")}
              value={formatMs(weightedMean(latency) ?? 0)}
              caption={
                <Spread values={latency} format={formatMs} lowerIsBetter />
              }
            />
            <MetricCard
              title={t("mainPanelTabs.cdnTab.errors5xx")}
              value={formatNumber(errors)}
              caption={
                <span className="text-meta">
                  {t("monitor.performance.errorShare", {
                    share: shareOf(errors, requests),
                  })}
                </span>
              }
            />
          </div>
        </div>
      )}
      {sites.length > 0 && <StackedRequests sites={sites} />}
      <section className="surface shrink-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-meta border-b border-border text-left">
            <tr>
              <th className="px-4 py-2 font-normal">
                {t("monitor.projectFilter.label")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("mainPanelTabs.cdnTab.requests")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("mainPanelTabs.cdnTab.cacheHit")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("mainPanelTabs.cdnTab.avgLatency")}
              </th>
              <th className="px-4 py-2 text-right font-normal">
                {t("mainPanelTabs.cdnTab.errors5xx")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const s = row.summary;
              const live = s && s.total_requests > 0;
              return (
                <tr
                  key={row.project.id}
                  tabIndex={0}
                  onClick={() => onProject(row.project.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onProject(row.project.id);
                    }
                  }}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/50"
                >
                  <td className="px-4 py-2.5 text-foreground">
                    {row.project.title}
                  </td>
                  {row.loading ? (
                    <td colSpan={4} className="px-4 py-2.5">
                      <Skeleton className="ml-auto h-5 w-48" />
                    </td>
                  ) : live ? (
                    <>
                      <td className="tnum px-4 py-2.5 text-right">
                        <span className="inline-flex items-center gap-2">
                          {formatNumber(s.total_requests)}
                          {row.previous && (
                            <Trend
                              change={relativeChange(
                                s.total_requests,
                                row.previous.total_requests,
                              )}
                              better="none"
                              reference=""
                            />
                          )}
                        </span>
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">
                        {formatRatio(s.cache_hit_ratio)}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">
                        {formatMs(s.avg_latency_ms)}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right">
                        {shareOf(s.status_5xx_count, s.total_requests)}
                      </td>
                    </>
                  ) : (
                    <td
                      colSpan={4}
                      className="text-meta px-4 py-2.5 text-right"
                    >
                      {t("monitor.performance.org.noCdn")}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function shareOf(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 0.1
    ? `<${ONE_DECIMAL.format(0.1)}%`
    : `${ONE_DECIMAL.format(pct)}%`;
}

/**
 * The Performance tab: one project in full (CDN on v7, telemetry on v8), or
 * every project at once.
 */
export function PerformanceScreen({
  projects,
  scopeId,
  onProject,
}: {
  projects: readonly SiteProject[];
  scopeId: string | null;
  onProject: (projectId: string) => void;
}) {
  if (scopeId) {
    return (
      <SitePerformance
        key={scopeId}
        projectId={scopeId}
        project={projects.find((p) => p.id === scopeId)}
      />
    );
  }
  return (
    <Frame>
      <OrgPerformance projects={projects} onProject={onProject} />
    </Frame>
  );
}
