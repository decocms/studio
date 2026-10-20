/**
 * Monitor for Blocks v8 sites: the site's own telemetry (requests, upstream
 * calls, errors), read through `/api/:org/monitor/:site/site/data`, which
 * checks the org owns the site and scopes every query to it. v7 sites keep
 * the CDN Monitor (`cdn-tab.tsx`); `CdnTab` picks one from main's schema.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Activity, Globe01 } from "@untitledui/icons";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useClockTick } from "@/lib/use-clock-tick";
import {
  bucketLabel,
  changeTone,
  type EmptyReason,
  type ErrorRow,
  formatCount,
  formatMs,
  formatRate,
  formatShare,
  relativeChange,
  type ReleaseMarker,
  releaseBucket,
  type RouteRow,
  shortRelease,
  SITE_RANGES,
  type SiteRange,
  type SiteSection,
  type SiteSummary,
  type SiteViewAnswer,
  type SiteWindow,
  sinceLabel,
  type TimelinePoint,
  type UpstreamRow,
} from "./monitor-v8";

const STATUS_SERIES = [
  { key: "2xx", color: "var(--chart-1)" },
  { key: "3xx", color: "var(--chart-5)" },
  { key: "4xx", color: "var(--warning)" },
  { key: "5xx", color: "var(--destructive)" },
] as const;
const COLOR_P95 = "var(--chart-1)";

async function fetchView<T>(url: string): Promise<SiteViewAnswer<T>> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as SiteViewAnswer<T> & {
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

function useSiteView<T>(base: string, view: string, range: SiteRange) {
  return useQuery({
    queryKey: KEYS.siteMonitorData(base, view, range),
    queryFn: () =>
      fetchView<T>(`${base}/site/data?view=${view}&range=${range}`),
    retry: 1,
    staleTime: 30_000,
    // The last hour is near-live: refresh it every minute while it's open.
    refetchInterval: range === "1h" ? 60_000 : false,
  });
}

function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <header className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {subtitle && (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        )}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: K;
  options: { key: K; label: string }[];
  onChange: (k: K) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg border border-border p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded-lg px-3 py-1 text-xs font-medium transition-colors",
            value === o.key
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Delta({
  current,
  previous,
  better,
}: {
  current: number | null;
  previous: number | null;
  better: "up" | "down" | "none";
}) {
  const t = useT();
  const change = relativeChange(current, previous);
  if (change === null) return null;
  const tone = changeTone(change, better);
  const pct = Math.abs(change) * 100;
  return (
    <span
      title={t("mainPanelTabs.monitorV8.delta.title")}
      className={cn(
        "text-xs font-medium tabular-nums",
        tone === "good" && "text-success",
        tone === "bad" && "text-destructive",
        tone === "neutral" && "text-muted-foreground",
      )}
    >
      {change >= 0 ? "↑" : "↓"} {pct < 10 ? pct.toFixed(1) : Math.round(pct)}%
    </span>
  );
}

function Tile({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: string;
  hint: string;
  delta?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="whitespace-nowrap text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </span>
        {delta}
      </div>
      <div className="truncate text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function Tiles({ summary }: { summary: SiteSummary }) {
  const t = useT();
  const { current: c, previous: p } = summary;
  const rate = formatRate(summary.perSecond);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label={t("mainPanelTabs.monitorV8.tile.requests")}
        value={formatCount(c.requests)}
        hint={t(
          rate.unit === "s"
            ? "mainPanelTabs.monitorV8.tile.perSecond"
            : "mainPanelTabs.monitorV8.tile.perMinute",
          { value: rate.value },
        )}
        delta={
          <Delta current={c.requests} previous={p.requests} better="none" />
        }
      />
      <Tile
        label={t("mainPanelTabs.monitorV8.tile.errors")}
        value={formatShare(c.errorRate)}
        hint={t("mainPanelTabs.monitorV8.tile.errorsCount", {
          count: formatCount(c.errors5xx),
        })}
        delta={
          <Delta current={c.errorRate} previous={p.errorRate} better="down" />
        }
      />
      <Tile
        label={t("mainPanelTabs.monitorV8.tile.p95")}
        value={formatMs(c.p95Ms)}
        hint={t("mainPanelTabs.monitorV8.tile.p50", {
          value: formatMs(c.p50Ms),
        })}
        delta={<Delta current={c.p95Ms} previous={p.p95Ms} better="down" />}
      />
      <Tile
        label={t("mainPanelTabs.monitorV8.tile.cacheHits")}
        value={formatShare(c.cacheHitRate)}
        hint={t("mainPanelTabs.monitorV8.tile.cacheHitsHint")}
        delta={
          <Delta
            current={c.cacheHitRate}
            previous={p.cacheHitRate}
            better="up"
          />
        }
      />
    </div>
  );
}

/** Dashed lines where a release first showed up (named in the list under the chart). */
function ReleaseLines({
  releases,
  window,
}: {
  releases: ReleaseMarker[];
  window: SiteWindow;
}) {
  return releases.map((r) => {
    const x = releaseBucket(r.firstSeenMs, window);
    return x === null ? null : (
      <ReferenceLine
        key={r.release}
        x={x}
        stroke="var(--muted-foreground)"
        strokeDasharray="3 3"
        ifOverflow="extendDomain"
      />
    );
  });
}

