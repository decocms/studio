/**
 * Overview Tab — metric cards, charts, and leaderboards.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import type { useConnections } from "@/sdk";
import { useProjectContext } from "@/sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { AlertTriangle, Container } from "@untitledui/icons";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import {
  KPIChart,
  type MonitoringStatsData,
  type DateRange,
} from "@/components/monitoring/monitoring-stats-row.tsx";
import {
  useMonitoringStats,
  useMonitoringLlmStats,
} from "@/components/monitoring/hooks.ts";
import { getConnectionSlug } from "@decocms/shared/utils/connection-slug";
import { useT } from "@/i18n/use-t.ts";
import {
  buildFilledStatsData,
  formatCompactNumber,
  formatDuration,
  formatMetricValue,
  formatUsd,
  getIntervalFromRange,
  getMetricValue,
  type ConnectionMetric,
  type LeaderboardMode,
} from "./utils.ts";

// ── Shared card component ───────────────────────────────────────────────────

function MonitoringMetricCard({
  title,
  value,
  action,
  children,
  className,
}: {
  title: string;
  value: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("pt-4 px-4 pb-6 gap-8", className)}>
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="text-sm text-foreground/70">{title}</span>
          <span className="text-4xl font-normal">{value}</span>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="flex flex-col gap-6">{children}</div>}
    </Card>
  );
}

// ── Connection leaderboard ──────────────────────────────────────────────────

function ConnectionLeaderboardTable({
  metrics,
  connections,
  mode,
  total,
}: {
  metrics: ConnectionMetric[];
  connections: ReturnType<typeof useConnections>;
  mode: LeaderboardMode;
  total: number;
}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const allConnections = connections ?? [];
  const metricsMap = new Map(metrics.map((m) => [m.connectionId, m]));

  const ranked = allConnections
    .map((c) => ({ connection: c, metric: metricsMap.get(c.id) }))
    .filter((item) => item.metric)
    .sort((a, b) => {
      const av = getMetricValue(a.metric!, mode);
      const bv = getMetricValue(b.metric!, mode);
      return bv - av;
    })
    .slice(0, 4);

  if (ranked.length === 0) return null;

  return (
    <div className="flex flex-col">
      {ranked.map(({ connection, metric }, idx) => {
        const callsPct =
          total > 0 ? ((metric!.calls / total) * 100).toFixed(1) : "0.0";
        const displayPct =
          mode === "errors"
            ? `${metric!.errorRate.toFixed(1)}%`
            : `${callsPct}%`;
        const isLast = idx === ranked.length - 1;
        return (
          <div
            key={connection.id}
            className={cn(
              "flex items-center h-10 px-3 cursor-pointer hover:bg-accent/50 transition-colors",
              !isLast && "border-b border-border/50",
            )}
            onClick={() =>
              navigate({
                to: "/$org/settings/connections/$appSlug",
                params: {
                  org: org.slug,
                  appSlug: getConnectionSlug(connection),
                },
              })
            }
          >
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <IntegrationIcon
                icon={connection.icon}
                name={connection.title}
                size="xs"
                fallbackIcon={<Container />}
                className="shrink-0 size-6! min-w-6! rounded-md"
              />
              <span className="text-sm text-muted-foreground flex-1 truncate">
                {connection.title}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 px-3">
              <span className="text-sm text-foreground/30 tabular-nums">
                {displayPct}
              </span>
              <span className="text-sm text-foreground tabular-nums">
                {formatMetricValue(metric!, mode)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model leaderboard ───────────────────────────────────────────────────────

type ModelMetric = {
  toolName: string;
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

// Stable per-model color so the same model reads the same hue across every card.
const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function modelColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return MODEL_COLORS[h % MODEL_COLORS.length]!;
}

function ModelLeaderboardTable({
  models,
  mode = "calls",
}: {
  models: ModelMetric[];
  mode?: "calls" | "tokens" | "cost";
}) {
  if (models.length === 0) return null;

  const valueOf = (m: ModelMetric) =>
    mode === "tokens"
      ? (m.inputTokens ?? 0) + (m.outputTokens ?? 0)
      : mode === "cost"
        ? (m.costUsd ?? 0)
        : m.calls;
  const formatValue = (v: number) =>
    mode === "cost"
      ? formatUsd(v)
      : mode === "tokens"
        ? formatCompactNumber(v)
        : v.toLocaleString();

  const total = models.reduce((sum, m) => sum + valueOf(m), 0);
  const ranked = [...models]
    .sort((a, b) => valueOf(b) - valueOf(a))
    .slice(0, 4);

  return (
    <div className="flex flex-col">
      {ranked.map((model, idx, arr) => {
        const value = valueOf(model);
        const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
        const isLast = idx === arr.length - 1;
        return (
          <div
            key={model.toolName}
            className={cn(
              "flex items-center h-10 px-3",
              !isLast && "border-b border-border/50",
            )}
          >
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <div
                className="size-6 rounded-md border border-border/10 shadow-sm flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: `color-mix(in oklch, ${modelColor(model.toolName)} 18%, transparent)`,
                }}
              >
                <Container
                  size={14}
                  style={{ color: modelColor(model.toolName) }}
                />
              </div>
              <span className="text-sm text-muted-foreground flex-1 truncate">
                {model.toolName}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 px-3">
              <span className="text-sm text-foreground/30 tabular-nums">
                {pct}%
              </span>
              <span className="text-sm text-foreground tabular-nums">
                {formatValue(value)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

interface MonitoringStatsProps {
  displayDateRange: DateRange;
  connectionIds: string[];
  excludeConnectionIds?: string[];
  toolName?: string;
  status?: "success" | "error";
  connections: ReturnType<typeof useConnections>;
  isStreaming: boolean;
}

export interface OverviewTabProps extends MonitoringStatsProps {
  streamingRefetchInterval: number;
  /** Member (user) IDs to scope AI usage by. Empty = all members. */
  llmUserIds?: string[];
}

