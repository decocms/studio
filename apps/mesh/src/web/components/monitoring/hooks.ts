import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { MonitoringLogsWithVirtualMCPResponse } from ".";

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
    toolArguments: { ...dateRange, limit: 2000, offset: 0 },
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
