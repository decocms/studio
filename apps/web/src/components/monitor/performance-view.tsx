/**
 * The Monitor's Performance tab for a v7 site: how the CDN served it, from the
 * stats-lake warehouse (`/api/:org/monitor/:site/cdn/data`). Drawn with the
 * Monitor's own cards and charts; the standalone Monitor app keeps its fuller
 * screen with filters and bandwidth ratios.
 */

import { type ReactNode, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Globe01 } from "@untitledui/icons";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Page } from "@/components/page";
import { resolveAnalyticsSiteSlug } from "@decocms/shared/site-slug";
import { useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import {
  type BreakdownRow,
  CdnTab,
  type CdnSummary,
  fetchJson,
  formatCountry,
  formatNumber,
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
import { Ranked } from "./audience-view";
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

function isRange(value: string): value is Range {
  return (RANGES as readonly string[]).includes(value);
}

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
      <Select
        value={value}
        onValueChange={(next) => isRange(next) && onChange(next)}
      >
        <SelectTrigger size="sm" aria-label={t("monitor.audience.range")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {RANGES.map((range) => (
            <SelectItem key={range} value={range}>
              {rangeLabel(range, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Page.Actions>
  );
}

function rows(
  data: BreakdownRow[] | null | undefined,
  label: (key: string) => string = (k) => k,
) {
  return (data ?? []).map((r) => ({
    key: label(r.key),
    count: r.total_requests,
  }));
}

function tick(bucket: string): string {
  return bucket.length > 10 ? bucket.slice(11, 16) : bucket.slice(5);
}

function Cards({
  summary,
  previous,
}: {
  summary: CdnSummary;
  previous: CdnSummary | null;
}) {
  const t = useT();
  const change = (a: number, b: number | undefined) =>
    previous && b !== undefined ? relativeChange(a, b) : null;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard
        title={t("mainPanelTabs.cdnTab.requests")}
        value={formatNumber(summary.total_requests)}
        caption={
          <Trend
            change={change(summary.total_requests, previous?.total_requests)}
            better="none"
            reference=""
          />
        }
      />
      <MetricCard
        title={t("mainPanelTabs.cdnTab.cacheHit")}
        value={formatRatio(summary.cache_hit_ratio)}
        caption={
          <Trend
            change={change(summary.cache_hit_ratio, previous?.cache_hit_ratio)}
            better="up"
            reference=""
          />
        }
      />
      <MetricCard
        title={t("mainPanelTabs.cdnTab.avgLatency")}
        value={`${Math.round(summary.avg_latency_ms)} ms`}
        caption={
          <Trend
            change={change(summary.avg_latency_ms, previous?.avg_latency_ms)}
            better="down"
            reference=""
          />
        }
      />
      <MetricCard
        title={t("mainPanelTabs.cdnTab.errors5xx")}
        value={formatNumber(summary.status_5xx_count)}
        caption={
          <span className="text-meta">
            {t("monitor.performance.errorShare", {
              share: shareOf(summary.status_5xx_count, summary.total_requests),
            })}
          </span>
        }
      />
    </div>
  );
}

function RequestsChart({ points }: { points: TimelinePoint[] }) {
  const t = useT();
  return (
    <MetricCard title={t("monitor.performance.overTime")}>
      <ChartContainer
        config={{
          requests: {
            label: t("mainPanelTabs.cdnTab.requests"),
            color: COLOR_REQUESTS,
          },
        }}
        className="h-[170px] w-full"
      >
        <AreaChart data={points} margin={{ left: 0, right: 0, top: 4 }}>
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
          <Area
            dataKey="requests"
            type="monotone"
            fill={COLOR_REQUESTS}
            fillOpacity={0.15}
            stroke={COLOR_REQUESTS}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </MetricCard>
  );
}

/** One v7 site's CDN performance, inside the Monitor. */
function CdnPerformance({ base }: { base: string }) {
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
  const paths = useCdnView<BreakdownRow[]>(
    base,
    "top-paths",
    range,
    "&groupByPath=1",
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
    label?: (key: string) => string,
  ) =>
    query.isLoading ? (
      <Skeleton className="h-64" />
    ) : (
      <Ranked title={title} rows={rows(query.data, label)} />
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
          <RequestsChart points={timeline.data ?? []} />
        )
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {panel(paths, t("mainPanelTabs.cdnTab.topPaths"))}
        {panel(statuses, t("mainPanelTabs.cdnTab.statusCodes"), statusName)}
        {panel(cache, t("mainPanelTabs.cdnTab.cacheStatus"))}
        {panel(
          countries,
          t("mainPanelTabs.cdnTab.topCountries"),
          formatCountry,
        )}
      </div>
    </>
  );
}

/**
 * A site's performance inside the Monitor: the CDN for a v7 site, the site's
 * own telemetry for a Blocks v8 one (its own screen, as the Monitor app shows it).
 */
function SitePerformance({ projectId }: { projectId: string }) {
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
  if (scopeId) return <SitePerformance key={scopeId} projectId={scopeId} />;
  return (
    <Frame>
      <OrgPerformance projects={projects} onProject={onProject} />
    </Frame>
  );
}
