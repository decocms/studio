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

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe01 } from "@untitledui/icons";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@decocms/ui/components/chart.tsx";
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

const RANGE_PILLS = ["24h", "7d", "14d", "30d", "90d"] as const;

// Series colors, matching the old admin: requests blue, pageviews green,
// bandwidth orange. Uses the theme's chart tokens so it reads in light + dark.
const COLOR_REQUESTS = "var(--chart-1)";
const COLOR_PAGEVIEWS = "var(--chart-2)";
const COLOR_BANDWIDTH = "var(--chart-4)";

function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat().format(n);
}

/** Compact number for chart axes / large counts: 2.5M, 63.1M, 1.2K. */
function formatCompact(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** Bytes → a compact human unit (B / KB / MB / GB / TB). */
function formatBytes(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatPct(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

// Cache-status and HTTP status dot colors, plus friendly status-code names.
const CACHE_COLORS: Record<string, string> = {
  hit: "bg-emerald-500",
  dynamic: "bg-blue-500",
  bypass: "bg-violet-500",
  miss: "bg-amber-500",
  expired: "bg-orange-500",
  stale: "bg-yellow-500",
  revalidated: "bg-teal-500",
  updating: "bg-slate-400",
  none: "bg-muted-foreground",
};
function cacheColor(k: string): string {
  return CACHE_COLORS[k.toLowerCase()] ?? "bg-muted-foreground";
}
function statusColor(code: string): string {
  const n = Number(code);
  if (n >= 200 && n < 300) return "bg-emerald-500";
  if (n >= 300 && n < 400) return "bg-blue-500";
  if (n >= 400 && n < 500) return "bg-amber-500";
  if (n >= 500) return "bg-red-500";
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
function statusName(code: string): string {
  return STATUS_NAMES[code] ?? code;
}
// A stable palette for dimensionless breakdowns (sources / devices).
const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-slate-400",
];

async function fetchJson(url: string): Promise<unknown> {
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

interface CdnSummary {
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
interface TimelinePoint {
  bucket: string;
  requests: number;
  bandwidth_bytes: number;
  pageviews: number;
  cache_hit_ratio: number;
}
interface BreakdownRow {
  key: string;
  total_requests: number;
  total_bandwidth_bytes: number;
}
interface AudienceSummary {
  pageviews: number;
  visitors: number;
  sessions: number;
}
interface AudienceTimelinePoint {
  bucket: string;
  pageviews: number;
  visitors: number;
}
interface AudienceRow {
  key: string;
  pageviews: number;
  visitors: number;
}

/** One monitor view (cdn or audience) for the current range. */
function useMonitorView<T>(
  base: string,
  kind: "cdn" | "audience",
  view: string,
  range: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: KEYS.cdnData(base, `${kind}:${view}`, range),
    queryFn: async () => {
      const body = (await fetchJson(
        `${base}/${kind}/data?view=${view}&range=${range}`,
      )) as { available?: boolean; data?: T };
      if (body.available === false) return null;
      return (body.data ?? null) as T | null;
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex items-start gap-2 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

interface RankItem {
  label: string;
  color: string;
  value: number;
  formatted: string;
}

/** A ranked list: colored dot + label, value, and a share bar — the old admin's
 *  Cache Status / Status Codes / breakdown layout. */
const RANKED_COLLAPSED = 10;

function RankedList({
  items,
  emptyLabel,
}: {
  items: RankItem[];
  emptyLabel: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  // Shares/bars scale over the full set; only the visible slice is rendered.
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const max = Math.max(...items.map((i) => i.value), 1);
  const visible = expanded ? items : items.slice(0, RANKED_COLLAPSED);
  const hasMore = items.length > RANKED_COLLAPSED;
  return (
    <div className="flex flex-col">
      <div className="flex flex-col divide-y divide-border/60">
        {visible.map((it) => (
          <div key={it.label} className="flex items-center gap-3 py-2">
            <span className={cn("size-2 shrink-0 rounded-full", it.color)} />
            <span
              className="min-w-0 flex-1 truncate text-sm text-foreground"
              title={it.label}
            >
              {it.label || "—"}
            </span>
            <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {Math.round((it.value / total) * 100)}%
            </span>
            <span className="w-24 shrink-0 text-right text-sm tabular-nums">
              {it.formatted}
            </span>
            <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", it.color)}
                style={{ width: `${Math.max((it.value / max) * 100, 2)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded
            ? t("mainPanelTabs.cdnTab.showLess")
            : t("mainPanelTabs.cdnTab.showAll").replace(
                "{count}",
                String(items.length),
              )}
        </button>
      )}
    </div>
  );
}

/** Performance (CDN / edge) sub-tab. */
function PerformanceSection({
  base,
  range,
  enabled,
}: {
  base: string;
  range: string;
  enabled: boolean;
}) {
  const t = useT();
  const [metric, setMetric] = useState<"requests" | "bandwidth">("requests");
  const summary = useMonitorView<CdnSummary>(
    base,
    "cdn",
    "summary",
    range,
    enabled,
  );
  const timeline = useMonitorView<TimelinePoint[]>(
    base,
    "cdn",
    "timeline",
    range,
    enabled,
  );
  const cacheStatus = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "cache-status",
    range,
    enabled,
  );
  const statusCodes = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "status-codes",
    range,
    enabled,
  );
  const topPaths = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "top-paths",
    range,
    enabled,
  );
  const topCountries = useMonitorView<BreakdownRow[]>(
    base,
    "cdn",
    "top-countries",
    range,
    enabled,
  );

  const notConfigured =
    summary.data === null && !summary.isLoading && !summary.isError;
  if (notConfigured) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.unconfiguredTitle")}
        description={t("mainPanelTabs.cdnTab.unconfiguredBody")}
      />
    );
  }
  if (summary.isError) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.errorTitle")}
        description={(summary.error as Error)?.message ?? ""}
      />
    );
  }

  const s = summary.data;
  const reqPerPv =
    s && s.pageviews > 0 ? s.total_requests / s.pageviews : null;
  const bwPer10kPv =
    s && s.pageviews > 0
      ? s.total_bandwidth_bytes / (s.pageviews / 10000)
      : null;

  const cdnItems = (rows: BreakdownRow[] | null | undefined, named: boolean): RankItem[] =>
    (rows ?? []).map((r) => ({
      label: named ? statusName(r.key) : r.key,
      color: named ? statusColor(r.key) : cacheColor(r.key),
      value:
        metric === "requests" ? r.total_requests : r.total_bandwidth_bytes,
      formatted:
        metric === "requests"
          ? formatNumber(r.total_requests)
          : formatBytes(r.total_bandwidth_bytes),
    }));

  const metricToggle = (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {(["requests", "bandwidth"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMetric(m)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
            metric === m
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m === "requests"
            ? t("mainPanelTabs.cdnTab.requests")
            : t("mainPanelTabs.cdnTab.bandwidth")}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {summary.isLoading || !s ? (
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

      <Card
        title={t("mainPanelTabs.cdnTab.usageOverTime")}
        subtitle={t("mainPanelTabs.cdnTab.usageSubtitle")}
      >
        {timeline.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (timeline.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.cdnTab.emptyRange")}
          </p>
        ) : (
          <ChartContainer
            config={{
              requests: {
                label: t("mainPanelTabs.cdnTab.requests"),
                color: COLOR_REQUESTS,
              },
              pageviews: {
                label: t("mainPanelTabs.cdnTab.pageviews"),
                color: COLOR_PAGEVIEWS,
              },
              bandwidth_bytes: {
                label: t("mainPanelTabs.cdnTab.bandwidth"),
                color: COLOR_BANDWIDTH,
              },
            }}
            className="h-72 w-full"
          >
            <AreaChart
              data={timeline.data ?? []}
              margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(v: string) => String(v).slice(5, 16)}
              />
              <YAxis
                yAxisId="left"
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatCompact(v)}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatBytes(v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                yAxisId="left"
                dataKey="requests"
                type="monotone"
                fill={COLOR_REQUESTS}
                fillOpacity={0.15}
                stroke={COLOR_REQUESTS}
                strokeWidth={2}
              />
              <Area
                yAxisId="left"
                dataKey="pageviews"
                type="monotone"
                fill={COLOR_PAGEVIEWS}
                fillOpacity={0.12}
                stroke={COLOR_PAGEVIEWS}
                strokeWidth={2}
              />
              <Line
                yAxisId="right"
                dataKey="bandwidth_bytes"
                type="monotone"
                dot={false}
                stroke={COLOR_BANDWIDTH}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </Card>

      {/* Shared metric control for ALL breakdown lists below (cache status,
          status codes, top paths, top countries) — placed above the grid so it
          reads as governing every list, not just the first card. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t("mainPanelTabs.cdnTab.measureBy")}
        </span>
        {metricToggle}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={t("mainPanelTabs.cdnTab.cacheStatus")}
          subtitle={t("mainPanelTabs.cdnTab.cacheStatusSubtitle")}
        >
          {cacheStatus.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={cdnItems(cacheStatus.data, false)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card
          title={t("mainPanelTabs.cdnTab.statusCodes")}
          subtitle={t("mainPanelTabs.cdnTab.statusCodesSubtitle")}
        >
          {statusCodes.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={cdnItems(statusCodes.data, true)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.topPaths")}>
          {topPaths.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={(topPaths.data ?? []).map((r, i) => ({
                label: r.key,
                color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
                value:
                  metric === "requests"
                    ? r.total_requests
                    : r.total_bandwidth_bytes,
                formatted:
                  metric === "requests"
                    ? formatNumber(r.total_requests)
                    : formatBytes(r.total_bandwidth_bytes),
              }))}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.topCountries")}>
          {topCountries.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={(topCountries.data ?? []).map((r, i) => ({
                label: r.key,
                color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
                value:
                  metric === "requests"
                    ? r.total_requests
                    : r.total_bandwidth_bytes,
                formatted:
                  metric === "requests"
                    ? formatNumber(r.total_requests)
                    : formatBytes(r.total_bandwidth_bytes),
              }))}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

/** Audience (pageviews / visitors) sub-tab — the native OneDollar replacement. */
function AudienceSection({
  base,
  range,
  enabled,
}: {
  base: string;
  range: string;
  enabled: boolean;
}) {
  const t = useT();
  const summary = useMonitorView<AudienceSummary>(
    base,
    "audience",
    "summary",
    range,
    enabled,
  );
  const timeline = useMonitorView<AudienceTimelinePoint[]>(
    base,
    "audience",
    "timeline",
    range,
    enabled,
  );
  const sources = useMonitorView<AudienceRow[]>(
    base,
    "audience",
    "top-sources",
    range,
    enabled,
  );
  const countries = useMonitorView<AudienceRow[]>(
    base,
    "audience",
    "top-countries",
    range,
    enabled,
  );
  const devices = useMonitorView<AudienceRow[]>(
    base,
    "audience",
    "devices",
    range,
    enabled,
  );

  const notConfigured =
    summary.data === null && !summary.isLoading && !summary.isError;
  if (notConfigured) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.unconfiguredTitle")}
        description={t("mainPanelTabs.cdnTab.unconfiguredBody")}
      />
    );
  }
  if (summary.isError) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.errorTitle")}
        description={(summary.error as Error)?.message ?? ""}
      />
    );
  }

  const s = summary.data;
  const audItems = (rows: AudienceRow[] | null | undefined): RankItem[] =>
    (rows ?? []).map((r, i) => ({
      label: r.key,
      color: PALETTE[i % PALETTE.length] ?? "bg-muted-foreground",
      value: r.pageviews,
      formatted: formatNumber(r.pageviews),
    }));

  return (
    <div className="flex flex-col gap-4">
      {summary.isLoading || !s ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat
            label={t("mainPanelTabs.cdnTab.pageviews")}
            value={formatNumber(s.pageviews)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.visitors")}
            value={formatNumber(s.visitors)}
          />
          <Stat
            label={t("mainPanelTabs.cdnTab.sessions")}
            value={formatNumber(s.sessions)}
          />
        </div>
      )}

      <Card title={t("mainPanelTabs.cdnTab.pageviewsOverTime")}>
        {timeline.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (timeline.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("mainPanelTabs.cdnTab.emptyRange")}
          </p>
        ) : (
          <ChartContainer
            config={{
              pageviews: {
                label: t("mainPanelTabs.cdnTab.pageviews"),
                color: COLOR_PAGEVIEWS,
              },
              visitors: {
                label: t("mainPanelTabs.cdnTab.visitors"),
                color: COLOR_REQUESTS,
              },
            }}
            className="h-72 w-full"
          >
            <AreaChart
              data={timeline.data ?? []}
              margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(v: string) => String(v).slice(5, 16)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatCompact(v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                dataKey="pageviews"
                type="monotone"
                fill={COLOR_PAGEVIEWS}
                fillOpacity={0.15}
                stroke={COLOR_PAGEVIEWS}
                strokeWidth={2}
              />
              <Area
                dataKey="visitors"
                type="monotone"
                fill={COLOR_REQUESTS}
                fillOpacity={0.1}
                stroke={COLOR_REQUESTS}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t("mainPanelTabs.cdnTab.topSources")}>
          {sources.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={audItems(sources.data)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.devices")}>
          {devices.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={audItems(devices.data)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
        <Card title={t("mainPanelTabs.cdnTab.topCountries")}>
          {countries.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <RankedList
              items={audItems(countries.data)}
              emptyLabel={t("mainPanelTabs.cdnTab.emptyRange")}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

export function CdnTab({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const entity = useVirtualMCP(virtualMcpId);
  const siteSlug = resolveAgentSiteSlug(entity);
  const enabled = Boolean(siteSlug);
  const base = siteSlug
    ? `/api/${org.slug}/monitor/${encodeURIComponent(siteSlug)}`
    : "";
  const [range, setRange] = useState<string>("7d");
  const [section, setSection] = useState<"performance" | "audience">(
    "performance",
  );

  if (!siteSlug) {
    return (
      <EmptyState
        icon={<Globe01 className="size-5" />}
        title={t("mainPanelTabs.cdnTab.noSiteTitle")}
        description={t("mainPanelTabs.cdnTab.noSiteBody")}
      />
    );
  }

  const sections = [
    { id: "performance" as const, label: t("mainPanelTabs.cdnTab.performance") },
    { id: "audience" as const, label: t("mainPanelTabs.cdnTab.audience") },
  ];

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          {sections.map((sec) => (
            <button
              key={sec.id}
              type="button"
              onClick={() => setSection(sec.id)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                section === sec.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sec.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          {RANGE_PILLS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors",
                range === r
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {section === "performance" ? (
        <PerformanceSection base={base} range={range} enabled={enabled} />
      ) : (
        <AudienceSection base={base} range={range} enabled={enabled} />
      )}
    </div>
  );
}
