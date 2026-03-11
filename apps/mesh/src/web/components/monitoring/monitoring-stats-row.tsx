/**
 * Shared Monitoring Stats Row Component
 *
 * Displays Tool Calls, Errors, and Latency KPIs with charts.
 * Used by both the Monitoring page and the Home page.
 */

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@deco/ui/components/chart.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Bar, BarChart, Cell } from "recharts";
import { HomeGridCell } from "@/web/routes/orgs/home/home-grid-cell.tsx";

// ============================================================================
// Types
// ============================================================================

export interface MonitoringLog {
  id: string;
  connectionId: string;
  connectionTitle: string;
  toolName: string;
  isError: boolean;
  errorMessage: string | null;
  durationMs: number;
  timestamp: string;
}

export interface BucketPoint {
  t: string;
  ts: number;
  label: string;
  calls: number;
  errors: number;
  errorRate: number;
  avg: number;
  p50: number;
  p95: number;
}

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface MonitoringLogsResponse {
  logs: MonitoringLog[];
  total: number;
}

// ============================================================================
// Stats Data
// ============================================================================

export interface MonitoringStatsData {
  totalCalls: number;
  totalErrors: number;
  avgDurationMs: number;
  p95DurationMs: number;
  data: BucketPoint[];
}

// ============================================================================
// Chart Components
// ============================================================================

export interface KPIChartProps {
  data: BucketPoint[];
  dataKey: "calls" | "errors" | "avg" | "p50" | "p95";
  colorNum: number;
  chartHeight: string;
}

export function KPIChart({
  data,
  dataKey,
  colorNum,
  chartHeight,
}: KPIChartProps) {
  const colorVar = `var(--chart-${colorNum})`;

  return (
    <ChartContainer
      className={cn(chartHeight, "w-full")}
      config={{ [dataKey]: { label: dataKey, color: colorVar } }}
    >
      <BarChart data={data} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => {
                const first = Array.isArray(payload) ? payload[0] : undefined;
                return first && typeof first === "object" && "payload" in first
                  ? ((first as any).payload?.label ?? "")
                  : "";
              }}
            />
          }
        />
        <Bar
          dataKey={dataKey}
          fill={colorVar}
          radius={[0, 0, 0, 0]}
          minPointSize={1}
        >
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry[dataKey] === 0 ? "var(--muted-foreground)" : colorVar}
              fillOpacity={entry[dataKey] === 0 ? 0.25 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

export function MonitoringStatsRowSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-[0.5px] bg-border flex-shrink-0">
      {[...Array(3)].map((_, i) => (
        <HomeGridCell
          key={i}
          title={
            <div className="flex flex-col gap-0.5 md:gap-1">
              <div className="h-4 w-16 rounded bg-muted animate-pulse" />
              <div className="h-5 md:h-6 w-12 rounded bg-muted animate-pulse" />
            </div>
          }
        >
          <div className="flex flex-col w-full">
            <div className="h-[30px] md:h-[40px] w-full rounded bg-muted animate-pulse" />
            <div className="space-y-1.5 mt-2">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex items-center gap-1.5">
                  <div className="size-4 rounded-sm bg-muted animate-pulse shrink-0" />
                  <div className="h-2.5 w-20 rounded bg-muted animate-pulse" />
                  <div className="h-1.5 flex-1 bg-muted animate-pulse" />
                  <div className="h-2.5 w-8 rounded bg-muted animate-pulse shrink-0" />
                </div>
              ))}
            </div>
          </div>
        </HomeGridCell>
      ))}
    </div>
  );
}
