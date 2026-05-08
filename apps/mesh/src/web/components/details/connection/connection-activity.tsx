import {
  calculateStats,
  type BucketPoint,
  type MonitoringLogsResponse as BaseMonitoringLogsResponse,
} from "@/web/components/monitoring/monitoring-stats-row.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@deco/ui/components/chart.tsx";
import { KEYS } from "@/web/lib/query-keys.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Bar, BarChart, Cell } from "recharts";

type Timeframe = "7d" | "14d" | "30d";

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "14d", label: "14d" },
  { value: "30d", label: "30d" },
];

function getDateRange(timeframe: Timeframe): {
  startDate: Date;
  endDate: Date;
} {
  const end = new Date();
  const start = new Date(end);
  if (timeframe === "7d") start.setDate(start.getDate() - 7);
  else if (timeframe === "14d") start.setDate(start.getDate() - 14);
  else start.setDate(start.getDate() - 30);
  return { startDate: start, endDate: end };
}

const CHART_CONFIG = {
  calls: { label: "Tool calls" },
  errors: { label: "Errors" },
};

interface ActivityChartProps {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  timeframe: Timeframe;
}

function ActivityChart({
  connectionId,
  orgId,
  orgSlug,
  timeframe,
}: ActivityChartProps) {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const dateRange = getDateRange(timeframe);

  const { data } = useSuspenseQuery({
    queryKey: KEYS.connectionActivity(connectionId, timeframe, orgId),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "MONITORING_LOGS_LIST",
        arguments: {
          startDate: dateRange.startDate.toISOString(),
          endDate: dateRange.endDate.toISOString(),
          connectionId,
          limit: 2000,
          offset: 0,
        },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as BaseMonitoringLogsResponse;
    },
    staleTime: 5 * 60 * 1000,
  });

  const stats = calculateStats(data?.logs ?? [], dateRange);
  const chartData = stats.data;
  const hasData = stats.totalCalls > 0;

  return (
    <div>
      {/* Summary numbers */}
      <div className="flex gap-6 px-5 pb-4">
        <div>
          <p className="text-2xl font-semibold text-foreground tabular-nums">
            {stats.totalCalls.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Tool calls</p>
        </div>
        {stats.totalErrors > 0 && (
          <div>
            <p className="text-2xl font-semibold text-destructive tabular-nums">
              {stats.totalErrors.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Errors</p>
          </div>
        )}
        {stats.avgDurationMs > 0 && (
          <div>
            <p className="text-2xl font-semibold text-foreground tabular-nums">
              {Math.round(stats.avgDurationMs)}ms
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Avg latency</p>
          </div>
        )}
      </div>

      {hasData ? (
        <div>
          <ChartContainer config={CHART_CONFIG} className="h-16 w-full">
            <BarChart data={chartData} barCategoryGap="4%">
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const first = Array.isArray(payload)
                        ? payload[0]
                        : undefined;
                      return first &&
                        typeof first === "object" &&
                        "payload" in first
                        ? ((first as { payload?: { label?: string } }).payload
                            ?.label ?? "")
                        : "";
                    }}
                  />
                }
                cursor={{ fill: "var(--muted)" }}
              />
              <Bar dataKey="calls" radius={[2, 2, 0, 0]} minPointSize={1}>
                {chartData.map((entry: BucketPoint, index: number) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={
                      entry.errorRate > 50
                        ? "var(--destructive)"
                        : "var(--chart-1)"
                    }
                    fillOpacity={
                      entry.calls === 0
                        ? 0.2
                        : entry.errorRate > 50
                          ? 0.7
                          : 0.85
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          <div className="flex justify-between px-3 mt-1 pb-3">
            <span className="text-[10px] text-muted-foreground">
              {chartData[0]?.label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {chartData[chartData.length - 1]?.label}
            </span>
          </div>
        </div>
      ) : (
        <div className="h-20 flex items-center justify-center">
          <p className="text-sm text-muted-foreground/60">
            No activity in this period
          </p>
        </div>
      )}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div>
      <div className="flex gap-6 px-5 pb-4">
        <div className="flex flex-col gap-1.5">
          <div className="h-7 w-16 rounded-md bg-muted animate-pulse" />
          <div className="h-3 w-14 rounded bg-muted animate-pulse" />
        </div>
      </div>
      <div className="h-20 w-full rounded-md bg-muted animate-pulse" />
    </div>
  );
}

interface ConnectionActivityProps {
  connectionId: string;
}

export function ConnectionActivity({ connectionId }: ConnectionActivityProps) {
  const [timeframe, setTimeframe] = useState<Timeframe>("14d");
  const { org } = useProjectContext();

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Activity</h3>
        </div>
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => setTimeframe(tf.value)}
              className={cn(
                "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                timeframe === tf.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      <Suspense fallback={<ActivitySkeleton />}>
        <ActivityChart
          connectionId={connectionId}
          orgId={org.id}
          orgSlug={org.slug}
          timeframe={timeframe}
        />
      </Suspense>
    </div>
  );
}
