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
import { useMonitoringLogs } from "./hooks";
import type { BaseMonitoringLog } from "./index";

export type TopChartMetric = "calls" | "latency" | "errors";

interface BucketData {
  t: string;
  ts: number;
  label: string;
  [key: string]: string | number;
}

/**
 * Build per-tool bucketed data for calls, latency, and errors.
 * Returns separate bucket arrays so the chart can switch between them.
 */
function buildToolBuckets(
  logs: BaseMonitoringLog[],
  start: Date,
  end: Date,
  topN: number = 10,
): {
  callsBuckets: BucketData[];
  latencyBuckets: BucketData[];
  errorsBuckets: BucketData[];
  topTools: Array<{ name: string; connectionId?: string }>;
  chartConfig: Record<string, { label: string; color: string }>;
  toolColors: Map<string, string>;
} {
  const bucketCount = 24;
  const startMs = start.getTime();
  const endMs = end.getTime();
  const bucketSizeMs = (endMs - startMs) / bucketCount;

  // Find top N tools by call count
  const toolData = new Map<string, { count: number; connectionId?: string }>();
  for (const log of logs) {
    const tool = log.toolName || "Unknown";
    const existing = toolData.get(tool);
    toolData.set(tool, {
      count: (existing?.count ?? 0) + 1,
      connectionId: existing?.connectionId || log.connectionId,
    });
  }

  const topTools = [...toolData.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([name, data]) => ({ name, connectionId: data.connectionId }));

  const toolNames = topTools.map((t) => t.name);

  // Intermediate structure to accumulate per-tool per-bucket data
  const rawBuckets: Array<{
    t: string;
    ts: number;
    label: string;
    tools: Map<string, { calls: number; errors: number; durations: number[] }>;
  }> = [];

  for (let i = 0; i < bucketCount; i++) {
    const d = new Date(startMs + i * bucketSizeMs);
    const tools = new Map<
      string,
      { calls: number; errors: number; durations: number[] }
    >();
    for (const name of toolNames) {
      tools.set(name, { calls: 0, errors: 0, durations: [] });
    }
    rawBuckets.push({
      t: d.toISOString(),
      ts: d.getTime(),
      label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      tools,
    });
  }

  // Populate
  for (const log of logs) {
    const ts = new Date(log.timestamp).getTime();
    const rawIdx = Math.floor((ts - startMs) / bucketSizeMs);
    const idx = Math.max(0, Math.min(bucketCount - 1, rawIdx));
    const bucket = rawBuckets[idx];
    if (!bucket) continue;

    const tool = log.toolName || "Unknown";
    const entry = bucket.tools.get(tool);
    if (!entry) continue;

    entry.calls += 1;
    if (log.isError) entry.errors += 1;
    if (Number.isFinite(log.durationMs)) entry.durations.push(log.durationMs);
  }

  // Build final bucket arrays
  const callsBuckets: BucketData[] = [];
  const latencyBuckets: BucketData[] = [];
  const errorsBuckets: BucketData[] = [];

  for (const raw of rawBuckets) {
    const base = { t: raw.t, ts: raw.ts, label: raw.label };
    const calls: BucketData = { ...base };
    const latency: BucketData = { ...base };
    const errors: BucketData = { ...base };

    for (const name of toolNames) {
      const entry = raw.tools.get(name)!;
      calls[name] = entry.calls;
      errors[name] = entry.errors;
      latency[name] =
        entry.durations.length > 0
          ? Math.round(
              entry.durations.reduce((a, b) => a + b, 0) /
                entry.durations.length,
            )
          : 0;
    }

    callsBuckets.push(calls);
    latencyBuckets.push(latency);
    errorsBuckets.push(errors);
  }

  // Colors
  const chartConfig: Record<string, { label: string; color: string }> = {};
  const toolColors = new Map<string, string>();
  topTools.forEach((tool, i) => {
    const colorNum = (i % 5) + 1;
    const colorVar = `var(--chart-${colorNum})`;
    toolColors.set(tool.name, colorVar);
    chartConfig[tool.name] = { label: tool.name, color: colorVar };
  });

  return {
    callsBuckets,
    latencyBuckets,
    errorsBuckets,
    topTools,
    chartConfig,
    toolColors,
  };
}

const METRIC_LABELS: Record<TopChartMetric, string> = {
  calls: "Top Tools — Calls",
  latency: "Top Tools — Latency",
  errors: "Top Tools — Errors",
};

const METRIC_UNIT_SUFFIX: Record<TopChartMetric, string> = {
  calls: "",
  latency: "ms",
  errors: "",
};

interface TopToolsContentProps {
  metricsMode: TopChartMetric;
  dateRange?: { startDate: string; endDate: string };
}

function TopToolsContent({
  metricsMode,
  dateRange: externalDateRange,
}: TopToolsContentProps) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const connections = useConnections() ?? [];

  const { data: logsData, dateRange } = useMonitoringLogs(externalDateRange);

  const logs = logsData?.logs ?? [];
  const start = new Date(dateRange.startDate);
  const end = new Date(dateRange.endDate);

  const {
    callsBuckets,
    latencyBuckets,
    errorsBuckets,
    topTools,
    chartConfig,
    toolColors,
  } = buildToolBuckets(logs, start, end, 10);

  const buckets =
    metricsMode === "latency"
      ? latencyBuckets
      : metricsMode === "errors"
        ? errorsBuckets
        : callsBuckets;

  const unitSuffix = METRIC_UNIT_SUFFIX[metricsMode];

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
                <div key={tool.name} className="flex items-center gap-1">
                  <IntegrationIcon
                    icon={connection?.icon || null}
                    name={tool.name}
                    size="xs"
                    fallbackIcon={<Container />}
                    className="shrink-0 size-4! min-w-4! aspect-square rounded-sm"
                  />
                  <span className="text-[10px] text-foreground truncate max-w-32">
                    {tool.name}
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
                              (t) => t.name === dataKey,
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
                                <span className="text-xs font-medium">
                                  {dataKey}:
                                </span>
                                <span className="text-xs font-bold">
                                  {value}
                                  {unitSuffix}
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
                  key={tool.name}
                  type="monotone"
                  dataKey={tool.name}
                  stroke={toolColors.get(tool.name)}
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
      <div className="flex flex-col gap-2 w-full h-full">
        <div className="flex-1 min-h-0 max-h-[140px] w-full rounded bg-muted animate-pulse" />
      </div>
    </HomeGridCell>
  );
}

export const TopTools = {
  Content: TopToolsContent,
  Skeleton: TopToolsSkeleton,
};
