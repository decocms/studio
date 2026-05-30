/**
 * Overview Tab — metric cards, charts, and leaderboards.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import type { useConnections } from "@decocms/mesh-sdk";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@deco/ui/components/alert.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertTriangle, Container } from "@untitledui/icons";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import {
  KPIChart,
  type MonitoringStatsData,
  type DateRange,
} from "@/web/components/monitoring/monitoring-stats-row.tsx";
import {
  useMonitoringStats,
  useMonitoringLlmStats,
} from "@/web/components/monitoring/hooks.ts";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import {
  buildFilledStatsData,
  formatDuration,
  formatMetricValue,
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

function ModelLeaderboardTable({
  models,
  total,
}: {
  models: Array<{ toolName: string; calls: number }>;
  total: number;
}) {
  if (models.length === 0) return null;

  return (
    <div className="flex flex-col">
      {models.slice(0, 4).map((model, idx, arr) => {
        const pct =
          total > 0 ? ((model.calls / total) * 100).toFixed(1) : "0.0";
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
              <div className="size-6 rounded-md border border-border/10 bg-background shadow-sm flex items-center justify-center shrink-0">
                <Container size={14} className="text-muted-foreground" />
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
                {model.calls.toLocaleString()}
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
}: OverviewTabProps) {
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
  const connectionBreakdown = serverStats?.connectionBreakdown ?? [];

  const [latencyMetric, setLatencyMetric] = useState<"avg" | "p95">("avg");

  return (
    <div className="flex flex-col gap-4 px-4 md:px-10 pt-2 pb-6 max-w-[1200px] mx-auto w-full overflow-auto">
      {hasError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <div className="flex flex-col gap-1">
            <AlertTitle>Failed to load monitoring data</AlertTitle>
            <AlertDescription>
              We couldn't fetch your monitoring stats right now. Please try
              again later.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Row 1: Tool Calls — full width */}
      <MonitoringMetricCard
        title="Tool Calls"
        value={stats.totalCalls.toLocaleString()}
      >
        <KPIChart
          data={stats.data}
          dataKey="calls"
          colorNum={1}
          chartHeight="h-[120px] md:h-[180px]"
          variant="area"
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
          title="Latency"
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
                <SelectItem value="avg">Avg</SelectItem>
                <SelectItem value="p95">P95</SelectItem>
              </SelectContent>
            </Select>
          }
        >
          <KPIChart
            data={stats.data}
            dataKey={latencyMetric}
            colorNum={4}
            chartHeight="h-[120px] md:h-[180px]"
          />
          <ConnectionLeaderboardTable
            metrics={connectionBreakdown}
            connections={connections}
            mode="latency"
            total={stats.totalCalls}
          />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title="Errors"
          value={stats.totalErrors.toLocaleString()}
        >
          <KPIChart
            data={stats.data}
            dataKey="errors"
            colorNum={3}
            chartHeight="h-[120px] md:h-[180px]"
          />
          {stats.totalErrors === 0 ? (
            <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
              No errors in this period
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
          AI Usage
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* AI Usage — 3 cards in a row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MonitoringMetricCard
          title="AI Calls"
          value={llmStatsData.totalCalls.toLocaleString()}
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="calls"
            colorNum={1}
            chartHeight="h-[80px] md:h-[120px]"
          />
          <ModelLeaderboardTable
            models={llmModels}
            total={llmStatsData.totalCalls}
          />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title="AI Latency"
          value={formatDuration(llmStatsData.avgDurationMs)}
          action={
            <span className="text-xs text-muted-foreground">
              p95: {formatDuration(llmStatsData.p95DurationMs)}
            </span>
          }
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="avg"
            colorNum={4}
            chartHeight="h-[80px] md:h-[120px]"
          />
          <ModelLeaderboardTable
            models={llmModels}
            total={llmStatsData.totalCalls}
          />
        </MonitoringMetricCard>

        <MonitoringMetricCard
          title="AI Errors"
          value={llmStatsData.totalErrors.toLocaleString()}
        >
          <KPIChart
            data={llmStatsData.data}
            dataKey="errors"
            colorNum={3}
            chartHeight="h-[80px] md:h-[120px]"
          />
          <ModelLeaderboardTable
            models={llmModels}
            total={llmStatsData.totalCalls}
          />
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
