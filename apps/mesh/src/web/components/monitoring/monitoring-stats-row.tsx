/**
 * Shared Monitoring Stats Row Component
 *
 * Displays Tool Calls, Errors, and Latency KPIs with charts.
 * Used by both the Monitoring page and the Home page.
 */

import { ChartContainer, ChartTooltip } from "@deco/ui/components/chart.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from "recharts";

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
// Bucket Logic
// ============================================================================

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const HOURS_25 = 25 * ONE_HOUR;

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

function formatBucketLabel(date: Date, rangeDurationMs: number) {
  if (rangeDurationMs <= HOURS_25) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function calculateBucketCount(startMs: number, endMs: number): number {
  const totalRange = endMs - startMs;
  if (totalRange <= ONE_HOUR) {
    return Math.max(1, Math.min(60, Math.ceil(totalRange / ONE_MINUTE)));
  } else if (totalRange <= HOURS_25) {
    return Math.max(1, Math.min(25, Math.ceil(totalRange / ONE_HOUR)));
  } else {
    return Math.max(1, Math.min(31, Math.ceil(totalRange / ONE_DAY)));
  }
}

function buildBuckets(
  logs: MonitoringLog[],
  start: Date,
  end: Date,
  overrideBucketCount?: number,
): BucketPoint[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const totalRange = Math.max(1, endMs - startMs);
  const bucketCount =
    overrideBucketCount ?? calculateBucketCount(startMs, endMs);
  const bucketSizeMs = Math.max(1, Math.floor(totalRange / bucketCount));
  const buckets: Array<{
    t: string;
    ts: number;
    label: string;
    calls: number;
    errors: number;
    durations: number[];
  }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const d = new Date(startMs + i * bucketSizeMs);
    buckets.push({
      t: d.toISOString(),
      ts: d.getTime(),
      label: formatBucketLabel(d, totalRange),
      calls: 0,
      errors: 0,
      durations: [],
    });
  }
  for (const log of logs) {
    const ts = new Date(log.timestamp).getTime();
    const rawIdx = Math.floor((ts - startMs) / bucketSizeMs);
    const idx = Math.max(0, Math.min(bucketCount - 1, rawIdx));
    const bucket = buckets[idx];
    if (!bucket) continue;
    bucket.calls += 1;
    if (log.isError) bucket.errors += 1;
    if (Number.isFinite(log.durationMs)) bucket.durations.push(log.durationMs);
  }
  return buckets.map((b) => ({
    t: b.t,
    ts: b.ts,
    label: b.label,
    calls: b.calls,
    errors: b.errors,
    errorRate: b.calls > 0 ? (b.errors / b.calls) * 100 : 0,
    avg: Math.round(
      b.durations.length > 0
        ? b.durations.reduce((a, c) => a + c, 0) / b.durations.length
        : 0,
    ),
    p50: Math.round(percentile(b.durations, 0.5)),
    p95: Math.round(percentile(b.durations, 0.95)),
  }));
}

// ============================================================================
// Stats Calculation
// ============================================================================

export function calculateStats(
  logs: MonitoringLog[],
  dateRange: DateRange,
  bucketCount?: number,
  overrideTotalCalls?: number,
): MonitoringStatsData {
  const totalCalls = overrideTotalCalls ?? logs.length;
  const totalErrors = logs.filter((log) => log.isError).length;
  const durations = logs.map((log) => log.durationMs);
  const avgDurationMs =
    durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;
  const p95DurationMs = percentile(durations, 0.95);
  const data = buildBuckets(
    logs,
    dateRange.startDate,
    dateRange.endDate,
    bucketCount,
  );
  return { totalCalls, totalErrors, avgDurationMs, p95DurationMs, data };
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
  variant?: "bar" | "area";
}

