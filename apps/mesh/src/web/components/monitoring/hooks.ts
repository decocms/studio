import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { MonitoringLogsWithVirtualMCPResponse } from ".";

interface MonitoringQueryOptions {
  enabled?: boolean;
  refetchInterval?: number | false;
}

interface MonitoringMetricFilters extends Record<string, unknown> {
  connectionIds?: string[];
  excludeConnectionIds?: string[];
  toolNames?: string[];
  status?: "success" | "error";
}

interface MonitoringStatsParams extends MonitoringMetricFilters {
  interval: "1m" | "1h" | "1d";
  startDate: string;
  endDate: string;
}

interface MonitoringTopToolsParams extends MonitoringMetricFilters {
  interval: "1m" | "1h" | "1d";
  startDate: string;
  endDate: string;
  topN?: number;
}

function getLast24HoursDateRange() {
  // Round to the nearest 5 minutes to avoid infinite re-suspending
  // (otherwise millisecond changes in Date cause new query keys each render)
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  const roundedNow = Math.floor(now / fiveMinutes) * fiveMinutes;
  const endDate = new Date(roundedNow);
  const startDate = new Date(roundedNow - 24 * 60 * 60 * 1000);
  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

export function useMonitoringLogs(externalDateRange?: {
  startDate: string;
  endDate: string;
}) {
  const dateRange = externalDateRange ?? getLast24HoursDateRange();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const query = useMCPToolCall<MonitoringLogsWithVirtualMCPResponse>({
    client,
    toolName: "MONITORING_LOGS_LIST",
    toolArguments: { ...dateRange, limit: 200, offset: 0 },
    staleTime: 30_000,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as MonitoringLogsWithVirtualMCPResponse,
  });

  return {
    ...query,
    dateRange,
  };
}

export function useMonitoringStats(
  params: MonitoringStatsParams,
  queryOptions?: MonitoringQueryOptions,
) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMCPToolCall<{
    totalCalls: number;
    totalErrors: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    connectionBreakdown: Array<{
      connectionId: string;
      calls: number;
      errors: number;
      errorRate: number;
      avgDurationMs: number;
    }>;
    timeseries: Array<{
      timestamp: string;
      calls: number;
      errors: number;
      errorRate: number;
      avg: number;
      p50: number;
      p95: number;
    }>;
  }>({
    client,
    toolName: "MONITORING_STATS",
    toolArguments: params,
    staleTime: 30_000,
    ...queryOptions,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as any,
  });
}

export function useMonitoringTopTools(
  params: MonitoringTopToolsParams,
  queryOptions?: MonitoringQueryOptions,
) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMCPToolCall<{
    topTools: Array<{
      toolName: string;
      connectionId: string | null;
      calls: number;
    }>;
    timeseries: Array<{
      timestamp: string;
      calls: number;
      errors: number;
      errorRate: number;
      avg: number;
      p50: number;
      p95: number;
    }>;
    topToolsTimeseries: Array<{
      timestamp: string;
      toolName: string;
      calls: number;
      errors: number;
      avg: number;
      p95: number;
    }>;
  }>({
    client,
    toolName: "MONITORING_STATS",
    toolArguments: params,
    staleTime: 30_000,
    ...queryOptions,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as any,
  });
}
