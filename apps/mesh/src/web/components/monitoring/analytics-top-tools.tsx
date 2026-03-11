/**
 * Top Tools Analytics Component
 *
 * Displays a line chart of top tools by usage, switchable between calls/latency/errors.
 */

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { HomeGridCell } from "@/web/routes/orgs/home/home-grid-cell.tsx";
import { ChartContainer, ChartTooltip } from "@deco/ui/components/chart.tsx";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { Container } from "@untitledui/icons";
import { Line, LineChart, XAxis } from "recharts";
import { useMonitoringTopTools } from "./hooks";

export type TopChartMetric = "calls" | "latency-avg" | "latency-p95" | "errors";

interface BucketData {
  t: string;
  ts: number;
  label: string;
  [key: string]: string | number;
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

function formatBucketLabel(date: Date, interval: "1m" | "1h" | "1d"): string {
  if (interval === "1d") {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function buildToolBuckets(
  topTools: Array<{ toolName: string; connectionId: string | null }>,
  timeseries: Array<{
    timestamp: string;
    toolName: string;
    calls: number;
    errors: number;
    avg: number;
    p95: number;
  }>,
  start: Date,
  end: Date,
  interval: "1m" | "1h" | "1d",
): {
  callsBuckets: BucketData[];
  latencyAvgBuckets: BucketData[];
  latencyP95Buckets: BucketData[];
  errorsBuckets: BucketData[];
  chartConfig: Record<string, { label: string; color: string }>;
  toolColors: Map<string, string>;
} {
  const toolNames = topTools.map((tool) => tool.toolName);
  const bucketMap = new Map<
    string,
    {
      t: string;
      ts: number;
      label: string;
      tools: Map<
        string,
        { calls: number; errors: number; avg: number; p95: number }
      >;
    }
  >();

  const alignedStart = floorToInterval(start, interval);
  const alignedEnd = floorToInterval(end, interval);

  for (
    let bucketDate = new Date(alignedStart);
    bucketDate.getTime() <= alignedEnd.getTime();
    bucketDate = addInterval(bucketDate, interval)
  ) {
    bucketMap.set(String(bucketDate.getTime()), {
      t: bucketDate.toISOString(),
      ts: bucketDate.getTime(),
      label: formatBucketLabel(bucketDate, interval),
      tools: new Map(),
    });
  }

  for (const point of timeseries) {
    const bucketDate = floorToInterval(new Date(point.timestamp), interval);
    const timestampKey = String(bucketDate.getTime());
    let bucket = bucketMap.get(timestampKey);
    if (!bucket) {
      bucket = {
        t: bucketDate.toISOString(),
        ts: bucketDate.getTime(),
        label: formatBucketLabel(bucketDate, interval),
        tools: new Map(),
      };
      bucketMap.set(timestampKey, bucket);
    }

    bucket.tools.set(point.toolName, {
      calls: point.calls,
      errors: point.errors,
      avg: point.avg,
      p95: point.p95,
    });
  }

  const rawBuckets = [...bucketMap.values()].sort((a, b) => a.ts - b.ts);
  const callsBuckets: BucketData[] = [];
  const latencyAvgBuckets: BucketData[] = [];
  const latencyP95Buckets: BucketData[] = [];
  const errorsBuckets: BucketData[] = [];

  for (const raw of rawBuckets) {
    const base = { t: raw.t, ts: raw.ts, label: raw.label };
    const calls: BucketData = { ...base };
    const latAvg: BucketData = { ...base };
    const latP95: BucketData = { ...base };
    const errors: BucketData = { ...base };

    for (const name of toolNames) {
      const entry = raw.tools.get(name) ?? {
        calls: 0,
        errors: 0,
        avg: 0,
        p95: 0,
      };
      calls[name] = entry.calls;
      errors[name] = entry.errors;
      latAvg[name] = Math.round(entry.avg);
      latP95[name] = Math.round(entry.p95);
    }

    callsBuckets.push(calls);
    latencyAvgBuckets.push(latAvg);
    latencyP95Buckets.push(latP95);
    errorsBuckets.push(errors);
  }

  // Colors
  const chartConfig: Record<string, { label: string; color: string }> = {};
  const toolColors = new Map<string, string>();
  topTools.forEach((tool, i) => {
    const colorNum = (i % 5) + 1;
    const colorVar = `var(--chart-${colorNum})`;
    toolColors.set(tool.toolName, colorVar);
    chartConfig[tool.toolName] = { label: tool.toolName, color: colorVar };
  });

  return {
    callsBuckets,
    latencyAvgBuckets,
    latencyP95Buckets,
    errorsBuckets,
    chartConfig,
    toolColors,
  };
}

const METRIC_LABELS: Record<TopChartMetric, string> = {
  calls: "Top Tools — Calls",
  "latency-avg": "Top Tools — Avg Latency",
  "latency-p95": "Top Tools — P95 Latency",
  errors: "Top Tools — Errors",
};

function formatTooltipValue(value: number, metric: TopChartMetric): string {
  if (metric === "latency-avg" || metric === "latency-p95") {
    return value >= 10000
      ? `${(value / 1000).toFixed(1)}s`
      : `${Math.round(value)}ms`;
  }
  return String(value);
}

interface TopToolsContentProps {
  metricsMode: TopChartMetric;
  dateRange?: { startDate: string; endDate: string };
  connectionIds?: string[];
  excludeConnectionIds?: string[];
  toolName?: string;
  status?: "success" | "error";
  isStreaming?: boolean;
  streamingRefetchInterval?: number;
}

function TopToolsContent({
  metricsMode,
  dateRange: externalDateRange,
  connectionIds,
  excludeConnectionIds,
  toolName,
  status,
  isStreaming,
  streamingRefetchInterval,
}: TopToolsContentProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const connections = useConnections() ?? [];

  const dateRange = externalDateRange;
  if (!dateRange) {
    throw new Error("TopTools requires an explicit date range");
  }

  const start = new Date(dateRange.startDate);
  const end = new Date(dateRange.endDate);
  const durationMs = end.getTime() - start.getTime();
  const interval =
    durationMs <= 60 * 60 * 1000
      ? "1m"
      : durationMs <= 25 * 60 * 60 * 1000
        ? "1h"
        : "1d";

  const { data: metricData } = useMonitoringTopTools(
    {
      interval,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      topN: 10,
      connectionIds: connectionIds?.length ? connectionIds : undefined,
      excludeConnectionIds,
      toolNames: toolName ? [toolName] : undefined,
      status,
    },
    {
      refetchInterval: isStreaming ? streamingRefetchInterval : false,
    },
  );

  const topTools = metricData?.topTools ?? [];

  const {
    callsBuckets,
    latencyAvgBuckets,
    latencyP95Buckets,
    errorsBuckets,
    chartConfig,
    toolColors,
  } = buildToolBuckets(
    topTools,
    metricData?.topToolsTimeseries ?? [],
    start,
    end,
    interval,
  );

  const buckets =
    metricsMode === "latency-avg"
      ? latencyAvgBuckets
      : metricsMode === "latency-p95"
        ? latencyP95Buckets
        : metricsMode === "errors"
          ? errorsBuckets
          : callsBuckets;

  const connectionMap = new Map(connections.map((c) => [c.id, c]));

  const handleTitleClick = () => {
    navigate({
      to: "/$org/$project/monitoring",
      params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
    });
  };

  return (
    <HomeGridCell
      title={
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">
            {METRIC_LABELS[metricsMode]}
          </p>
          <div className="flex items-center gap-3">
            {topTools.slice(0, 3).map((tool) => {
              const connection = connectionMap.get(tool.connectionId || "");
              return (
                <div key={tool.toolName} className="flex items-center gap-1">
                  <IntegrationIcon
                    icon={connection?.icon || null}
                    name={tool.toolName}
                    size="xs"
                    fallbackIcon={<Container />}
                    className="shrink-0 size-4! min-w-4! aspect-square rounded-sm"
                  />
                  <span className="text-[10px] text-foreground truncate max-w-32">
                    {tool.toolName}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      }
      onTitleClick={handleTitleClick}
    >
      {topTools.length === 0 ? (
        <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
          No tool activity in this time range
        </div>
      ) : (
        <div className="flex flex-col gap-2 w-full h-full">
          <ChartContainer
            className="flex-1 min-h-0 max-h-[140px] w-full"
            config={chartConfig}
          >
            <LineChart
              data={buckets}
              margin={{ left: 8, right: 8, top: 5, bottom: 5 }}
            >
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              <ChartTooltip
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;

                  const timeLabel =
                    payload[0] &&
                    typeof payload[0] === "object" &&
                    "payload" in payload[0]
                      ? ((payload[0] as { payload?: { label?: string } })
                          .payload?.label ?? "")
                      : "";

                  return (
                    <div className="rounded-lg border bg-background p-2 shadow-sm">
                      <div className="mb-1.5 text-xs text-muted-foreground">
                        {timeLabel}
                      </div>
                      <div className="flex flex-col gap-1">
                        {[...payload]
                          .sort((a, b) => {
                            const va =
                              typeof a.value === "number" ? a.value : 0;
                            const vb =
                              typeof b.value === "number" ? b.value : 0;
                            return vb - va;
                          })
                          .map((entry) => {
                            const dataKey = String(entry.dataKey ?? "");
                            const value =
                              typeof entry.value === "number" ? entry.value : 0;
                            const color =
                              typeof entry.color === "string"
                                ? entry.color
                                : undefined;
                            if (!value || value === 0) return null;
                            const tool = topTools.find(
                              (t) => t.toolName === dataKey,
                            );
                            const connection = connectionMap.get(
                              tool?.connectionId || "",
                            );
                            return (
                              <div
                                key={dataKey}
                                className="flex items-center gap-1.5"
                              >
                                <div
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: color }}
                                />
                                <IntegrationIcon
                                  icon={connection?.icon || null}
                                  name={dataKey}
                                  size="xs"
                                  fallbackIcon={<Container />}
                                  className="shrink-0"
                                />
                                <span className="text-xs text-muted-foreground">
                                  {dataKey}:
                                </span>
                                <span className="text-xs font-medium">
                                  {formatTooltipValue(value, metricsMode)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  );
                }}
              />
              {topTools.map((tool) => (
                <Line
                  key={tool.toolName}
                  type="monotone"
                  dataKey={tool.toolName}
                  stroke={toolColors.get(tool.toolName)}
                  strokeWidth={2}
                  animationDuration={200}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      )}
    </HomeGridCell>
  );
}

function TopToolsSkeleton() {
  return (
    <HomeGridCell
      title={
        <div className="flex flex-col gap-1.5">
          <div className="h-5 w-20 rounded bg-muted animate-pulse" />
          <div className="flex items-center gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className="size-4 aspect-square rounded-md bg-muted animate-pulse" />
                <div className="h-2.5 w-16 rounded bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-2 w-full">
        <div className="h-[140px] w-full rounded bg-muted animate-pulse" />
      </div>
    </HomeGridCell>
  );
}

export const TopTools = {
  Content: TopToolsContent,
  Skeleton: TopToolsSkeleton,
};
