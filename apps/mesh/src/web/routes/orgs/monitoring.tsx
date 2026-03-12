/**
 * Monitoring Dashboard Route
 *
 * Displays tool call monitoring logs and statistics for the organization.
 */

import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { MONITORING_CONFIG } from "@/web/components/monitoring/config.ts";
import { LogRow } from "@/web/components/monitoring/log-row.tsx";
import {
  MonitoringStatsRowSkeleton,
  KPIChart,
  type DateRange,
  type MonitoringStatsData,
} from "@/web/components/monitoring/monitoring-stats-row.tsx";
import {
  useMonitoringStats,
  useMonitoringLlmStats,
} from "@/web/components/monitoring/hooks.ts";
import { DashboardsTab } from "@/web/components/monitoring/dashboards-tab";
import { useInfiniteScroll } from "@/web/hooks/use-infinite-scroll.ts";
import { useMembers } from "@/web/hooks/use-members";
import { KEYS } from "@/web/lib/query-keys";
import {
  ORG_ADMIN_PROJECT_SLUG,
  SELF_MCP_ALIAS_ID,
  WellKnownOrgMCPId,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  FilterLines,
  PauseCircle,
  PlayCircle,
  Container,
} from "@untitledui/icons";
import { Input } from "@deco/ui/components/input.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  TimeRangePicker,
  type TimeRange as TimeRangeValue,
} from "@deco/ui/components/time-range-picker.tsx";
import { expressionToDate } from "@deco/ui/lib/time-expressions.ts";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, Suspense, useRef, useState } from "react";
import {
  type EnrichedMonitoringLog,
  type MonitoringLogsResponse,
  type MonitoringSearchParams,
  type PropertyFilter,
  type PropertyFilterOperator,
  deserializePropertyFilters,
  serializePropertyFilters,
  propertyFiltersToApiParams,
  propertyFiltersToRaw,
  parseRawPropertyFilters,
} from "@/web/components/monitoring";
import { Plus, Trash01, Code01, Grid01 } from "@untitledui/icons";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  TopTools,
  type TopChartMetric,
} from "@/web/components/monitoring/analytics-top-tools.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { HomeGridCell } from "@/web/routes/orgs/home/home-grid-cell.tsx";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";

// ============================================================================
// Stats Component
// ============================================================================

interface MonitoringStatsProps {
  displayDateRange: DateRange;
  connectionIds: string[];
  excludeConnectionIds?: string[];
  toolName?: string;
  status?: "success" | "error";
  connections: ReturnType<typeof useConnections>;
  isStreaming: boolean;
  selectedMetric: TopChartMetric;
  onMetricSelect: (metric: TopChartMetric) => void;
}

/**
 * Determine the appropriate interval for timeseries queries based on date range.
 */
function getIntervalFromRange(range: DateRange): "1m" | "1h" | "1d" {
  const durationMs = range.endDate.getTime() - range.startDate.getTime();
  const ONE_HOUR = 60 * 60 * 1000;
  const HOURS_25 = 25 * ONE_HOUR;

  if (durationMs <= ONE_HOUR) return "1m";
  if (durationMs <= HOURS_25) return "1h";
  return "1d";
}

/**
 * Format a timestamp label based on the interval.
 */
