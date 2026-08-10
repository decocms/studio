import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

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
  interval: string;
  startDate: string;
  endDate: string;
}

async function callMonitoringTool<TData>(
  studio: ReturnType<typeof useStudioTools>,
  toolArguments: Record<string, unknown>,
): Promise<TData> {
  return (await studio.call("MONITORING_STATS", toolArguments)) as TData;
}

interface MonitoringStatsResult {
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
}

export function useMonitoringStats(
  params: MonitoringStatsParams,
  queryOptions?: MonitoringQueryOptions,
) {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const toolArguments = {
    ...params,
    excludeConnectionIds: [
      DECOPILOT_CONNECTION_ID,
      ...(params.excludeConnectionIds ?? []),
    ],
  };

  return useQuery<MonitoringStatsResult, Error>({
    queryKey: KEYS.monitoringStatsToolCalls(
      org.id,
      JSON.stringify(toolArguments),
    ),
    queryFn: () =>
      callMonitoringTool<MonitoringStatsResult>(studio, toolArguments),
    staleTime: 30_000,
    retry: false,
    ...queryOptions,
  });
}

interface MonitoringLlmStatsParams {
  interval: string;
  startDate: string;
  endDate: string;
  /** Restrict AI usage to specific members (user IDs). */
  userIds?: string[];
}

interface MonitoringLlmStatsResult extends MonitoringStatsResult {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  topTools: Array<{
    toolName: string;
    connectionId: string | null;
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  }>;
  timeseries: Array<
    MonitoringStatsResult["timeseries"][number] & {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    }
  >;
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
  const studio = useStudioTools();

  const toolArguments = {
    ...params,
    connectionIds: [DECOPILOT_CONNECTION_ID],
    topN: 5,
    llmUsage: true,
    userIds: params.userIds?.length ? params.userIds : undefined,
  };

  return useQuery<MonitoringLlmStatsResult, Error>({
    queryKey: KEYS.monitoringStatsLlm(org.id, JSON.stringify(toolArguments)),
    queryFn: () =>
      callMonitoringTool<MonitoringLlmStatsResult>(studio, toolArguments),
    staleTime: 30_000,
    retry: false,
    ...queryOptions,
  });
}

interface MonitoringHeatmapParams {
  startDate: string;
  endDate: string;
  virtualMcpIds?: string[];
}

interface MonitoringHeatmapResult {
  cells: Array<{
    virtualMcpId: string | null;
    toolName: string;
    calls: number;
    errors: number;
    /** Sum of tool-output byte length — a proxy for context weight, not LLM token count. */
    outputSize: number;
  }>;
}

/** Tool-call volume per (agent, tool) pair, for the Overview heatmap card. */
export function useMonitoringHeatmap(
  params: MonitoringHeatmapParams,
  queryOptions?: MonitoringQueryOptions,
) {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const toolArguments = {
    ...params,
    virtualMcpIds: params.virtualMcpIds?.length
      ? params.virtualMcpIds
      : undefined,
  };

  return useQuery<MonitoringHeatmapResult, Error>({
    queryKey: KEYS.monitoringHeatmap(org.id, JSON.stringify(toolArguments)),
    queryFn: async () =>
      (await studio.call(
        "MONITORING_HEATMAP",
        toolArguments,
      )) as MonitoringHeatmapResult,
    staleTime: 30_000,
    retry: false,
    ...queryOptions,
  });
}
