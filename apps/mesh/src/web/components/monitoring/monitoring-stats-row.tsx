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
// Bucket Logic
// ============================================================================

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

/**
 * Format a date label based on the time range duration.
 * - <= 25 hours: show time (14:00) - includes 24h with buffer
 * - > 25 hours: show date (Dec 15)
 */
function formatBucketLabel(date: Date, rangeDurationMs: number) {
  const HOURS_25 = 25 * 60 * 60 * 1000;

  if (rangeDurationMs <= HOURS_25) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Calculate the appropriate number of buckets based on the time range.
 * - <= 1 hour: 1 bucket per minute (max 60)
 * - <= 25 hours: 1 bucket per hour (max 25) - includes 24h with buffer
 * - > 25 hours: 1 bucket per day (max 31)
 */
function calculateBucketCount(startMs: number, endMs: number): number {
  const ONE_MINUTE = 60 * 1000;
  const ONE_HOUR = 60 * ONE_MINUTE;
  // Use 25h threshold to ensure 24h ranges use hourly buckets
  const HOURS_25 = 25 * ONE_HOUR;
  const ONE_DAY = 24 * ONE_HOUR;
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
    const t = d.toISOString();
    buckets.push({
      t,
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

export interface MonitoringStatsData {
  totalCalls: number;
  totalErrors: number;
  avgDurationMs: number;
  p95DurationMs: number;
  data: BucketPoint[];
}

export function calculateStats(
  logs: MonitoringLog[],
  dateRange: DateRange,
  bucketCount?: number,
  /** Override total calls count (use when logs are truncated by limit) */
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
// Main Component
// ============================================================================

export type KPIType = "calls" | "errors" | "p95";

export interface MonitoringStatsRowProps {
  stats: MonitoringStatsData;
  /** Chart height class, e.g., "h-[40px]" or "h-[103px]" */
  chartHeight?: string;
  /** Whether to show date range labels below charts */
  showDateLabels?: boolean;
  /** Date range for labels */
  dateRange?: DateRange;
  /** Whether this is a compact view (monitoring page) */
  compact?: boolean;
  /** Optional click handler for KPI cards */
  onKPIClick?: (kpiType: KPIType) => void;
}

const KPI_CONFIG = [
  {
    label: "Tool Calls",
    dataKey: "calls",
    colorNum: 1,
    getValue: (s: MonitoringStatsData) => s.totalCalls.toLocaleString(),
  },
  {
    label: "Errors",
    dataKey: "errors",
    colorNum: 3,
    getValue: (s: MonitoringStatsData) => s.totalErrors.toLocaleString(),
  },
  {
    label: "Latency",
    dataKey: "p95",
    colorNum: 4,
    getValue: (s: MonitoringStatsData) => `${Math.round(s.avgDurationMs)}ms`,
  },
] as const;

export function MonitoringStatsRow({
  stats,
  chartHeight = "h-[40px]",
  showDateLabels = false,
  dateRange,
  compact = false,
  onKPIClick,
}: MonitoringStatsRowProps) {
  const formatDate = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const titleClass = compact
    ? "flex flex-col gap-0.5 md:gap-1"
    : "flex flex-col gap-1";
  const labelClass = compact
    ? "text-xs md:text-sm text-muted-foreground"
    : "text-sm text-muted-foreground";
  const valueClass = compact
    ? "text-sm md:text-lg font-medium"
    : "text-lg font-medium";

  const dateLabels = showDateLabels && dateRange && (
    <div className="flex items-start justify-between text-xs text-muted-foreground w-full">
      <p>{formatDate(dateRange.startDate)}</p>
      <p>{formatDate(dateRange.endDate)}</p>
    </div>
  );

  const isClickable = !!onKPIClick;

  return (
    <div className="grid grid-cols-3 gap-[0.5px] bg-border flex-shrink-0">
      {KPI_CONFIG.map(({ label, dataKey, colorNum, getValue }) => (
        <HomeGridCell
          key={dataKey}
          title={
            <div className={titleClass}>
              <p className={labelClass}>{label}</p>
              <p className={valueClass}>{getValue(stats)}</p>
            </div>
          }
        >
          <div
            className={cn(
              "flex flex-col gap-2 w-full",
              isClickable &&
                "cursor-pointer hover:opacity-80 transition-opacity",
            )}
            onClick={onKPIClick ? () => onKPIClick(dataKey) : undefined}
          >
            <KPIChart
              data={stats.data}
              dataKey={dataKey}
              colorNum={colorNum}
              chartHeight={chartHeight}
            />
            {dateLabels}
          </div>
        </HomeGridCell>
      ))}
    </div>
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