function formatYAxisValue(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function KPITooltipContent({
  active,
  payload,
  dataKey,
  colorVar,
}: {
  active?: boolean;
  // biome-ignore lint: recharts payload is loosely typed
  payload?: any[];
  dataKey: string;
  colorVar: string;
}) {
  if (!active || !payload?.length) return null;
  const first = payload[0];
  const t: string = first?.payload?.t ?? "";
  const label = t
    ? new Date(t).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : (first?.payload?.label ?? "");
  const rawValue = first?.value;
  const value = typeof rawValue === "number" ? rawValue : 0;
  const isLatency = dataKey === "avg" || dataKey === "p50" || dataKey === "p95";
  const formatted = isLatency
    ? value >= 10000
      ? `${(value / 1000).toFixed(1)}s`
      : `${Math.round(value)}ms`
    : value.toLocaleString();

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <div className="text-[11px] text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <div
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: colorVar }}
        />
        <span className="text-xs font-medium tabular-nums">{formatted}</span>
      </div>
    </div>
  );
}

export function KPIChart({
  data,
  dataKey,
  colorNum,
  chartHeight,
  variant = "bar",
}: KPIChartProps) {
  const colorVar = `var(--chart-${colorNum})`;
  const gradientId = `kpi-gradient-${dataKey}-${colorNum}`;

  const maxVal = Math.max(...data.map((d) => d[dataKey]), 0);
  const tickCount = 5;

  if (variant === "area") {
    return (
      <ChartContainer
        className={cn(chartHeight, "w-full")}
        config={{ [dataKey]: { label: dataKey, color: colorVar } }}
      >
        <AreaChart
          data={data}
          margin={{ left: 0, right: -12, top: 8, bottom: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorVar} stopOpacity={0.2} />
              <stop offset="100%" stopColor={colorVar} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="4 4"
            stroke="var(--border)"
            strokeOpacity={0.5}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{
              fontSize: 11,
              fill: "var(--muted-foreground)",
              opacity: 0.7,
            }}
            interval="preserveStartEnd"
            tickMargin={8}
          />
          <YAxis
            orientation="right"
            axisLine={false}
            tickLine={false}
            tick={{
              fontSize: 11,
              fill: "var(--muted-foreground)",
              opacity: 0.7,
            }}
            tickFormatter={formatYAxisValue}
            width={40}
            domain={[0, maxVal > 0 ? "auto" : 10]}
            tickCount={tickCount}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
            content={({ active, payload }) => (
              <KPITooltipContent
                active={active}
                payload={payload}
                dataKey={dataKey}
                colorVar={colorVar}
              />
            )}
          />
          <Area
            type="linear"
            dataKey={dataKey}
            stroke={colorVar}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            animationDuration={300}
            dot={false}
            activeDot={{
              r: 4,
              fill: colorVar,
              stroke: "var(--background)",
              strokeWidth: 2,
            }}
          />
        </AreaChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer
      className={cn(chartHeight, "w-full")}
      config={{ [dataKey]: { label: dataKey, color: colorVar } }}
    >
      <BarChart data={data} margin={{ left: 0, right: -12, top: 8, bottom: 0 }}>
        <CartesianGrid
          strokeDasharray="4 4"
          stroke="var(--border)"
          strokeOpacity={0.5}
          vertical={false}
        />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 11,
            fill: "var(--muted-foreground)",
            opacity: 0.7,
          }}
          interval={data.length <= 6 ? 0 : Math.floor(data.length / 6)}
          tickMargin={8}
        />
        <YAxis
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 11,
            fill: "var(--muted-foreground)",
            opacity: 0.7,
          }}
          tickFormatter={formatYAxisValue}
          width={40}
          domain={[0, maxVal > 0 ? "auto" : 10]}
          tickCount={tickCount}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.3 }}
          content={({ active, payload }) => (
            <KPITooltipContent
              active={active}
              payload={payload}
              dataKey={dataKey}
              colorVar={colorVar}
            />
          )}
        />
        <Bar dataKey={dataKey} fill={colorVar} radius={0} minPointSize={1}>
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry[dataKey] === 0 ? "var(--muted-foreground)" : colorVar}
              fillOpacity={entry[dataKey] === 0 ? 0.15 : 0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