function formatTimestampLabel(
  timestamp: string,
  interval: "1m" | "1h" | "1d",
): string {
  const date = new Date(timestamp);
  if (interval === "1d") {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function floorToInterval(date: Date, interval: "1m" | "1h" | "1d"): Date {
  const result = new Date(date);
  if (interval === "1d") {
    result.setHours(0, 0, 0, 0);
    return result;
  }
  if (interval === "1h") {
    result.setMinutes(0, 0, 0);
    return result;
  }
  result.setSeconds(0, 0);
  return result;
}

function addInterval(date: Date, interval: "1m" | "1h" | "1d"): Date {
  const result = new Date(date);
  if (interval === "1d") {
    result.setDate(result.getDate() + 1);
    return result;
  }
  if (interval === "1h") {
    result.setHours(result.getHours() + 1);
    return result;
  }
  result.setMinutes(result.getMinutes() + 1);
  return result;
}

function buildFilledStatsData(
  points: Array<{
    timestamp: string;
    calls: number;
    errors: number;
    errorRate: number;
    avg: number;
    p50: number;
    p95: number;
  }>,
  range: DateRange,
  interval: "1m" | "1h" | "1d",
): MonitoringStatsData["data"] {
  const pointMap = new Map(
    points.map((point) => [
      floorToInterval(new Date(point.timestamp), interval).getTime(),
      point,
    ]),
  );

  const alignedStart = floorToInterval(range.startDate, interval);
  const alignedEnd = floorToInterval(range.endDate, interval);
  const data: MonitoringStatsData["data"] = [];

  for (
    let bucketDate = new Date(alignedStart);
    bucketDate.getTime() <= alignedEnd.getTime();
    bucketDate = addInterval(bucketDate, interval)
  ) {
    const ts = bucketDate.getTime();
    const point = pointMap.get(ts);

    data.push({
      t: bucketDate.toISOString(),
      ts,
      label: formatTimestampLabel(bucketDate.toISOString(), interval),
      calls: point?.calls ?? 0,
      errors: point?.errors ?? 0,
      errorRate: point?.errorRate ?? 0,
      avg: point?.avg ?? 0,
      p50: point?.p50 ?? 0,
      p95: point?.p95 ?? 0,
    });
  }

  return data;
}

interface ConnectionMetric {
  connectionId: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
}

type LeaderboardMode = "requests" | "errors" | "latency";

function getMetricValue(m: ConnectionMetric, mode: LeaderboardMode): number {
  if (mode === "requests") return m.calls;
  if (mode === "errors") return m.errorRate;
  return m.avgDurationMs;
}

function formatDuration(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatMetric(m: ConnectionMetric, mode: LeaderboardMode): string {
  if (mode === "requests") return m.calls.toLocaleString();
  if (mode === "errors") return `${m.errorRate.toFixed(1)}%`;
  return formatDuration(m.avgDurationMs);
}

type StatKPIConfig = {
  id: string;
  dataKey:
    | "calls"
    | "errors"
    | "avg"
    | "p50"
    | "p95"
    | ((
        selected: TopChartMetric,
      ) => "calls" | "errors" | "avg" | "p50" | "p95");
  colorNum: number;
  barColor: string;
  leaderboardMode: LeaderboardMode;
  /** Which TopChartMetric values this card "owns" */
  chartMetrics: TopChartMetric[];
  renderTitle: (
    s: MonitoringStatsData,
    selectedMetric: TopChartMetric,
  ) => ReactNode;
  /** Determine next metric when clicked */
  getNextMetric: (current: TopChartMetric) => TopChartMetric;
};

const STAT_KPI_CONFIG: StatKPIConfig[] = [
  {
    id: "calls",
    dataKey: "calls",
    colorNum: 1,
    barColor: "bg-chart-1",
    leaderboardMode: "requests",
    chartMetrics: ["calls"],
    renderTitle: (s) => (
      <div className="flex flex-col gap-0.5 md:gap-1">
        <p className="text-xs md:text-sm text-muted-foreground">Tool Calls</p>
        <p className="text-sm md:text-lg font-medium">
          {s.totalCalls.toLocaleString()}
        </p>
      </div>
    ),
    getNextMetric: () => "calls",
  },
  {
    id: "latency",
    dataKey: (selected) => (selected === "latency-avg" ? "avg" : "p95"),
    colorNum: 4,
    barColor: "bg-chart-4",
    leaderboardMode: "latency",
    chartMetrics: ["latency-avg", "latency-p95"],
    renderTitle: (s, selectedMetric) => (
      <div className="flex flex-col gap-0.5 md:gap-1">
        <p className="text-xs md:text-sm text-muted-foreground">Latency</p>
        <div className="flex items-baseline gap-3">
          <div
            className={cn(
              "pb-0.5",
              selectedMetric === "latency-avg"
                ? "border-b-2 border-chart-4"
                : "border-b-2 border-transparent",
            )}
          >
            <span className="text-sm md:text-lg font-medium">
              {formatDuration(s.avgDurationMs)}
            </span>
            <span className="text-[10px] md:text-xs text-muted-foreground ml-1">
              avg
            </span>
          </div>
          <div
            className={cn(
              "pb-0.5",
              selectedMetric === "latency-p95"
                ? "border-b-2 border-chart-4"
                : "border-b-2 border-transparent",
            )}
          >
            <span className="text-sm md:text-lg font-medium">
              {formatDuration(s.p95DurationMs)}
            </span>
            <span className="text-[10px] md:text-xs text-muted-foreground ml-1">
              p95
            </span>
          </div>
        </div>
      </div>
    ),
    getNextMetric: (current) =>
      current === "latency-avg" ? "latency-p95" : "latency-avg",
  },
  {
    id: "errors",
    dataKey: "errors",
    colorNum: 3,
    barColor: "bg-chart-3",
    leaderboardMode: "errors",
    chartMetrics: ["errors"],
    renderTitle: (s) => (
      <div className="flex flex-col gap-0.5 md:gap-1">
        <p className="text-xs md:text-sm text-muted-foreground">Errors</p>
        <p className="text-sm md:text-lg font-medium">
          {s.totalErrors.toLocaleString()}
        </p>
      </div>
    ),
    getNextMetric: () => "errors",
  },
];

function ConnectionLeaderboard({
  metrics,
  connections,
  mode,
  barColor,
}: {
  metrics: ConnectionMetric[];
  connections: ReturnType<typeof useConnections>;
  mode: LeaderboardMode;
  barColor: string;
}) {
  const metricsMap = new Map(
    metrics.map((metric) => [metric.connectionId, metric]),
  );
  const allConnections = connections ?? [];

  const ranked = allConnections
    .map((c) => ({ connection: c, metric: metricsMap.get(c.id) }))
    .filter((item) => item.metric)
    .sort(
      (a, b) =>
        getMetricValue(b.metric!, mode) - getMetricValue(a.metric!, mode),
    )
    .slice(0, 5);

  const maxValue = ranked[0]?.metric
    ? getMetricValue(ranked[0].metric, mode)
    : 1;

  if (ranked.length === 0) return null;

  return (
    <div className="space-y-1.5 mt-2">
      {ranked.map(({ connection, metric }) => {
        const value = getMetricValue(metric!, mode);
        const pct = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;
        return (
          <div key={connection.id} className="flex items-center gap-1.5">
            <IntegrationIcon
              icon={connection.icon}
              name={connection.title}
              size="xs"
              fallbackIcon={<Container />}
              className="shrink-0 size-4! min-w-4!"
            />
            <span className="text-[10px] text-foreground truncate min-w-0 w-20">
              {connection.title}
            </span>
            <div className="relative h-1.5 bg-muted/50 overflow-hidden flex-1">
              <div
                className={cn("h-full", barColor)}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums shrink-0 text-foreground">
              {formatMetric(metric!, mode)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MonitoringStatsContent({
  displayDateRange,
  connectionIds,
  excludeConnectionIds,
  toolName,
  status,
  connections,
  isStreaming,
  selectedMetric,
  onMetricSelect,
}: MonitoringStatsProps) {
  const interval = getIntervalFromRange(displayDateRange);
  const { data: serverStats } = useMonitoringStats(
    {
      interval,
      startDate: displayDateRange.startDate.toISOString(),
      endDate: displayDateRange.endDate.toISOString(),
      connectionIds: connectionIds.length > 0 ? connectionIds : undefined,
      excludeConnectionIds,
      toolNames: toolName ? [toolName] : undefined,
      status,
    },
    {
      refetchInterval: isStreaming
        ? MONITORING_CONFIG.streamingRefetchInterval
        : false,
    },
  );

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

  return (
    <div className="border-b border-border">
      <div className="px-5 py-2 bg-muted/30 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Tool Calls
        </span>
      </div>
      <div className="grid grid-cols-3 gap-[0.5px] bg-border flex-shrink-0">
        {STAT_KPI_CONFIG.map((config) => {
          const {
            id,
            dataKey,
            colorNum,
            barColor,
            leaderboardMode,
            chartMetrics,
            renderTitle,
            getNextMetric,
          } = config;
          const isSelected = chartMetrics.includes(selectedMetric);
          const handleClick = () => {
            if (isSelected) {
              // Already selected — cycle sub-metrics
              onMetricSelect(getNextMetric(selectedMetric));
            } else {
              // First click — select the first metric for this card
              onMetricSelect(chartMetrics[0]!);
            }
          };
          return (
            <div
              key={id}
              className="bg-background relative cursor-pointer"
              onClick={handleClick}
            >
              {isSelected && (
                <div
                  className="absolute top-0 left-0 right-0 h-0.5 z-10"
                  style={{
                    backgroundColor: `var(--chart-${colorNum})`,
                  }}
                />
              )}
              <HomeGridCell title={renderTitle(stats, selectedMetric)}>
                <div className="flex flex-col w-full">
                  <KPIChart
                    data={stats.data}
                    dataKey={
                      typeof dataKey === "function"
                        ? dataKey(selectedMetric)
                        : dataKey
                    }
                    colorNum={colorNum}
                    chartHeight="h-[30px] md:h-[40px]"
                  />
                  <ConnectionLeaderboard
                    metrics={serverStats?.connectionBreakdown ?? []}
                    connections={connections}
                    mode={leaderboardMode}
                    barColor={barColor}
                  />
                </div>
              </HomeGridCell>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MonitoringStats = Object.assign(MonitoringStatsContent, {
  Skeleton: MonitoringStatsRowSkeleton,
});

// ============================================================================
// LLM Call Stats Component
// ============================================================================

interface LlmStatsProps {
  displayDateRange: DateRange;
  isStreaming: boolean;
}

function LlmStatsContent({ displayDateRange, isStreaming }: LlmStatsProps) {
  const interval = getIntervalFromRange(displayDateRange);
  const { data: serverStats } = useMonitoringLlmStats(
    {
      interval,
      startDate: displayDateRange.startDate.toISOString(),
      endDate: displayDateRange.endDate.toISOString(),
    },
    {
      refetchInterval: isStreaming
        ? MONITORING_CONFIG.streamingRefetchInterval
        : false,
    },
  );

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

  const llmKpiConfigs = [
    {
      id: "llm-calls",
      dataKey: "calls" as const,
      colorNum: 1,
      renderTitle: () => (
        <div className="flex flex-col gap-0.5 md:gap-1">
          <p className="text-xs md:text-sm text-muted-foreground">LLM Calls</p>
          <p className="text-sm md:text-lg font-medium">
            {stats.totalCalls.toLocaleString()}
          </p>
        </div>
      ),
    },
    {
      id: "llm-latency",
      dataKey: "avg" as const,
      colorNum: 4,
      renderTitle: () => (
        <div className="flex flex-col gap-0.5 md:gap-1">
          <p className="text-xs md:text-sm text-muted-foreground">
            LLM Latency
          </p>
          <div className="flex items-baseline gap-3">
            <div>
              <span className="text-sm md:text-lg font-medium">
                {formatDuration(stats.avgDurationMs)}
              </span>
              <span className="text-[10px] md:text-xs text-muted-foreground ml-1">
                avg
              </span>
            </div>
            <div>
              <span className="text-sm md:text-lg font-medium">
                {formatDuration(stats.p95DurationMs)}
              </span>
              <span className="text-[10px] md:text-xs text-muted-foreground ml-1">
                p95
              </span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "llm-errors",
      dataKey: "errors" as const,
      colorNum: 3,
      renderTitle: () => (
        <div className="flex flex-col gap-0.5 md:gap-1">
          <p className="text-xs md:text-sm text-muted-foreground">LLM Errors</p>
          <p className="text-sm md:text-lg font-medium">
            {stats.totalErrors.toLocaleString()}
          </p>
        </div>
      ),
    },
  ];

  return (
    <div className="border-b border-border">
      <div className="px-5 py-2 bg-muted/30 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          LLM Calls
        </span>
      </div>
      <div className="grid grid-cols-3 gap-[0.5px] bg-border flex-shrink-0">
        {llmKpiConfigs.map(({ id, dataKey, colorNum, renderTitle }) => (
          <div key={id} className="bg-background">
            <HomeGridCell title={renderTitle()}>
              <KPIChart
                data={stats.data}
                dataKey={dataKey}
                colorNum={colorNum}
                chartHeight="h-[30px] md:h-[40px]"
              />
            </HomeGridCell>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Filters Popover Component
// ============================================================================

interface FiltersPopoverProps {
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  hideSystem: boolean;
  propertyFilters: PropertyFilter[];
  connectionOptions: Array<{ value: string; label: string }>;
  virtualMcpOptions: Array<{ value: string; label: string }>;
  activeFiltersCount: number;
  onUpdateFilters: (updates: Partial<MonitoringSearchParams>) => void;
}

const OPERATOR_OPTIONS: Array<{
  value: PropertyFilterOperator;
  label: string;
}> = [
  { value: "eq", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "in", label: "in (list)" },
  { value: "exists", label: "exists" },
];

function FiltersPopover({
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  hideSystem,
  propertyFilters,
  connectionOptions,
  virtualMcpOptions,
  activeFiltersCount,
  onUpdateFilters,
}: FiltersPopoverProps) {
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [propertyFilterMode, setPropertyFilterMode] = useState<"raw" | "form">(
    "raw",
  );

  // Local state for text inputs to prevent focus loss during typing
  const [localTool, setLocalTool] = useState(tool);
  const [localPropertyFilters, setLocalPropertyFilters] =
    useState<PropertyFilter[]>(propertyFilters);
  const [localRawFilters, setLocalRawFilters] = useState(
    propertyFiltersToRaw(propertyFilters),
  );

  // Track previous prop values to detect external changes
  const prevToolRef = useRef(tool);
  const prevPropertyFiltersRef = useRef(
    serializePropertyFilters(propertyFilters),
  );

  // Sync local state when props change externally (not from our own updates)
  if (prevToolRef.current !== tool) {
    prevToolRef.current = tool;
    if (localTool !== tool) {
      setLocalTool(tool);
    }
  }

  const currentSerialized = serializePropertyFilters(propertyFilters);
  if (prevPropertyFiltersRef.current !== currentSerialized) {
    prevPropertyFiltersRef.current = currentSerialized;
    setLocalPropertyFilters(propertyFilters);
    setLocalRawFilters(propertyFiltersToRaw(propertyFilters));
  }

  const updatePropertyFilter = (
    index: number,
    updates: Partial<PropertyFilter>,
  ) => {
    const newFilters = [...localPropertyFilters];
    const existing = newFilters[index];
    if (!existing) return;
    newFilters[index] = {
      key: updates.key ?? existing.key,
      operator: updates.operator ?? existing.operator,
      value: updates.value ?? existing.value,
    };
    setLocalPropertyFilters(newFilters);
  };

  const addPropertyFilter = () => {
    setLocalPropertyFilters([
      ...localPropertyFilters,
      { key: "", operator: "eq", value: "" },
    ]);
  };

  const removePropertyFilter = (index: number) => {
    const newFilters = localPropertyFilters.filter((_, i) => i !== index);
    setLocalPropertyFilters(newFilters);
    setLocalRawFilters(propertyFiltersToRaw(newFilters));
    // Immediately sync when removing
    onUpdateFilters({ propertyFilters: serializePropertyFilters(newFilters) });
  };

  const applyPropertyFilters = () => {
    onUpdateFilters({
      propertyFilters: serializePropertyFilters(localPropertyFilters),
    });
  };

  const applyRawFilters = () => {
    const parsed = parseRawPropertyFilters(localRawFilters);
    setLocalPropertyFilters(parsed);
    onUpdateFilters({
      propertyFilters: serializePropertyFilters(parsed),
    });
  };

  const toggleMode = () => {
    if (propertyFilterMode === "raw") {
      // Switching to form mode - parse raw
      const parsed = parseRawPropertyFilters(localRawFilters);
      setLocalPropertyFilters(parsed);
      setPropertyFilterMode("form");
    } else {
      // Switching to raw mode - serialize form
      setLocalRawFilters(propertyFiltersToRaw(localPropertyFilters));
      setPropertyFilterMode("raw");
    }
  };

  return (
    <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FilterLines size={16} />
          Filters
          {activeFiltersCount > 0 && (
            <Badge
              variant="default"
              className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs"
            >
              {activeFiltersCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px]">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm mb-3">Filter Logs</h4>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="hide-system-calls"
                className="text-xs font-medium text-muted-foreground cursor-pointer"
              >
                Hide system calls
              </Label>
              <Switch
                id="hide-system-calls"
                checked={hideSystem}
                onCheckedChange={(checked) =>
                  onUpdateFilters({ hideSystem: !!checked })
                }
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Connections
              </label>
              <MultiSelect
                options={connectionOptions}
                defaultValue={connectionIds}
                onValueChange={(values) =>
                  onUpdateFilters({ connectionId: values })
                }
                placeholder="All servers"
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Agents
              </label>
              <MultiSelect
                options={virtualMcpOptions}
                defaultValue={virtualMcpIds}
                onValueChange={(values) =>
                  onUpdateFilters({ virtualMcpId: values })
                }
                placeholder="All Agents"
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Tool Name
              </label>
              <Input
                id="filter-tool"
                placeholder="Filter by tool..."
                value={localTool}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLocalTool(e.target.value)
                }
                onBlur={() => {
                  if (localTool !== tool) {
                    onUpdateFilters({ tool: localTool });
                  }
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter" && localTool !== tool) {
                    onUpdateFilters({ tool: localTool });
                  }
                }}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Status
              </label>
              <Select
                value={status}
                onValueChange={(value: string) =>
                  onUpdateFilters({
                    status: value as MonitoringSearchParams["status"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="success">Success Only</SelectItem>
                  <SelectItem value="errors">Errors Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Property Filters
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleMode}
                    >
                      {propertyFilterMode === "raw" ? (
                        <Grid01 size={14} />
                      ) : (
                        <Code01 size={14} />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {propertyFilterMode === "raw"
                      ? "Switch to form view"
                      : "Switch to raw text"}
                  </TooltipContent>
                </Tooltip>
              </div>

              {propertyFilterMode === "raw" ? (
                <div className="space-y-1.5">
                  <Textarea
                    placeholder={`Paste property filters here:\nthread_id=abc123\nuser~test\ndebug?`}
                    value={localRawFilters}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setLocalRawFilters(e.target.value)
                    }
                    onBlur={applyRawFilters}
                    onKeyDown={(
                      e: React.KeyboardEvent<HTMLTextAreaElement>,
                    ) => {
                      if (e.key === "Enter" && e.metaKey) {
                        applyRawFilters();
                      }
                    }}
                    className="font-mono text-sm min-h-[80px] resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    One per line:{" "}
                    <code className="bg-muted px-1 rounded">key=value</code>{" "}
                    <code className="bg-muted px-1 rounded">key~contains</code>{" "}
                    <code className="bg-muted px-1 rounded">key@in_list</code>{" "}
                    <code className="bg-muted px-1 rounded">key?</code>
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {localPropertyFilters.map((filter, index) => (
                    <div
                      key={index}
                      className="p-2.5 rounded-md border border-border bg-muted/30 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          Filter {index + 1}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => removePropertyFilter(index)}
                        >
                          <Trash01 size={12} />
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Key (e.g., thread_id)"
                          value={filter.key}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updatePropertyFilter(index, { key: e.target.value })
                          }
                          onBlur={applyPropertyFilters}
                          onKeyDown={(
                            e: React.KeyboardEvent<HTMLInputElement>,
                          ) => {
                            if (e.key === "Enter") applyPropertyFilters();
                          }}
                          className="flex-1 font-mono text-sm"
                        />
                        <Select
                          value={filter.operator}
                          onValueChange={(value: PropertyFilterOperator) => {
                            // Compute new filters directly to avoid stale closure
                            const newFilters = [...localPropertyFilters];
                            const existing = newFilters[index];
                            if (existing) {
                              newFilters[index] = {
                                ...existing,
                                operator: value,
                                value: value === "exists" ? "" : existing.value,
                              };
                              setLocalPropertyFilters(newFilters);
                              onUpdateFilters({
                                propertyFilters:
                                  serializePropertyFilters(newFilters),
                              });
                            }
                          }}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {OPERATOR_OPTIONS.map((op) => (
                              <SelectItem key={op.value} value={op.value}>
                                {op.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {filter.operator !== "exists" && (
                        <Input
                          placeholder="Value"
                          value={filter.value}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updatePropertyFilter(index, {
                              value: e.target.value,
                            })
                          }
                          onBlur={applyPropertyFilters}
                          onKeyDown={(
                            e: React.KeyboardEvent<HTMLInputElement>,
                          ) => {
                            if (e.key === "Enter") applyPropertyFilters();
                          }}
                          className="w-full font-mono text-sm"
                        />
                      )}
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={addPropertyFilter}
                  >
                    <Plus size={14} className="mr-1.5" />
                    Add filter
                  </Button>
                </div>
              )}
            </div>
          </div>

          {activeFiltersCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setLocalTool("");
                setLocalPropertyFilters([]);
                setLocalRawFilters("");
                onUpdateFilters({
                  connectionId: [],
                  virtualMcpId: [],
                  tool: "",
                  status: "all",
                  propertyFilters: "",
                });
                setFilterPopoverOpen(false);
              }}
            >
              Clear all filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Logs Table Component
// ============================================================================

interface MonitoringLogsTableProps {
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  search: string;
  logs: MonitoringLogsResponse["logs"];
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore: boolean;
  connections: ReturnType<typeof useConnections>;
  virtualMcps: ReturnType<typeof useVirtualMCPs>;
  membersData: ReturnType<typeof useMembers>["data"];
}

function MonitoringLogsTableContent({
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  search: searchQuery,
  logs,
  hasMore,
  onLoadMore,
  isLoadingMore,
  connections: connectionsData,
  virtualMcps: virtualMcpsData,
  membersData,
}: MonitoringLogsTableProps) {
  const connections = connectionsData ?? [];
  const virtualMcps = virtualMcpsData ?? [];
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Use the infinite scroll hook with loading guard
  const lastLogRef = useInfiniteScroll(onLoadMore, hasMore, isLoadingMore);

  const members = membersData?.data?.members ?? [];
  const userMap = new Map(members.map((m) => [m.userId, m.user]));

  // Create virtual MCP lookup map
  const virtualMcpMap = new Map(virtualMcps.map((vm) => [vm.id, vm]));

  const enrichedLogs: EnrichedMonitoringLog[] = logs.map((log) => {
    const user = userMap.get(log.userId ?? "");
    const virtualMcp = log.virtualMcpId
      ? virtualMcpMap.get(log.virtualMcpId)
      : null;
    return {
      ...log,
      userName: user?.name ?? log.userId ?? "Unknown",
      userImage: user?.image,
      virtualMcpName: virtualMcp?.title ?? null,
    };
  });

  // Filter logs by search query and multiple connections/virtual MCPs (client-side)
  let filteredLogs = enrichedLogs;

  // Filter by multiple connection IDs (if more than one selected)
  if (connectionIds.length > 1) {
    filteredLogs = filteredLogs.filter((log) =>
      connectionIds.includes(log.connectionId),
    );
  }

  // Filter by multiple virtual MCP IDs (if more than one selected)
  if (virtualMcpIds.length > 1) {
    filteredLogs = filteredLogs.filter(
      (log) => log.virtualMcpId && virtualMcpIds.includes(log.virtualMcpId),
    );
  }

  // Filter by search query
  if (searchQuery) {
    const lowerQuery = searchQuery.toLowerCase();
    filteredLogs = filteredLogs.filter(
      (log) =>
        log.toolName.toLowerCase().includes(lowerQuery) ||
        log.connectionTitle.toLowerCase().includes(lowerQuery) ||
        log.errorMessage?.toLowerCase().includes(lowerQuery),
    );
  }

  const toggleRow = (log: EnrichedMonitoringLog) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(log.id)) {
        next.delete(log.id);
      } else {
        next.add(log.id);
      }
      return next;
    });
  };

  // Get connection info
  const connectionMap = new Map(connections.map((c) => [c.id, c]));

  if (filteredLogs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-logs.svg"
              alt=""
              width={336}
              height={320}
              aria-hidden="true"
            />
          }
          title="No logs found"
          description={
            searchQuery ||
            connectionIds.length > 0 ||
            virtualMcpIds.length > 0 ||
            tool ||
            status !== "all"
              ? "No logs match your filters"
              : "No logs found in this time range"
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="min-w-[600px] md:min-w-0 bg-background">
          <Table className="w-full border-collapse">
            <TableHeader className="border-b-0 z-20">
              <TableRow className="h-9 hover:bg-transparent border-b border-border">
                {/* Expand Icon Column */}
                <TableHead className="w-10 md:w-12 px-2 md:px-4" />

                {/* Connection Icon Column */}
                <TableHead className="w-5" />

                {/* Tool/Connection Column */}
                <TableHead className="pr-2 md:pr-4 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Tool / Connection
                </TableHead>

                {/* Agent Column */}
                <TableHead className="w-24 md:w-32 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Agent
                </TableHead>

                {/* User name Column */}
                <TableHead className="w-20 md:w-24 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  User Name
                </TableHead>

                {/* Date Column */}
                <TableHead className="w-20 md:w-24 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Date
                </TableHead>

                {/* Time Column */}
                <TableHead className="w-20 md:w-28 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide">
                  Time
                </TableHead>

                {/* Duration Column */}
                <TableHead className="w-16 md:w-20 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right">
                  Latency
                </TableHead>

                {/* Status Column */}
                <TableHead className="w-16 md:w-24 px-2 md:px-3 text-xs font-mono font-normal text-muted-foreground uppercase tracking-wide text-right pr-3 md:pr-5">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLogs.map((log, index) => (
                <LogRow
                  key={log.id}
                  log={log}
                  isExpanded={expandedRows.has(log.id)}
                  connection={connectionMap.get(log.connectionId)}
                  virtualMcpName={log.virtualMcpName ?? ""}
                  onToggle={() => toggleRow(log)}
                  lastLogRef={
                    index === filteredLogs.length - 1 ? lastLogRef : undefined
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function MonitoringLogsTableSkeleton() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="min-w-[600px] md:min-w-0 bg-background">
          <Table className="w-full border-collapse">
            <TableHeader className="border-b-0 z-20">
              <TableRow className="h-9 hover:bg-transparent border-b border-border">
                <TableHead className="w-10 md:w-12 px-2 md:px-4" />
                <TableHead className="w-5" />
                <TableHead className="pr-2 md:pr-4">
                  <div className="h-3 w-24 rounded bg-muted animate-pulse" />
                </TableHead>
                <TableHead className="w-24 md:w-32 px-2 md:px-3">
                  <div className="h-3 w-12 rounded bg-muted animate-pulse" />
                </TableHead>
                <TableHead className="w-20 md:w-24 px-2 md:px-3">
                  <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                </TableHead>
                <TableHead className="w-20 md:w-24 px-2 md:px-3">
                  <div className="h-3 w-10 rounded bg-muted animate-pulse" />
                </TableHead>
                <TableHead className="w-20 md:w-28 px-2 md:px-3">
                  <div className="h-3 w-10 rounded bg-muted animate-pulse" />
                </TableHead>
                <TableHead className="w-16 md:w-20 px-2 md:px-3">
                  <div className="h-3 w-10 rounded bg-muted animate-pulse ml-auto" />
                </TableHead>
                <TableHead className="w-16 md:w-24 px-2 md:px-3 pr-3 md:pr-5">
                  <div className="h-3 w-12 rounded bg-muted animate-pulse ml-auto" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i} className="h-12 border-b border-border">
                  <td className="px-2 md:px-4">
                    <div className="size-4 rounded bg-muted animate-pulse" />
                  </td>
                  <td>
                    <div className="size-5 rounded bg-muted animate-pulse" />
                  </td>
                  <td className="pr-2 md:pr-4">
                    <div className="space-y-1">
                      <div className="h-3.5 w-32 rounded bg-muted animate-pulse" />
                      <div className="h-2.5 w-20 rounded bg-muted animate-pulse" />
                    </div>
                  </td>
                  <td className="px-2 md:px-3">
                    <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                  </td>
                  <td className="px-2 md:px-3">
                    <div className="h-3 w-14 rounded bg-muted animate-pulse" />
                  </td>
                  <td className="px-2 md:px-3">
                    <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                  </td>
                  <td className="px-2 md:px-3">
                    <div className="h-3 w-14 rounded bg-muted animate-pulse" />
                  </td>
                  <td className="px-2 md:px-3">
                    <div className="h-3 w-10 rounded bg-muted animate-pulse ml-auto" />
                  </td>
                  <td className="px-2 md:px-3 pr-3 md:pr-5">
                    <div className="h-5 w-14 rounded-full bg-muted animate-pulse ml-auto" />
                  </td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

const MonitoringLogsTable = Object.assign(MonitoringLogsTableContent, {
  Skeleton: MonitoringLogsTableSkeleton,
});

interface AuditTabContentProps {
  client: ReturnType<typeof useMCPClient>;
  locator: ReturnType<typeof useProjectContext>["locator"];
  baseParams: Record<string, unknown>;
  pageSize: number;
  isStreaming: boolean;
  streamingRefetchInterval: number;
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  searchQuery: string;
  onUpdateFilters: (updates: Partial<MonitoringSearchParams>) => void;
  allConnections: ReturnType<typeof useConnections>;
  allVirtualMcps: ReturnType<typeof useVirtualMCPs>;
  membersData: ReturnType<typeof useMembers>["data"];
}

function AuditTabContent({
  client,
  locator,
  baseParams,
  pageSize,
  isStreaming,
  streamingRefetchInterval,
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  searchQuery,
  onUpdateFilters,
  allConnections,
  allVirtualMcps,
  membersData,
}: AuditTabContentProps) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery({
      queryKey: KEYS.monitoringLogsInfinite(
        locator,
        JSON.stringify(baseParams),
      ),
      queryFn: async ({ pageParam = 0 }) => {
        if (!client) {
          throw new Error("MCP client is not available");
        }
        const result = (await client.callTool({
          name: "MONITORING_LOGS_LIST",
          arguments: {
            ...baseParams,
            limit: pageSize,
            offset: pageParam,
          },
        })) as { structuredContent?: unknown };
        return (result.structuredContent ?? result) as MonitoringLogsResponse;
      },
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) => {
        // If we got fewer logs than pageSize, there are no more pages
        if ((lastPage?.logs?.length ?? 0) < pageSize) {
          return undefined;
        }
        // Otherwise, return the next offset
        return allPages.length * pageSize;
      },
      staleTime: 0,
      refetchInterval: isStreaming ? streamingRefetchInterval : false,
    });

  const allLogs = data.pages.flatMap((page) => page.logs ?? []);

  const handleLoadMore = () => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
      {/* Search Bar */}
      <CollectionSearch
        value={searchQuery}
        onChange={(value) => onUpdateFilters({ search: value })}
        placeholder="Search by tool name, connection, or error..."
        className="border-t"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onUpdateFilters({ search: "" });
            (event.target as HTMLInputElement).blur();
          }
        }}
      />

      {/* Logs Table */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <MonitoringLogsTable
          connectionIds={connectionIds}
          virtualMcpIds={virtualMcpIds}
          tool={tool}
          status={status}
          search={searchQuery}
          logs={allLogs}
          hasMore={hasNextPage ?? false}
          onLoadMore={handleLoadMore}
          isLoadingMore={isFetchingNextPage}
          connections={allConnections}
          virtualMcps={allVirtualMcps}
          membersData={membersData}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Main Dashboard Component
// ============================================================================

interface MonitoringDashboardContentProps {
  tab: "overview" | "audit" | "dashboards";
  dateRange: DateRange;
  displayDateRange: DateRange;
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  search: string;
  streaming: boolean;
  hideSystem: boolean;
  activeFiltersCount: number;
  from: string;
  to: string;
  propertyFilters: PropertyFilter[];
  onUpdateFilters: (updates: Partial<MonitoringSearchParams>) => void;
  onTimeRangeChange: (range: TimeRangeValue) => void;
  onStreamingToggle: () => void;
  onTabChange: (tab: "overview" | "audit" | "dashboards") => void;
}

function MonitoringDashboardContent({
  tab,
  dateRange,
  displayDateRange,
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  search: searchQuery,
  streaming: isStreaming,
  hideSystem,
  activeFiltersCount,
  from,
  to,
  propertyFilters,
  onUpdateFilters,
  onTimeRangeChange,
  onStreamingToggle,
  onTabChange,
}: MonitoringDashboardContentProps) {
  // Get all connections, virtual MCPs, and members - moved here because these hooks suspend
  const allConnections = useConnections();
  const allVirtualMcps = useVirtualMCPs();
  const { data: membersData } = useMembers();
  const connectionOptions = (allConnections ?? []).map((conn) => ({
    value: conn.id,
    label: conn.title || conn.id,
  }));
  const virtualMcpOptions = allVirtualMcps.map((vm) => ({
    value: vm.id ?? "",
    label: vm.title ?? "Decopilot",
  }));

  const { pageSize, streamingRefetchInterval } = MONITORING_CONFIG;
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Convert property filters to API params
  const propertyApiParams = propertyFiltersToApiParams(propertyFilters);

  // Compute excluded connection IDs when hiding system calls
  const excludeConnectionIds = hideSystem
    ? [WellKnownOrgMCPId.SELF(org.id)]
    : undefined;

  // Base params for filtering (without pagination)
  const baseParams = {
    startDate: dateRange.startDate.toISOString(),
    endDate: dateRange.endDate.toISOString(),
    connectionId: connectionIds.length === 1 ? connectionIds[0] : undefined,
    excludeConnectionIds,
    virtualMcpId: virtualMcpIds.length === 1 ? virtualMcpIds[0] : undefined,
    toolName: tool || undefined,
    isError:
      status === "errors" ? true : status === "success" ? false : undefined,
    ...propertyApiParams,
  };

  const [topChartMetric, setTopChartMetric] = useState<TopChartMetric>("calls");

  // Build dateRange strings for analytics components (use display range, not the streaming-extended fetch range)
  const analyticsDateRange = {
    startDate: displayDateRange.startDate.toISOString(),
    endDate: displayDateRange.endDate.toISOString(),
  };

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "audit" as const, label: "Audit" },
    { id: "dashboards" as const, label: "Dashboards" },
  ];

  return (
    <>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Monitoring</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        {(tab === "overview" || tab === "audit") && (
          <Page.Header.Right>
            <div className="flex flex-wrap items-center gap-2">
              {/* Filters Button */}
              <FiltersPopover
                connectionIds={connectionIds}
                virtualMcpIds={virtualMcpIds}
                tool={tool}
                status={status}
                hideSystem={hideSystem}
                propertyFilters={propertyFilters}
                connectionOptions={connectionOptions}
                virtualMcpOptions={virtualMcpOptions}
                activeFiltersCount={activeFiltersCount}
                onUpdateFilters={onUpdateFilters}
              />

              {/* Streaming Toggle */}
              <Button
                variant={isStreaming ? "secondary" : "outline"}
                size="sm"
                className={cn(
                  "h-7 px-2 sm:px-3 gap-1.5",
                  isStreaming && "bg-muted hover:bg-muted/80",
                )}
                onClick={onStreamingToggle}
              >
                {isStreaming ? (
                  <PauseCircle size={16} className="animate-pulse" />
                ) : (
                  <PlayCircle size={16} />
                )}
                <span className="hidden sm:inline">
                  {isStreaming ? "Streaming" : "Stream"}
                </span>
              </Button>

              {/* Time Range Picker */}
              <TimeRangePicker
                value={{ from, to }}
                onChange={onTimeRangeChange}
              />
            </div>
          </Page.Header.Right>
        )}
      </Page.Header>

      {/* Tabs */}
      <div className="px-5 py-3 border-b border-border">
        <CollectionTabs
          tabs={tabs}
          activeTab={tab}
          onTabChange={(tabId) =>
            onTabChange(tabId as "overview" | "audit" | "dashboards")
          }
        />
      </div>

      {tab === "dashboards" ? (
        <DashboardsTab />
      ) : tab === "audit" ? (
        <AuditTabContent
          client={client}
          locator={locator}
          baseParams={baseParams}
          pageSize={pageSize}
          isStreaming={isStreaming}
          streamingRefetchInterval={streamingRefetchInterval}
          connectionIds={connectionIds}
          virtualMcpIds={virtualMcpIds}
          tool={tool}
          status={status}
          searchQuery={searchQuery}
          onUpdateFilters={onUpdateFilters}
          allConnections={allConnections}
          allVirtualMcps={allVirtualMcps}
          membersData={membersData}
        />
      ) : (
        <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
          {/* Top Tools Chart */}
          <div className="border-b border-border relative z-10">
            <ErrorBoundary fallback={null}>
              <Suspense fallback={<TopTools.Skeleton />}>
                <TopTools.Content
                  metricsMode={topChartMetric}
                  dateRange={analyticsDateRange}
                  connectionIds={connectionIds}
                  excludeConnectionIds={excludeConnectionIds}
                  toolName={tool || undefined}
                  status={
                    status === "errors"
                      ? "error"
                      : status === "success"
                        ? "success"
                        : undefined
                  }
                  isStreaming={isStreaming}
                  streamingRefetchInterval={streamingRefetchInterval}
                />
              </Suspense>
            </ErrorBoundary>
          </div>

          {/* Stats with Connection Leaderboards */}
          <MonitoringStats
            displayDateRange={displayDateRange}
            connectionIds={connectionIds}
            excludeConnectionIds={excludeConnectionIds}
            toolName={tool || undefined}
            status={
              status === "errors"
                ? "error"
                : status === "success"
                  ? "success"
                  : undefined
            }
            connections={allConnections}
            isStreaming={isStreaming}
            selectedMetric={topChartMetric}
            onMetricSelect={setTopChartMetric}
          />

          {/* LLM Call Stats */}
          <LlmStatsContent
            displayDateRange={displayDateRange}
            isStreaming={isStreaming}
          />
        </div>
      )}
    </>
  );
}

export default function MonitoringDashboard() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const search = useSearch({
    from: "/shell/$org/$project/monitoring",
  });

  const {
    tab = "overview",
    from,
    to,
    connectionId: connectionIds = [],
    virtualMcpId: virtualMcpIds = [],
    tool,
    search: searchQuery,
    status,
    streaming = true,
    propertyFilters: propertyFiltersStr = "",
    hideSystem = false,
  } = search;

  // Parse property filters from URL string
  const propertyFilters = deserializePropertyFilters(propertyFiltersStr);

  // Update URL with new filter values (pagination is handled internally, not in URL)
  const updateFilters = (updates: Partial<MonitoringSearchParams>) => {
    navigate({
      to: "/$org/$project/monitoring",
      params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      search: {
        ...search,
        ...updates,
      },
    });
  };

  // Handle time range change
  const handleTimeRangeChange = (range: TimeRangeValue) => {
    updateFilters({ from: range.from, to: range.to });
  };

  // Calculate date range from expressions
  const fromResult = expressionToDate(from);
  const toResult = expressionToDate(to);

  const startDate = fromResult.date || new Date(Date.now() - 30 * 60 * 1000);
  const originalEndDate = toResult.date || new Date();

  // Original range for bucket calculations (what user selected)
  const displayDateRange = { startDate, endDate: originalEndDate };

  // Extended range for fetching logs when streaming
  let fetchEndDate = originalEndDate;
  if (streaming && to === "now") {
    fetchEndDate = new Date(originalEndDate);
    fetchEndDate.setHours(fetchEndDate.getHours() + 1);
  }
  const dateRange = { startDate, endDate: fetchEndDate };

  let activeFiltersCount = 0;
  if (connectionIds.length > 0) activeFiltersCount++;
  if (virtualMcpIds.length > 0) activeFiltersCount++;
  if (tool) activeFiltersCount++;
  if (status !== "all") activeFiltersCount++;
  if (hideSystem) activeFiltersCount++;
  // Count property filters with non-empty keys
  const validPropertyFilters = propertyFilters.filter((f) => f.key.trim());
  if (validPropertyFilters.length > 0)
    activeFiltersCount += validPropertyFilters.length;

  return (
    <Page>
      <ErrorBoundary
        fallback={
          <>
            <Page.Header>
              <Page.Header.Left>
                <h1 className="text-sm font-medium text-foreground">
                  Monitoring
                </h1>
              </Page.Header.Left>
            </Page.Header>
            <Page.Content>
              <div className="flex flex-col overflow-auto md:overflow-hidden h-full">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-[0.5px] bg-border shrink-0 border-b">
                  <div className="bg-background p-5 text-sm text-muted-foreground">
                    Failed to load monitoring data
                  </div>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <EmptyState
                    title="Failed to load logs"
                    description="There was an error loading the monitoring data. Please try again."
                  />
                </div>
              </div>
            </Page.Content>
          </>
        }
      >
        <Suspense
          fallback={
            <>
              <Page.Header>
                <Page.Header.Left>
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbPage>Monitoring</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </Page.Header.Left>
              </Page.Header>

              {/* Tabs */}
              <div className="px-5 py-3 border-b border-border">
                <CollectionTabs
                  tabs={[
                    { id: "overview", label: "Overview" },
                    { id: "audit", label: "Audit" },
                    { id: "dashboards", label: "Dashboards" },
                  ]}
                  activeTab={tab}
                  onTabChange={(tabId) =>
                    updateFilters({
                      tab: tabId as "overview" | "audit" | "dashboards",
                    })
                  }
                />
              </div>

              {tab === "audit" ? (
                <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
                  <MonitoringLogsTable.Skeleton />
                </div>
              ) : tab === "dashboards" ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-muted-foreground">
                    Loading dashboards...
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
                  <div className="border-b border-border">
                    <TopTools.Skeleton />
                  </div>
                  <MonitoringStats.Skeleton />
                </div>
              )}
            </>
          }
        >
          <MonitoringDashboardContent
            tab={tab}
            dateRange={dateRange}
            displayDateRange={displayDateRange}
            connectionIds={connectionIds}
            virtualMcpIds={virtualMcpIds}
            tool={tool}
            status={status}
            search={searchQuery}
            streaming={streaming}
            hideSystem={hideSystem}
            activeFiltersCount={activeFiltersCount}
            from={from}
            to={to}
            propertyFilters={propertyFilters}
            onUpdateFilters={updateFilters}
            onTimeRangeChange={handleTimeRangeChange}
            onStreamingToggle={() => updateFilters({ streaming: !streaming })}
            onTabChange={(newTab) => updateFilters({ tab: newTab })}
          />
        </Suspense>
      </ErrorBoundary>
    </Page>
  );
}