// ── Main overview tab ───────────────────────────────────────────────────────

export function OverviewTabContent({
  displayDateRange,
  connectionIds,
  excludeConnectionIds,
  toolName,
  status,
  connections,
  isStreaming,
  streamingRefetchInterval,
  llmUserIds,
}: OverviewTabProps) {
  const t = useT();
  const interval = getIntervalFromRange(displayDateRange);
  const refetchInterval = isStreaming ? streamingRefetchInterval : false;

  const { data: serverStats, isError: serverStatsError } = useMonitoringStats(
    {
      interval,
      startDate: displayDateRange.startDate.toISOString(),
      endDate: displayDateRange.endDate.toISOString(),
      connectionIds: connectionIds.length > 0 ? connectionIds : undefined,
      excludeConnectionIds,
      toolNames: toolName ? [toolName] : undefined,
      status,
    },
    { refetchInterval },
  );

  const { data: llmStats, isError: llmStatsError } = useMonitoringLlmStats(
    {
      interval,
      startDate: displayDateRange.startDate.toISOString(),
      endDate: displayDateRange.endDate.toISOString(),
      userIds: llmUserIds?.length ? llmUserIds : undefined,
    },
    { refetchInterval },
  );

  const hasError = serverStatsError || llmStatsError;

  const stats: MonitoringStatsData = serverStats
    ? {
        totalCalls: serverStats.totalCalls,
        totalErrors: serverStats.totalErrors,
        avgDurationMs: serverStats.avgDurationMs,
        p95DurationMs: serverStats.p95DurationMs,
        data: buildFilledStatsData(
          serverStats.timeseries,
          displayDateRange,
          interval,
        ),
      }
    : {
        totalCalls: 0,
        totalErrors: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        data: [],
      };

  const llmStatsData: MonitoringStatsData = llmStats
    ? {
        totalCalls: llmStats.totalCalls,
        totalErrors: llmStats.totalErrors,
        avgDurationMs: llmStats.avgDurationMs,
        p95DurationMs: llmStats.p95DurationMs,
        data: buildFilledStatsData(
          llmStats.timeseries,
          displayDateRange,
          interval,
        ),
      }
    : {
        totalCalls: 0,
        totalErrors: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        data: [],
      };

  const llmModels = llmStats?.topTools ?? [];
  const totalInputTokens = llmStats?.totalInputTokens ?? 0;
  const totalOutputTokens = llmStats?.totalOutputTokens ?? 0;
  const totalTokens = llmStats?.totalTokens ?? 0;
  const totalCostUsd = llmStats?.totalCostUsd ?? 0;
  const connectionBreakdown = serverStats?.connectionBreakdown ?? [];

  const [latencyMetric, setLatencyMetric] = useState<"avg" | "p95">("avg");

  return (
    <div className="flex flex-col gap-4 px-4 md:px-10 pt-2 pb-6 max-w-[1200px] mx-auto w-full overflow-auto">
      {hasError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <div className="flex flex-col gap-1">
            <AlertTitle>{t("orgs.overview.failedToLoadTitle")}</AlertTitle>
            <AlertDescription>
              {t("orgs.overview.failedToLoadDescription")}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Row 1: Tool Calls — full width */}
      <MonitoringMetricCard
        title={t("orgs.overview.toolCalls")}
        value={stats.totalCalls.toLocaleString()}
      >
        <KPIChart
          data={stats.data}
          dataKey="calls"
          colorNum={1}
          chartHeight="h-[120px] md:h-[180px]"
          variant="area"
          ariaLabel={t("orgs.overview.toolCallsAriaLabel")}
        />
        <ConnectionLeaderboardTable
          metrics={connectionBreakdown}
          connections={connections}
          mode="requests"
          total={stats.totalCalls}
        />
      </MonitoringMetricCard>

      {/* Row 2: Latency + Errors — half width each */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MonitoringMetricCard
          title={t("orgs.overview.latency")}
          value={formatDuration(
            latencyMetric === "avg" ? stats.avgDurationMs : stats.p95DurationMs,
          )}
          action={
            <Select
              value={latencyMetric}
              onValueChange={(v) => setLatencyMetric(v as "avg" | "p95")}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="avg">
                  {t("orgs.overview.latencyAvg")}
                </SelectItem>
                <SelectItem value="p95">
                  {t("orgs.overview.latencyP95")}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        >
          <KPIChart
            data={stats.data}
            dataKey={latencyMetric}
            colorNum={4}
            chartHeight="h-[120px] md:h-[180px]"
            ariaLabel={t("orgs.overview.latencyAriaLabel", {
              type:
                latencyMetric === "avg" ? t("orgs.overview.average") : "P95",
            })}
          />
          <ConnectionLeaderboardTable
            metrics={connectionBreakdown}
            connections={connections}
            mode="latency"
            total={stats.totalCalls}
          />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title={t("orgs.overview.errors")}
          value={stats.totalErrors.toLocaleString()}
        >
          <KPIChart
            data={stats.data}
            dataKey="errors"
            colorNum={3}
            chartHeight="h-[120px] md:h-[180px]"
            ariaLabel={t("orgs.overview.errorsAriaLabel")}
          />
          {stats.totalErrors === 0 ? (
            <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
              {t("orgs.overview.noErrors")}
            </div>
          ) : (
            <ConnectionLeaderboardTable
              metrics={connectionBreakdown}
              connections={connections}
              mode="errors"
              total={stats.totalErrors}
            />
          )}
        </MonitoringMetricCard>
      </div>

      {/* AI Usage section header */}
      <div className="flex items-center gap-3 pt-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("orgs.overview.aiUsage")}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* AI Usage — Calls, Tokens, Cost */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MonitoringMetricCard
          title={t("orgs.overview.aiCalls")}
          value={llmStatsData.totalCalls.toLocaleString()}
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="calls"
            colorNum={1}
            chartHeight="h-[80px] md:h-[120px]"
            ariaLabel={t("orgs.overview.aiCallsAriaLabel")}
          />
          <ModelLeaderboardTable models={llmModels} mode="calls" />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title={t("orgs.overview.tokens")}
          value={formatCompactNumber(totalTokens)}
          action={
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatCompactNumber(totalInputTokens)}{" "}
              {t("orgs.overview.tokensIn")} ·{" "}
              {formatCompactNumber(totalOutputTokens)}{" "}
              {t("orgs.overview.tokensOut")}
            </span>
          }
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="totalTokens"
            colorNum={2}
            chartHeight="h-[80px] md:h-[120px]"
            ariaLabel={t("orgs.overview.tokensAriaLabel")}
          />
          <ModelLeaderboardTable models={llmModels} mode="tokens" />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title={t("orgs.overview.cost")}
          value={totalCostUsd > 0 ? formatUsd(totalCostUsd) : "—"}
          action={
            totalCostUsd === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("orgs.overview.noCostData")}
              </span>
            ) : undefined
          }
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="costUsd"
            colorNum={5}
            chartHeight="h-[80px] md:h-[120px]"
            ariaLabel={t("orgs.overview.costAriaLabel")}
          />
          {totalCostUsd > 0 ? (
            <ModelLeaderboardTable models={llmModels} mode="cost" />
          ) : (
            <div className="flex items-center justify-center h-20 text-center text-xs text-muted-foreground px-4">
              {t("orgs.overview.costProvidersNotice")}
            </div>
          )}
        </MonitoringMetricCard>
      </div>

      {/* AI Usage — Latency + Errors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MonitoringMetricCard
          title={t("orgs.overview.aiLatency")}
          value={formatDuration(llmStatsData.avgDurationMs)}
          action={
            <span className="text-xs text-muted-foreground">
              {t("orgs.overview.p95Prefix")}
              {formatDuration(llmStatsData.p95DurationMs)}
            </span>
          }
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="avg"
            colorNum={4}
            chartHeight="h-[80px] md:h-[120px]"
            ariaLabel={t("orgs.overview.aiLatencyAriaLabel")}
          />
          <ModelLeaderboardTable models={llmModels} mode="calls" />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title={t("orgs.overview.aiErrors")}
          value={llmStatsData.totalErrors.toLocaleString()}
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="errors"
            colorNum={3}
            chartHeight="h-[80px] md:h-[120px]"
            ariaLabel={t("orgs.overview.aiErrorsAriaLabel")}
          />
          {llmStatsData.totalErrors === 0 ? (
            <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
              {t("orgs.overview.noAiErrors")}
            </div>
          ) : (
            <ModelLeaderboardTable models={llmModels} mode="calls" />
          )}
        </MonitoringMetricCard>
      </div>
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────

function SkeletonCard({ className }: { className?: string }) {
  return (
    <Card className={cn("pt-4 px-4 pb-6 gap-8", className)}>
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="h-5 w-20 rounded bg-muted animate-pulse" />
          <div className="h-10 w-14 rounded bg-muted animate-pulse" />
        </div>
        <div className="h-8 w-[120px] rounded-md bg-muted animate-pulse" />
      </div>
      <div className="flex flex-col gap-6">
        <div className="h-[180px] w-full rounded bg-muted/60 animate-pulse" />
        <div className="flex flex-col">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center h-10 px-3",
                i < 3 && "border-b border-border/50",
              )}
            >
              <div className="flex flex-1 items-center gap-2">
                <div className="size-6 rounded-md bg-muted animate-pulse shrink-0" />
                <div className="h-4 w-24 rounded bg-muted animate-pulse" />
              </div>
              <div className="flex items-center gap-2 px-3">
                <div className="h-4 w-10 rounded bg-muted animate-pulse" />
                <div className="h-4 w-10 rounded bg-muted animate-pulse" />
              </div>
            </div>
          ))}
          <div className="flex items-center h-10 px-4 gap-2">
            <div className="h-4 w-14 rounded bg-muted animate-pulse" />
          </div>
        </div>
      </div>
    </Card>
  );
}

export function OverviewTabSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 md:px-10 pt-8 md:pt-12 pb-6 max-w-[1200px] mx-auto w-full">
      <SkeletonCard />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="border-t border-border" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  );
}