function LegendItem({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "h-2 w-3 shrink-0 rounded-[2px]",
          dashed && "h-0 border-t border-dashed",
        )}
        style={dashed ? { borderColor: color } : { backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function TimelineCharts({
  points,
  releases,
  window,
  range,
}: {
  points: TimelinePoint[];
  releases: ReleaseMarker[];
  window: SiteWindow;
  range: SiteRange;
}) {
  const t = useT();
  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      scale="time"
      domain={[window.startMs, window.endMs - window.stepS * 1000]}
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={40}
      tickFormatter={(v: number) => bucketLabel(v, range)}
    />
  );
  const labelFormatter = (
    _: unknown,
    payload: readonly { payload?: { t?: number } }[],
  ) => {
    const at = payload?.[0]?.payload?.t;
    return typeof at === "number" ? bucketLabel(at, range) : "";
  };
  const shown = releases.filter(
    (r) => releaseBucket(r.firstSeenMs, window) !== null,
  );
  return (
    <div className="flex flex-col gap-4">
      <Card
        title={t("mainPanelTabs.monitorV8.chart.requests")}
        subtitle={t(`mainPanelTabs.monitorV8.chart.step.${range}`)}
      >
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {STATUS_SERIES.map((s) => (
            <LegendItem key={s.key} color={s.color} label={s.key} />
          ))}
          {shown.length > 0 && (
            <LegendItem
              color="var(--muted-foreground)"
              label={t("mainPanelTabs.monitorV8.chart.releaseLegend")}
              dashed
            />
          )}
        </div>
        <ChartContainer
          config={Object.fromEntries(
            STATUS_SERIES.map((s) => [s.key, { label: s.key, color: s.color }]),
          )}
          className="aspect-auto h-56 w-full"
        >
          <AreaChart
            data={points}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              allowDecimals={false}
              tickFormatter={(v: number) => formatCount(v)}
            />
            <ChartTooltip
              content={<ChartTooltipContent labelFormatter={labelFormatter} />}
            />
            {STATUS_SERIES.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                stackId="status"
                type="monotone"
                fill={s.color}
                fillOpacity={0.2}
                stroke={s.color}
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
            {ReleaseLines({ releases, window })}
          </AreaChart>
        </ChartContainer>
        {shown.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {shown.map((r) => (
              <li key={r.release} title={r.release}>
                <span className="font-mono">
                  {t("mainPanelTabs.monitorV8.chart.release", {
                    id: shortRelease(r.release),
                  })}
                </span>
                {" · "}
                {bucketLabel(r.firstSeenMs, range)}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card
        title={t("mainPanelTabs.monitorV8.chart.p95")}
        subtitle={t("mainPanelTabs.monitorV8.chart.p95Subtitle")}
      >
        <ChartContainer
          config={{
            p95Ms: {
              label: t("mainPanelTabs.monitorV8.tile.p95"),
              color: COLOR_P95,
            },
          }}
          className="aspect-auto h-36 w-full"
        >
          <LineChart
            data={points}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${v / 1000}s` : `${v}ms`
              }
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={labelFormatter}
                  formatter={(v) => formatMs(Number(v))}
                />
              }
            />
            <Line
              dataKey="p95Ms"
              type="monotone"
              stroke={COLOR_P95}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {ReleaseLines({ releases, window })}
          </LineChart>
        </ChartContainer>
      </Card>
    </div>
  );
}

function Table({
  head,
  rows,
}: {
  head: { label: string; align?: "right" }[];
  rows: { key: string; cells: React.ReactNode[] }[];
}) {
  return (
    <div className="-mx-4 -my-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {head.map((h) => (
              <th
                key={h.label}
                className={cn(
                  "px-4 py-2 text-xs font-medium text-muted-foreground",
                  h.align === "right" ? "text-right" : "text-left",
                )}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed columns
                  key={i}
                  className={cn(
                    "px-4 py-2 tabular-nums",
                    head[i]?.align === "right"
                      ? "text-right whitespace-nowrap"
                      : "w-full min-w-36 max-w-0 truncate",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoutesTable({ routes }: { routes: RouteRow[] }) {
  const t = useT();
  const slowest = [...routes].sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
  return (
    <Table
      head={[
        { label: t("mainPanelTabs.monitorV8.routes.route") },
        { label: t("mainPanelTabs.monitorV8.routes.p95"), align: "right" },
        { label: t("mainPanelTabs.monitorV8.routes.requests"), align: "right" },
        { label: t("mainPanelTabs.monitorV8.routes.errors"), align: "right" },
      ]}
      rows={slowest.map((r) => ({
        key: r.route,
        cells: [
          <span key="r" className="font-mono text-xs" title={r.route}>
            {r.route}
          </span>,
          formatMs(r.p95Ms),
          formatCount(r.requests),
          <span
            key="e"
            className={cn((r.errorRate ?? 0) >= 0.01 && "text-destructive")}
          >
            {formatShare(r.errorRate)}
          </span>,
        ],
      }))}
    />
  );
}

function RequestsEmpty({
  reason,
  onSeeUpstreams,
}: {
  reason: EmptyReason;
  onSeeUpstreams: () => void;
}) {
  const t = useT();
  const copy = {
    server_metric_missing: "serverMetricMissing",
    no_telemetry: "noTelemetry",
    no_requests: "noRequests",
  } as const;
  const k = copy[reason] ?? "noRequests";
  return (
    <EmptyState
      icon={<Activity className="size-5" />}
      title={t(`mainPanelTabs.monitorV8.empty.${k}.title`)}
      description={t(`mainPanelTabs.monitorV8.empty.${k}.body`)}
      buttonProps={
        reason === "server_metric_missing"
          ? {
              variant: "outline",
              children: t("mainPanelTabs.monitorV8.empty.seeUpstreams"),
              onClick: onSeeUpstreams,
            }
          : undefined
      }
    />
  );
}

function Unconfigured() {
  const t = useT();
  return (
    <EmptyState
      icon={<Globe01 className="size-5" />}
      title={t("mainPanelTabs.cdnTab.unconfiguredTitle")}
      description={t("mainPanelTabs.cdnTab.unconfiguredBody")}
    />
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon={<AlertCircle className="size-5" />}
      title={t("mainPanelTabs.monitorV8.loadError.title")}
      description={t("mainPanelTabs.monitorV8.loadError.body")}
      buttonProps={{
        variant: "outline",
        children: t("mainPanelTabs.monitorV8.loadError.retry"),
        onClick: onRetry,
      }}
    />
  );
}

function SiteSectionView({
  base,
  range,
  onSeeUpstreams,
}: {
  base: string;
  range: SiteRange;
  onSeeUpstreams: () => void;
}) {
  const t = useT();
  const summary = useSiteView<SiteSummary>(base, "summary", range);
  const timeline = useSiteView<TimelinePoint[]>(base, "timeline", range);
  const routes = useSiteView<RouteRow[]>(base, "routes", range);
  const releases = useSiteView<ReleaseMarker[]>(base, "releases", range);

  if (summary.isError) return <LoadError onRetry={() => summary.refetch()} />;
  if (summary.data?.available === false) return <Unconfigured />;
  if (summary.isLoading || !summary.data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }
  if (summary.data.reason || !summary.data.data) {
    return (
      <RequestsEmpty
        reason={summary.data.reason ?? "no_requests"}
        onSeeUpstreams={onSeeUpstreams}
      />
    );
  }
  const window = timeline.data?.window;
  return (
    <div className="flex flex-col gap-4">
      <Tiles summary={summary.data.data} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {timeline.data?.data && window ? (
          <TimelineCharts
            points={timeline.data.data}
            releases={releases.data?.data ?? []}
            window={window}
            range={range}
          />
        ) : (
          <Skeleton className="h-96 w-full rounded-xl" />
        )}
        <Card
          title={t("mainPanelTabs.monitorV8.routes.title")}
          subtitle={t("mainPanelTabs.monitorV8.routes.subtitle")}
        >
          {routes.data?.data ? (
            <RoutesTable routes={routes.data.data} />
          ) : routes.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("mainPanelTabs.monitorV8.empty.noRequests.title")}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function UpstreamsSection({ base, range }: { base: string; range: SiteRange }) {
  const t = useT();
  const q = useSiteView<UpstreamRow[]>(base, "upstreams", range);
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  if (q.data?.available === false) return <Unconfigured />;
  if (q.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Activity className="size-5" />}
        title={t("mainPanelTabs.monitorV8.empty.upstreams.title")}
        description={t("mainPanelTabs.monitorV8.empty.upstreams.body")}
      />
    );
  }
  return (
    <Card
      title={t("mainPanelTabs.monitorV8.upstreams.title")}
      subtitle={t("mainPanelTabs.monitorV8.upstreams.subtitle")}
    >
      <Table
        head={[
          { label: t("mainPanelTabs.monitorV8.upstreams.call") },
          {
            label: t("mainPanelTabs.monitorV8.upstreams.calls"),
            align: "right",
          },
          { label: t("mainPanelTabs.monitorV8.upstreams.p95"), align: "right" },
          {
            label: t("mainPanelTabs.monitorV8.upstreams.errors"),
            align: "right",
          },
          {
            label: t("mainPanelTabs.monitorV8.upstreams.cached"),
            align: "right",
          },
        ]}
        rows={rows.map((u) => ({
          key: `${u.provider}·${u.operation}`,
          cells: [
            <span key="c" title={`${u.provider} · ${u.operation}`}>
              <span className="text-muted-foreground">{u.provider}</span>
              {" · "}
              <span className="font-medium text-foreground">{u.operation}</span>
            </span>,
            formatCount(u.calls),
            formatMs(u.p95Ms),
            <span
              key="e"
              className={cn((u.errorRate ?? 0) >= 0.01 && "text-destructive")}
            >
              {formatShare(u.errorRate)}
            </span>,
            u.cachedRate ? formatShare(u.cachedRate) : "—",
          ],
        }))}
      />
    </Card>
  );
}

function ErrorsSection({ base, range }: { base: string; range: SiteRange }) {
  const t = useT();
  const q = useSiteView<ErrorRow[]>(base, "errors", range);
  const now = useClockTick(60_000);
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;
  if (q.data?.available === false) return <Unconfigured />;
  if (q.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<AlertCircle className="size-5" />}
        title={t("mainPanelTabs.monitorV8.empty.errors.title")}
        description={t("mainPanelTabs.monitorV8.empty.errors.body")}
      />
    );
  }
  return (
    <Card
      title={t("mainPanelTabs.monitorV8.errors.title")}
      subtitle={t("mainPanelTabs.monitorV8.errors.subtitle")}
    >
      <ul className="-my-2 divide-y divide-border/60">
        {rows.map((e) => {
          const since = sinceLabel(e.lastSeenMs, now);
          return (
            <li
              key={`${e.message}\u0000${e.route}`}
              className="flex items-start gap-3 py-2.5"
            >
              <span className="mt-0.5 shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-destructive">
                {t("mainPanelTabs.monitorV8.errors.times", {
                  count: formatCount(e.count),
                })}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-mono text-xs text-foreground">
                  {e.message}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  {e.code && <span className="font-mono">{e.code}</span>}
                  {e.source && <span>{e.source}</span>}
                  {e.route && (
                    <span>
                      {t("mainPanelTabs.monitorV8.errors.on", {
                        route: e.route,
                      })}
                    </span>
                  )}
                  <span>
                    {t("mainPanelTabs.monitorV8.errors.lastSeen", {
                      when: t(
                        `mainPanelTabs.monitorV8.errors.since.${since.unit}`,
                        {
                          count: since.count,
                        },
                      ),
                    })}
                  </span>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The v8 Monitor for one site. `base` is `/api/:org/monitor/:site`, the slug
 * the site's token was issued for (its `deco.site`).
 */
export function MonitorV8({ base, site }: { base: string; site: string }) {
  const t = useT();
  const [section, setSection] = useState<SiteSection>("site");
  const [range, setRange] = useState<SiteRange>("24h");

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t("mainPanelTabs.monitorV8.title")}
        </h2>
        <p className="font-mono text-xs text-muted-foreground">{site}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t("mainPanelTabs.monitorV8.title")}
          value={section}
          onChange={setSection}
          options={(["site", "upstreams", "errors"] as const).map((key) => ({
            key,
            label: t(`mainPanelTabs.monitorV8.section.${key}`),
          }))}
        />
        <Segmented
          label={t("mainPanelTabs.monitorV8.range.label")}
          value={range}
          onChange={setRange}
          options={SITE_RANGES.map((key) => ({
            key,
            label: t(`mainPanelTabs.monitorV8.range.${key}`),
          }))}
        />
      </div>
      {section === "site" ? (
        <SiteSectionView
          base={base}
          range={range}
          onSeeUpstreams={() => setSection("upstreams")}
        />
      ) : section === "upstreams" ? (
        <UpstreamsSection base={base} range={range} />
      ) : (
        <ErrorsSection base={base} range={range} />
      )}
    </div>
  );
}
