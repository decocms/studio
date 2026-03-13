import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
} from "@decocms/mesh-sdk";

/** Connection ID used for all LLM calls emitted by Decopilot. Must match server-side DECOPILOT_CONNECTION_ID. */
const DECOPILOT_CONNECTION_ID = "decopilot";

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
  topN: number;
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

interface MonitoringLlmStatsParams {
  interval: "1m" | "1h" | "1d";
  startDate: string;
  endDate: string;
}

/**
 * Fetch aggregated stats for LLM calls made by Decopilot.
 *
 * Queries the same MONITORING_STATS tool but scoped to connection_id = "decopilot",
 * where each LLM completion is logged as a single entry. The `toolName` field
 * in each log record holds the model ID (e.g. "claude-3-7-sonnet-20250219").
 */
export function useMonitoringLlmStats(
  params: MonitoringLlmStatsParams,
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
  }>({
    client,
    toolName: "MONITORING_STATS",
    toolArguments: {
      ...params,
      connectionIds: [DECOPILOT_CONNECTION_ID],
      topN: 5,
    },
    staleTime: 30_000,
    ...queryOptions,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as any,
  });
}
